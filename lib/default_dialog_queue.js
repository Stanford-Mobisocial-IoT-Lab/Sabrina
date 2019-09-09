// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Almond
//
// Copyright 2019 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const assert = require('assert');

const ruleDialog = require('./dialogs/rule');
const discoveryDialog = require('./dialogs/discovery');
const configDialog = require('./dialogs/config');
const initDialog = require('./dialogs/init');
const askAnything = require('./dialogs/ask_anything');
const permissionGrant = require('./dialogs/permission_grant');
const { showNotification, showError } = require('./dialogs/notifications');
const { handleUserInput } = require('./dialogs/default');

const Intent = require('./semantic').Intent;
const Helpers = require('./helpers');
const { AcceptResult, CancellationError, TopLevelStackFrame } = require('./dialog_stack');

class QueueItem {
    constructor() {
        this.promise = new Promise((callback, errback) => {
            this._resolve = callback;
            this._reject = errback;
        });
    }

    get platformData() {
        return {};
    }

    async dispatch(dlg) {
        const stackFrame = new TopLevelStackFrame(dlg);
        await stackFrame.onPush();

        try {
            try {
                this._resolve(await this._doDispatch(dlg, stackFrame));
            } catch(e) {
                this._reject(e);

                // if the stack was unwound due to a cancellation error,
                // reinject the message here
                //
                // this bypasses the notification queue, which means that
                // if the user types an "change of subject" command
                // in the middle of another command, the new command preempts
                // any queued notification
                // this is an acceptable behavior because the user is actively
                // interacting with the assistant
                if (e instanceof CancellationError) {
                    const userQueueItem = new QueueItem.UserInput(e.intent, true, true);
                    await userQueueItem._doDispatch(dlg, stackFrame);
                } else {
                    throw e;
                }
            }
        } finally {
            await stackFrame.onPop();
        }
    }

    /* instanbul ignore next */
    async _doDispatch() {
        throw new Error('abstract method');
    }
}
module.exports = QueueItem;

QueueItem.Initialization = class Initialization extends QueueItem {
    constructor(showWelcome) {
        super();
        this.showWelcome = showWelcome;
    }

    async _doDispatch(dlg) {
        return initDialog(dlg, this.showWelcome);
    }
};

QueueItem.UserInput = class UserInput extends QueueItem {
    constructor(intent, confident, reinjected = false) {
        super();
        this.intent = intent;
        this.confident = confident;
        this.reinjected = reinjected;
    }

    get platformData() {
        return this.intent.platformData;
    }

    async _doDispatch(dlg, stackFrame) {
        dlg.currentAppId = null;
        try {
            let intent = this.intent;
            let confident = this.confident;
            let reinjected = this.reinjected;

            for (;;) {
                const accepted = await stackFrame.accept(intent);
                assert(accepted !== AcceptResult.INCOMPATIBLE);

                try {
                    if (accepted !== AcceptResult.HANDLED)
                        await handleUserInput(dlg, intent, confident, reinjected);
                    return;
                } catch(e) {
                    if (e instanceof CancellationError) {
                        intent = e.intent;
                        confident = true;
                        reinjected = true;
                        continue;
                    }
                    // propagate other errors
                    throw e;
                }
            }
        } catch(e) {
            await dlg.reply(dlg._("Sorry, I had an error processing your command: %s").format(Helpers.formatError(e)));
            console.error(e);
        }
    }
};

QueueItem.Notification = class Notification extends QueueItem {
    constructor(appId, icon, outputType, outputValue) {
        super();
        this.appId = appId;
        this.icon = icon;
        this.outputType = outputType;
        this.outputValue = outputValue;
    }

    async _doDispatch(dlg) {
        const previousAppId = dlg.currentAppId;
        dlg.currentAppId = this.appId;
        return showNotification(dlg, this.appId, this.icon, this.outputType, this.outputValue, previousAppId);
    }
};

QueueItem.Error = class Error extends QueueItem {
    constructor(appId, icon, error) {
        super();
        this.appId = appId;
        this.icon = icon;
        this.error = error;
    }

    async _doDispatch(dlg) {
        dlg.currentAppId = this.appId;
        return showError(dlg, this.appId, this.icon, this.error);
    }
};

QueueItem.Question = class Question extends QueueItem {
    constructor(appId, icon, type, question) {
        super();
        this.appId = appId;
        this.icon = icon;
        this.type = type;
        this.question = question;
    }

    async _doDispatch(dlg) {
        dlg.currentAppId = this.appId;
        // note that we propagate all errors here
        return askAnything(dlg, this.appId, this.icon, this.type, this.question);
    }
};

QueueItem.PermissionRequest = class PermissionRequest extends QueueItem {
    constructor(principal, identity, program) {
        super();
        this.principal = principal;
        this.identity = identity;
        this.program = program;
    }

    async _doDispatch(dlg) {
        dlg.currentAppId = null;
        return permissionGrant(dlg, this.program, this.principal, this.identity);
    }
};

QueueItem.InteractiveConfigure = class InteractiveConfigure extends QueueItem {
    constructor(kind) {
        super();
        this.kind = kind;
    }

    async _doDispatch(dlg) {
        dlg.currentAppId = null;
        if (this.kind !== null)
            return configDialog(dlg, this.kind);
        else
            return discoveryDialog(dlg);
    }
};

QueueItem.RunProgram = class RunProgram extends QueueItem {
    constructor(program, uniqueId, identity) {
        super();
        this.program = program;
        this.uniqueId = uniqueId;
        this.identity = identity;
    }

    async _doDispatch(dlg) {
        dlg.currentAppId = this.uniqueId;
        return ruleDialog(dlg, new Intent.Program(this.program, this.program, {}), true, this.uniqueId, this.identity);
    }
};