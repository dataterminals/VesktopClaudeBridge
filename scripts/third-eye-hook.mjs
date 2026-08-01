#!/usr/bin/env node
/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * UserPromptSubmit hook: injects whatever third eye has been watching.
 *
 * This is the piece that makes pressing the button in Discord *sufficient*. MCP
 * gives a server no way to wake a model, so without this you would have to tell
 * Claude "third eye is on" once per session and hope it remembered to look. The
 * hook closes that gap from the other side: every time you send a message, this
 * runs first and quietly prepends anything new.
 *
 * Three rules, because this runs on your keystrokes:
 *
 *   - Never block. A hard 2s timeout, and any failure at all exits 0 silently.
 *     A hung curl against a dead sidecar must not stall message submission.
 *   - Say nothing when there is nothing to say. A hook that always prints gets
 *     switched off within a day.
 *   - Never print an error. A sidecar that isn't running is the normal case,
 *     not a fault worth interrupting anyone about.
 *
 * Wire it up in .claude/settings.json:
 *
 *   { "hooks": { "UserPromptSubmit": [ { "hooks": [ {
 *       "type": "command",
 *       "command": "node \"<repo>/scripts/third-eye-hook.mjs\""
 *   } ] } ] } }
 */

import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 2000;

function configDir() {
    if (process.env.VCB_CONFIG_DIR) return process.env.VCB_CONFIG_DIR;
    if (platform() === "win32") {
        return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "vesktop-claude-bridge");
    }
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "vesktop-claude-bridge");
}

function readPort() {
    try {
        const cfg = JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8"));
        return cfg.httpPort ?? (cfg.port ?? 8787) + 1;
    } catch {
        return 8788;
    }
}

try {
    const token = readFileSync(join(configDir(), "token"), "utf8").trim();
    if (!token) process.exit(0);

    // notableOnly is not a tuning preference, it is what makes this affordable.
    // Measured on a real channel: 475 messages/hour, of which ~1% were aimed at
    // the user. Injecting the whole buffer would put ~3.6k tokens on every
    // message they send and climb to ~11.7k once the ring fills — on the off
    // chance any of it mattered. The rest is still there; `discord_live` reads
    // it when they actually ask.
    const res = await fetch(`http://127.0.0.1:${readPort()}/live?notableOnly=1`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) process.exit(0);

    const body = (await res.text()).trim();
    if (!body) process.exit(0);

    process.stdout.write(
        JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext:
                    "The user has third eye mode running in Discord. New messages since you last looked:\n\n" +
                    body +
                    "\n\nMention this only if it's relevant to what they're asking — they didn't necessarily send it to you on purpose."
            }
        })
    );
} catch {
    // Sidecar down, Discord closed, nothing watching: all normal. Stay quiet.
}

process.exit(0);
