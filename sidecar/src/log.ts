/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Everything logs to stderr, always.
 *
 * When the sidecar runs as an MCP server, stdout IS the JSON-RPC transport —
 * a single stray console.log there corrupts the stream and the client drops the
 * connection with a parse error that points nowhere useful. So: no stdout.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
export type LogLevel = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: LogLevel) {
    threshold = LEVELS[level];
}

function emit(level: LogLevel, args: unknown[]) {
    if (LEVELS[level] > threshold) return;
    const stamp = new Date().toISOString().slice(11, 23);
    process.stderr.write(
        `[${stamp}] ${level.toUpperCase().padEnd(5)} ${args.map(stringify).join(" ")}\n`
    );
}

function stringify(v: unknown): string {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

export const log = {
    error: (...args: unknown[]) => emit("error", args),
    warn: (...args: unknown[]) => emit("warn", args),
    info: (...args: unknown[]) => emit("info", args),
    debug: (...args: unknown[]) => emit("debug", args)
};
