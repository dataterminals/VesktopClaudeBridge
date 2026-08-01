/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The websocket end of the bridge.
 *
 * The plugin dials in (renderers can't listen), authenticates once, and from
 * then on the traffic is inverted: we send requests, it sends responses. It
 * also pushes unsolicited `event` frames when the user marks something.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";

import type { Config } from "./config.js";
import { log } from "./log.js";
import {
    ALLOWED_ORIGINS,
    PROTOCOL_VERSION,
    isPluginFrame,
    type BridgeUser,
    type PluginFrame,
    type RpcError,
    type RpcMethod,
    type RpcParams,
    type RpcResults
} from "./protocol.js";

export class BridgeError extends Error {
    constructor(public readonly rpc: RpcError) {
        super(rpc.message);
        this.name = "BridgeError";
    }
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (err: BridgeError) => void;
    timer: NodeJS.Timeout;
    method: RpcMethod;
}

export interface BridgeStatus {
    connected: boolean;
    user: BridgeUser | null;
    pluginVersion: string | null;
    connectedSince: string | null;
    port: number;
}

/** Constant-time compare that tolerates unequal lengths. */
function secretsMatch(a: string, b: string): boolean {
    const ha = createHash("sha256").update(a).digest();
    const hb = createHash("sha256").update(b).digest();
    return timingSafeEqual(ha, hb);
}

export class BridgeServer extends EventEmitter {
    private wss: WebSocketServer | null = null;
    private socket: WebSocket | null = null;
    private pending = new Map<string, Pending>();
    private nextId = 1;

    private user: BridgeUser | null = null;
    private pluginVersion: string | null = null;
    private connectedSince: Date | null = null;

    constructor(private readonly cfg: Config, private readonly sidecarVersion: string) {
        super();
    }

    listen(): Promise<void> {
        return new Promise((resolve, reject) => {
            const wss = new WebSocketServer({
                host: "127.0.0.1",
                port: this.cfg.port,
                // Small frames only; nothing legitimate here is megabytes.
                maxPayload: 8 * 1024 * 1024,
                verifyClient: ({ origin }, done) => {
                    // Belt and braces. The token is the real gate — a hostile
                    // page can't forge Origin, but it also can't read the token,
                    // so either check alone would do. We keep both.
                    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
                        log.warn(`refused websocket from unexpected origin: ${origin}`);
                        return done(false, 403, "bad origin");
                    }
                    done(true);
                }
            });

            wss.on("listening", () => {
                log.info(`bridge listening on ws://127.0.0.1:${this.cfg.port}`);
                resolve();
            });
            wss.on("error", err => reject(err));
            wss.on("connection", socket => this.onConnection(socket));

            this.wss = wss;
        });
    }

    private onConnection(socket: WebSocket) {
        let authed = false;

        const handshakeTimer = setTimeout(() => {
            if (!authed) {
                log.warn("dropping socket that never said hello");
                socket.close(4408, "handshake timeout");
            }
        }, 5000);

        socket.on("message", raw => {
            let frame: unknown;
            try {
                frame = JSON.parse(raw.toString());
            } catch {
                log.warn("dropping socket that sent non-json");
                return socket.close(4400, "bad frame");
            }
            if (!isPluginFrame(frame)) return socket.close(4400, "bad frame");

            if (!authed) {
                if (frame.t !== "hello") return socket.close(4401, "expected hello");
                if (!secretsMatch(frame.token ?? "", this.cfg.token)) {
                    log.warn("rejected a socket with a bad token");
                    return socket.close(4403, "bad token");
                }
                if (frame.protocol !== PROTOCOL_VERSION) {
                    log.warn(
                        `protocol mismatch: plugin speaks v${frame.protocol}, sidecar speaks v${PROTOCOL_VERSION}`
                    );
                    return socket.close(4426, "protocol mismatch");
                }

                authed = true;
                clearTimeout(handshakeTimer);
                this.adopt(socket, frame.user, frame.pluginVersion);
                return;
            }

            this.onFrame(frame);
        });

        socket.on("close", (code, reason) => {
            clearTimeout(handshakeTimer);
            if (this.socket === socket) {
                log.info(`plugin disconnected (${code} ${reason.toString() || "no reason"})`);
                this.socket = null;
                this.user = null;
                this.pluginVersion = null;
                this.connectedSince = null;
                this.failAllPending({
                    code: "no_client",
                    message: "the Discord plugin disconnected mid-request"
                });
                this.emit("disconnected");
            }
        });

        socket.on("error", err => log.warn("socket error:", err));
    }

    private adopt(socket: WebSocket, user: BridgeUser | null, pluginVersion: string) {
        if (this.socket && this.socket !== socket) {
            log.info("a second plugin connected; dropping the previous one");
            this.socket.close(4409, "superseded");
        }
        this.socket = socket;
        this.user = user;
        this.pluginVersion = pluginVersion;
        this.connectedSince = new Date();

        socket.send(
            JSON.stringify({
                t: "hello-ok",
                protocol: PROTOCOL_VERSION,
                sidecarVersion: this.sidecarVersion
            })
        );

        log.info(
            `plugin v${pluginVersion} connected as ${user?.displayName ?? "unknown user"}`
        );
        this.emit("connected", user);
    }

    private onFrame(frame: PluginFrame) {
        if (frame.t === "res") {
            const entry = this.pending.get(frame.id);
            if (!entry) return log.debug(`response for unknown request ${frame.id}`);
            this.pending.delete(frame.id);
            clearTimeout(entry.timer);
            if (frame.ok) entry.resolve(frame.data);
            else entry.reject(new BridgeError(frame.error));
            return;
        }

        if (frame.t === "event") {
            log.debug(`event: ${frame.event}`);
            this.emit("plugin-event", frame.event, frame.data);
        }
    }

    private failAllPending(error: RpcError) {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new BridgeError(error));
        }
        this.pending.clear();
    }

    get connected(): boolean {
        return this.socket !== null && this.socket.readyState === 1;
    }

    status(): BridgeStatus {
        return {
            connected: this.connected,
            user: this.user,
            pluginVersion: this.pluginVersion,
            connectedSince: this.connectedSince?.toISOString() ?? null,
            port: this.cfg.port
        };
    }

    /** Sends an RPC to the plugin and waits for its answer. */
    call<M extends RpcMethod>(method: M, params: RpcParams[M]): Promise<RpcResults[M]> {
        const socket = this.socket;
        if (!socket || socket.readyState !== 1) {
            return Promise.reject(
                new BridgeError({
                    code: "no_client",
                    message:
                        "No Discord client is connected. Check that Vesktop is running and the VesktopClaudeBridge plugin is enabled."
                })
            );
        }

        const id = String(this.nextId++);

        return new Promise<RpcResults[M]>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(
                    new BridgeError({
                        code: "timeout",
                        message: `the plugin did not answer ${method} within ${this.cfg.rpcTimeoutMs}ms`
                    })
                );
            }, this.cfg.rpcTimeoutMs);

            this.pending.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject,
                timer,
                method
            });

            socket.send(JSON.stringify({ t: "req", id, method, params }));
        });
    }

    async close() {
        this.failAllPending({ code: "internal", message: "sidecar shutting down" });
        this.socket?.close(1001, "going away");
        await new Promise<void>(resolve => this.wss?.close(() => resolve()) ?? resolve());
    }
}
