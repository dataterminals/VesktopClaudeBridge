/*
 * VesktopClaudeBridge — Equicord/Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The renderer end of the bridge.
 *
 * The plugin dials out rather than listening, because a renderer can't open a
 * server socket. Everything after the handshake is the sidecar asking and this
 * side answering.
 */

import {
    PROTOCOL_VERSION,
    type BridgeUser,
    type EventFrame,
    type RpcError,
    type RpcMethod,
    type SidecarFrame
} from "./protocol";
import { getToken, settings } from "./settings";

export const PLUGIN_VERSION = "0.1.0";

export type RpcHandler = (params: any) => Promise<unknown>;

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function rpcError(code: RpcError["code"], message: string): RpcError {
    return { code, message };
}

export class BridgeClient {
    private socket: WebSocket | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private backoff = RECONNECT_MIN_MS;
    private stopped = false;

    constructor(
        private readonly handlers: Record<RpcMethod, RpcHandler>,
        private readonly getUser: () => BridgeUser | null,
        private readonly onStateChange: (connected: boolean, detail?: string) => void
    ) {}

    get connected(): boolean {
        return this.socket?.readyState === WebSocket.OPEN;
    }

    start(): void {
        this.stopped = false;
        this.open();
    }

    stop(): void {
        this.stopped = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.socket?.close(1000, "plugin stopped");
        this.socket = null;
    }

    private scheduleRetry(reason: string): void {
        if (this.stopped || !settings.store.autoConnect) return;
        if (this.retryTimer) return;

        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
        console.debug(`[VesktopClaudeBridge] ${reason}; retrying in ${delay}ms`);

        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.open();
        }, delay);
    }

    private open(): void {
        if (this.stopped) return;

        const token = getToken();
        if (!token) {
            // No point hammering a socket we can't authenticate on.
            this.onStateChange(false, "no token set — paste one in plugin settings");
            return;
        }

        const port = settings.store.port || 8787;
        let socket: WebSocket;
        try {
            socket = new WebSocket(`ws://127.0.0.1:${port}`);
        } catch (err) {
            this.scheduleRetry(`could not open socket (${String(err)})`);
            return;
        }

        this.socket = socket;

        socket.addEventListener("open", () => {
            socket.send(
                JSON.stringify({
                    t: "hello",
                    protocol: PROTOCOL_VERSION,
                    token,
                    user: this.getUser(),
                    pluginVersion: PLUGIN_VERSION
                })
            );
        });

        socket.addEventListener("message", ev => void this.onMessage(socket, ev));

        socket.addEventListener("close", ev => {
            if (this.socket === socket) this.socket = null;
            this.onStateChange(false, ev.reason || `closed (${ev.code})`);

            // A rejected token will never succeed on retry, so don't spin on it.
            if (ev.code === 4403) {
                console.warn("[VesktopClaudeBridge] sidecar rejected the token — paste a fresh one in settings");
                return;
            }
            if (ev.code === 4426) {
                console.warn("[VesktopClaudeBridge] protocol mismatch — plugin and sidecar are different versions");
                return;
            }
            this.scheduleRetry(ev.reason || "socket closed");
        });

        socket.addEventListener("error", () => {
            // The close handler does the actual retry; this fires first and
            // carries no useful detail in a browser WebSocket.
        });
    }

    private async onMessage(socket: WebSocket, ev: MessageEvent): Promise<void> {
        let frame: SidecarFrame;
        try {
            frame = JSON.parse(String(ev.data));
        } catch {
            console.warn("[VesktopClaudeBridge] ignoring non-json frame");
            return;
        }

        if (frame.t === "hello-ok") {
            this.backoff = RECONNECT_MIN_MS;
            this.onStateChange(true, `sidecar v${frame.sidecarVersion}`);
            return;
        }

        if (frame.t !== "req") return;

        const handler = this.handlers[frame.method];
        if (!handler) {
            socket.send(
                JSON.stringify({
                    t: "res",
                    id: frame.id,
                    ok: false,
                    error: rpcError("bad_params", `unknown method ${frame.method}`)
                })
            );
            return;
        }

        try {
            const data = await handler(frame.params);
            socket.send(JSON.stringify({ t: "res", id: frame.id, ok: true, data }));
        } catch (err) {
            const rpc =
                err && typeof err === "object" && "code" in err && "message" in err
                    ? (err as RpcError)
                    : rpcError("internal", err instanceof Error ? err.message : String(err));
            console.error(`[VesktopClaudeBridge] ${frame.method} failed:`, err);
            socket.send(JSON.stringify({ t: "res", id: frame.id, ok: false, error: rpc }));
        }
    }

    /** Fire-and-forget notification to the sidecar. */
    notify(event: EventFrame["event"], data: unknown): void {
        if (!this.connected) return;
        this.socket!.send(JSON.stringify({ t: "event", event, data }));
    }
}
