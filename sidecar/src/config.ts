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
    /**
     * IANA zone name that rendered transcripts are stamped in, e.g.
     * "America/New_York". Defaults to this machine's zone.
     *
     * Discord hands us UTC instants and the old renderer sliced the clock
     * straight out of the ISO string, which published UTC as a bare `[14:31:02]`
     * with nothing marking it as such. Every reader downstream — human or model —
     * reads a bare clock time as local and is wrong by the offset. A transcript
     * exists to be cross-referenced against the Discord client sitting next to
     * it, so local is the useful default, and the zone is named in the header
     * either way.
     */
    timezone: string;
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

/**
 * Reads the config file, if there is one.
 *
 * `null` means nothing usable came out of the file, and the caller should not
 * second-guess why — each failure path here has already said its piece. Only one
 * of them is quiet: no file at all, which is the ordinary first run, where
 * `ensureConfigFile()` is about to write one and log that it did.
 *
 * The rest are loud on purpose. A config that exists but can't be read is
 * indistinguishable from no config at all from in here, and the symptom
 * downstream is the bridge listening on DEFAULT_PORT while the plugin dials the
 * port you actually set. Nothing connects, and nothing anywhere says why.
 *
 * One read rather than `existsSync()` then `readFileSync()` — those two can
 * disagree, and the disagreement used to land in the silent branch.
 */
function readConfigFile(): Partial<Config> | null {
    const file = CONFIG_FILE();

    let raw: string;
    try {
        raw = readFileSync(file, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        log.warn(`could not read ${file} — falling back to defaults:`, err);
        return null;
    }

    // Strip a UTF-8 BOM. Notepad and PowerShell both write one by default on
    // Windows, it is invisible in every editor, and JSON.parse rejects the whole
    // file over it — which lands you right back in the silent-default case this
    // function exists to make noisy. Tested by code point rather than matched as
    // a literal, so the guard itself isn't an invisible character in the source.
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

    try {
        return JSON.parse(raw) as Partial<Config>;
    } catch (err) {
        log.warn(`${file} is not valid JSON — falling back to defaults:`, err);
        return null;
    }
}

/**
 * Resolves and validates the rendering timezone.
 *
 * A typo here would otherwise surface as times that are quietly wrong rather
 * than as an error, so an unknown zone is named out loud and falls back to UTC —
 * being obviously in UTC beats being invisibly off by hours.
 */
function resolveTimezone(requested: string | undefined): string {
    const zone = requested?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    try {
        new Intl.DateTimeFormat("en", { timeZone: zone });
        return zone;
    } catch {
        log.warn(`"${zone}" is not a known IANA timezone — stamping transcripts in UTC instead`);
        return "UTC";
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
    const fromFile = readConfigFile();
    const file = fromFile ?? {};

    const envPort = envInt("VCB_PORT");
    const port = envPort ?? file.port ?? DEFAULT_PORT;

    /*
     * Always say where the port came from — including when nothing is wrong.
     *
     * A port mismatch is the one misconfiguration with no symptom of its own:
     * both halves start cleanly, the plugin dials one number, the sidecar
     * listens on another, and the only evidence is a client that never arrives.
     *
     * The case that actually bit twice was worse than that. A config that
     * exists but doesn't get read produces *no output at all*, because "no
     * config file" is also the ordinary first run and was therefore silent.
     * Reading the default port and reading a configured one looked identical
     * right up until the bind failed on a port nobody had chosen. One line at
     * startup makes those permanently distinguishable, which is worth more than
     * the line costs.
     */
    if (envPort != null) {
        const conflicts = file.port != null && envPort !== file.port;
        (conflicts ? log.warn : log.info)(
            `bridge port ${port} (VCB_PORT${conflicts ? `, overriding "port": ${file.port} in the config file` : ""})`
        );
    } else if (file.port != null) {
        log.info(`bridge port ${port} (from ${CONFIG_FILE()})`);
    } else if (fromFile != null) {
        log.warn(`bridge port ${port} (default — ${CONFIG_FILE()} has no "port")`);
    } else {
        log.info(`bridge port ${port} (default — no config file was read at ${CONFIG_FILE()})`);
    }

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
        timezone: resolveTimezone(process.env.VCB_TIMEZONE ?? file.timezone),
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
        timezone: cfg.timezone,
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
