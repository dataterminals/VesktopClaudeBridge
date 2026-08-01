/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_PORT } from "./protocol.js";
import { log, type LogLevel } from "./log.js";

export interface Config {
    /** Port the sidecar listens on for the plugin's websocket. Loopback only. */
    port: number;
    /** Port for the plain HTTP mirror of the tools. Defaults to `port + 1`. */
    httpPort: number;
    /** Shared secret. The plugin must present this in its `hello` frame. */
    token: string;
    /** Where `discord_fetch_attachment` writes files. */
    downloadDir: string;
    /**
     * Guild ids the bridge will serve. Empty array = all guilds.
     * Names are not accepted here on purpose: ids don't change, names do.
     */
    allowGuilds: string[];
    /** When true, DM and group-DM channels are refused outright. */
    denyDms: boolean;
    /**
     * Replace author identities with stable pseudonyms (`user_a`, `user_b`, ...)
     * on the way out of the sidecar, so real handles never reach the model's
     * context in the first place. Useful when the transcript is headed somewhere
     * public. The mapping is stable for the lifetime of the process only.
     */
    pseudonymize: boolean;
    /** Default number of messages returned when a tool doesn't specify. */
    defaultLimit: number;
    /** Hard ceiling on messages per call, regardless of what was asked for. */
    maxLimit: number;
    /** Message bodies longer than this get truncated in compact output. */
    truncateAt: number;
    /** How long to wait for the plugin to answer an RPC. */
    rpcTimeoutMs: number;
    /** Enable the plain-HTTP API alongside MCP. */
    http: boolean;
    logLevel: LogLevel;
}

export function configDir(): string {
    if (process.env.VCB_CONFIG_DIR) return process.env.VCB_CONFIG_DIR;
    if (platform() === "win32") {
        const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
        return join(appData, "vesktop-claude-bridge");
    }
    const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    return join(xdg, "vesktop-claude-bridge");
}

const CONFIG_FILE = () => join(configDir(), "config.json");
const TOKEN_FILE = () => join(configDir(), "token");

/**
 * Reads the shared secret, minting one on first run.
 *
 * This matters more than it looks: a websocket server on loopback has no
 * same-origin protection, so any web page you happen to visit can open a socket
 * to it. The token is what stops that page from reading your Discord — it can
 * connect, but it cannot authenticate, and an unauthenticated socket is dropped.
 */
export function loadToken(): string {
    if (process.env.VCB_TOKEN) return process.env.VCB_TOKEN;

    const file = TOKEN_FILE();
    if (existsSync(file)) {
        const existing = readFileSync(file, "utf8").trim();
        if (existing.length >= 16) return existing;
        log.warn("token file was too short to be trusted; regenerating");
    }

    const token = randomBytes(32).toString("base64url");
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(file, token + "\n", { encoding: "utf8", mode: 0o600 });
    if (platform() !== "win32") chmodSync(file, 0o600);
    log.info(`minted a new bridge token at ${file}`);
    return token;
}

function readConfigFile(): Partial<Config> {
    const file = CONFIG_FILE();
    if (!existsSync(file)) return {};
    try {
        return JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
    } catch (err) {
        log.warn(`ignoring unreadable ${file}:`, err);
        return {};
    }
}

function envFlag(name: string): boolean | undefined {
    const raw = process.env[name];
    if (raw == null || raw === "") return undefined;
    return raw !== "0" && raw.toLowerCase() !== "false";
}

function envInt(name: string): number | undefined {
    const raw = process.env[name];
    if (raw == null || raw === "") return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
}

export function loadConfig(): Config {
    const file = readConfigFile();

    const port = envInt("VCB_PORT") ?? file.port ?? DEFAULT_PORT;

    const cfg: Config = {
        port,
        httpPort: envInt("VCB_HTTP_PORT") ?? file.httpPort ?? port + 1,
        token: loadToken(),
        downloadDir:
            process.env.VCB_DOWNLOAD_DIR ??
            file.downloadDir ??
            join(tmpdir(), "vesktop-claude-bridge"),
        allowGuilds: file.allowGuilds ?? [],
        denyDms: envFlag("VCB_DENY_DMS") ?? file.denyDms ?? true,
        pseudonymize: envFlag("VCB_PSEUDONYMIZE") ?? file.pseudonymize ?? false,
        defaultLimit: envInt("VCB_DEFAULT_LIMIT") ?? file.defaultLimit ?? 50,
        maxLimit: envInt("VCB_MAX_LIMIT") ?? file.maxLimit ?? 200,
        truncateAt: envInt("VCB_TRUNCATE_AT") ?? file.truncateAt ?? 1200,
        rpcTimeoutMs: envInt("VCB_RPC_TIMEOUT_MS") ?? file.rpcTimeoutMs ?? 15_000,
        http: envFlag("VCB_HTTP") ?? file.http ?? true,
        logLevel: (process.env.VCB_LOG_LEVEL as LogLevel | undefined) ?? file.logLevel ?? "info"
    };

    mkdirSync(cfg.downloadDir, { recursive: true });
    return cfg;
}

/** Writes a commented starter config if the user doesn't have one yet. */
export function ensureConfigFile(cfg: Config): string {
    const file = CONFIG_FILE();
    if (existsSync(file)) return file;
    mkdirSync(configDir(), { recursive: true });
    const seed = {
        port: cfg.port,
        httpPort: cfg.httpPort,
        downloadDir: cfg.downloadDir,
        allowGuilds: [],
        denyDms: true,
        pseudonymize: false,
        defaultLimit: cfg.defaultLimit,
        maxLimit: cfg.maxLimit,
        truncateAt: cfg.truncateAt,
        http: true,
        logLevel: "info"
    };
    writeFileSync(file, JSON.stringify(seed, null, 4) + "\n", "utf8");
    log.info(`wrote a starter config to ${file}`);
    return file;
}
