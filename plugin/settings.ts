/*
 * VesktopClaudeBridge — Equicord/Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { DEFAULT_PORT } from "./protocol";

/**
 * Where the bridge token actually lives.
 *
 * NOT in plugin settings. Vencord's cloud settings sync uploads the whole
 * settings blob to api.vencord.dev, and this user has that switched on — a
 * token parked in a settings field would ride along with it. localStorage is
 * per-install and never synced, so the secret stays on this machine.
 *
 * The settings field below is a one-way inbox: you paste into it, `start()`
 * moves the value here and blanks the field.
 */
const TOKEN_KEY = "VesktopClaudeBridge_token";

export function getToken(): string {
    try {
        return localStorage.getItem(TOKEN_KEY) ?? "";
    } catch {
        return "";
    }
}

export function setToken(token: string): void {
    try {
        localStorage.setItem(TOKEN_KEY, token);
    } catch {
        /* private mode / storage disabled — the user will see "bad token" and can retry */
    }
}

export const settings = definePluginSettings({
    tokenInbox: {
        type: OptionType.STRING,
        description:
            "Paste the sidecar token here (run `npm run token` in the sidecar). It is moved to local storage and this box is cleared — that is expected, not a bug.",
        default: "",
        placeholder: "paste token, then reload Discord"
    },
    port: {
        type: OptionType.NUMBER,
        description: "Port the sidecar's websocket listens on.",
        default: DEFAULT_PORT
    },
    autoConnect: {
        type: OptionType.BOOLEAN,
        description: "Connect to the sidecar automatically, and keep retrying if it isn't up yet.",
        default: true
    },
    grabCount: {
        type: OptionType.NUMBER,
        description: "How many recent messages the chat-bar button grabs.",
        default: 50
    },
    markContext: {
        type: OptionType.NUMBER,
        description:
            "How many surrounding messages to include when you mark a single message. 0 marks just that one.",
        default: 5
    },
    showToasts: {
        type: OptionType.BOOLEAN,
        description: "Show a toast when something is marked or when the bridge connects.",
        default: true
    }
});

/** Moves a freshly pasted token out of synced settings and into local storage. */
export function drainTokenInbox(): void {
    const pasted = settings.store.tokenInbox?.trim();
    if (!pasted) return;
    setToken(pasted);
    settings.store.tokenInbox = "";
}
