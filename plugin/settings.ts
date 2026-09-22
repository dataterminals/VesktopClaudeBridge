/*
 * VesktopClaudeBridge — Equicord/Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { localStorage } from "@utils/localStorage";
import { OptionType } from "@utils/types";

import { clearSession } from "./dmLedger";
import { DmAllowList } from "./dmSettings";
import { DEFAULT_PORT } from "./protocol";

/**
 * Where the bridge token actually lives.
 *
 * NOT in plugin settings. Vencord's cloud settings sync uploads the whole
 * settings blob to the configured cloud host — a token parked in a settings
 * field would ride along with it. localStorage is per-install and never
 * synced, so the secret stays on this machine.
 *
 * The settings field below is a one-way inbox: you paste into it, `start()`
 * moves the value here and blanks the field.
 *
 * The import above is load-bearing. Discord deletes `window.localStorage` from
 * the renderer during boot, so the bare global is `undefined` by the time a
 * plugin runs — every read would throw, get swallowed by the try/catch below,
 * and the bridge would sit there reporting "no token set" forever. Vencord's
 * bundle runs before that delete happens and re-exports the captured Storage
 * object, which keeps working. Don't "simplify" this back to the global.
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
    markExpiryHours: {
        type: OptionType.NUMBER,
        description:
            "How long a mark stays in the queue. Marks older than this drop out on their own, so asking Claude to read \"what I marked\" today can't quietly hand it something from days ago. 0 keeps them forever.",
        default: 48
    },
    showToasts: {
        type: OptionType.BOOLEAN,
        description: "Show a toast when something is marked or when the bridge connects.",
        default: true
    },
    thirdEyeTerms: {
        type: OptionType.STRING,
        description:
            "Third eye: comma-separated words that count as worth surfacing even when nobody mentions you — a repo name, a mod name, a build number. Conversations about your work often never name you.",
        default: "",
        placeholder: "UnkillablesRebalance, TFWorkbench, v0.1.7"
    },
    thirdEyeIncludeBots: {
        type: OptionType.BOOLEAN,
        description:
            "Third eye: also watch bot and webhook messages. Off by default — a CI bot posting build logs is the highest-volume thing in most channels.",
        default: false
    },
    thirdEyeWatchDms: {
        type: OptionType.BOOLEAN,
        description:
            "Third eye: allow watching DMs. Off by default — \"read my Discord\" shouldn't quietly mean all of it. The sidecar keeps its own switch: set \"denyDms\": false in its config too, or the buffer fills and then the drain is refused at the boundary.",
        default: false
    },
    dmAccess: {
        type: OptionType.SELECT,
        description:
            "What happens when something asks to read one of your DMs. This gate lives in Discord, so it refuses before anything leaves the client at all — unlike the sidecar's denyDms, which refuses content that has already crossed over. The Claude bridge button on the chat bar flips this between Ask and Always allow too: \"Let Claude read DMs without asking\" in its menu is this same setting.",
        options: [
            {
                label: "Ask me each time (recommended)",
                value: "ask",
                default: true
            },
            {
                label: "Always allow — no prompt, every DM readable",
                value: "allow"
            },
            {
                label: "Off — refuse every DM, ignoring anything allowed below",
                value: "off"
            }
        ],
        // Grants are consent given under one set of rules, and the rules just
        // moved. Flipping to Off and back to Ask must not silently restore an
        // hour of access agreed to beforehand.
        onChange: () => clearSession()
    },
    dmGrantMinutes: {
        type: OptionType.NUMBER,
        description:
            "How long the Allow button on that prompt lasts, in minutes. Grants are held in memory only, so reloading Discord revokes every one of them regardless.",
        default: 60
    },
    dmAllowList: {
        type: OptionType.COMPONENT,
        component: DmAllowList
    }
});

/** Moves a freshly pasted token out of synced settings and into local storage. */
export function drainTokenInbox(): void {
    const pasted = settings.store.tokenInbox?.trim();
    if (!pasted) return;
    setToken(pasted);
    settings.store.tokenInbox = "";
}
