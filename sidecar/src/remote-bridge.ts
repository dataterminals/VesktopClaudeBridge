/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A bridge that borrows someone else's plugin connection.
 *
 * The plugin dials exactly one socket, so exactly one process can own it. But
 * more than one process wants it: Claude Code spawns a sidecar per session, and
 * Claude Desktop spawns its own. Before this existed the second one bound the
 * same port, died with EADDRINUSE, and surfaced to the user as the singularly
 * unhelpful "Connection closed".
 *
 * So whoever starts first owns the Discord socket and serves `/rpc`; everyone
 * after that proxies through it. No new ports, no protocol change, and the
 * plugin still only ever holds one connection.
 *
 * Scope guards are unaffected. They have always lived at the rendering layer —
 * `assertAllowed` runs in the MCP tools and HTTP routes, not in the bridge — so
 * a proxied call is guarded by its own consumer, reading the same config file
 * as the owner.
 */

import { BridgeError, type Bridge, type BridgeStatus } from "./bridge-server.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import type { RpcMethod, RpcParams, RpcResults } from "./protocol.js";

const STATUS_REFRESH_MS = 5_000;

export class RemoteBridge implements Bridge {
    private readonly base: string;
    private cached: BridgeStatus;
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(private readonly cfg: Config) {
        this.base = `http://127.0.0.1:${cfg.httpPort}`;
        this.cached = {
            connected: false,
            user: null,
            pluginVersion: null,
            connectedSince: null,
            port: cfg.port
        };
    }

    /** Confirms the owner is actually answering before we claim to be usable. */
    async attach(): Promise<void> {
        await this.refresh();
        // Keep `status()` honest without making it async; nobody needs this to
        // outlive the process, hence unref.
        this.timer = setInterval(() => void this.refresh(), STATUS_REFRESH_MS);
        this.timer.unref?.();
    }

    private async refresh(): Promise<void> {
        try {
            const res = await fetch(`${this.base}/status`, {
                headers: { authorization: `Bearer ${this.cfg.token}` },
                signal: AbortSignal.timeout(3000)
            });
            if (!res.ok) return;
            const body: any = await res.json();
            this.cached = {
                connected: Boolean(body.connected),
                user: body.user ?? null,
                pluginVersion: body.pluginVersion ?? null,
                connectedSince: body.connectedSince ?? null,
                port: body.port ?? this.cfg.port
            };
        } catch {
            // The owner went away. Report disconnected rather than stale-but-happy.
            this.cached = { ...this.cached, connected: false, user: null };
        }
    }

    status(): BridgeStatus {
        return this.cached;
    }

    async call<M extends RpcMethod>(method: M, params: RpcParams[M]): Promise<RpcResults[M]> {
        let res: Response;
        try {
            res = await fetch(`${this.base}/rpc`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${this.cfg.token}`,
                    "content-type": "application/json"
                },
                body: JSON.stringify({ method, params }),
                signal: AbortSignal.timeout(this.cfg.rpcTimeoutMs + 2000)
            });
        } catch (err) {
            throw new BridgeError({
                code: "no_client",
                message: `The sidecar that owns the Discord connection stopped answering on ${this.base}. Start one, or let a Claude session spawn it.`
            });
        }

        const body: any = await res.json().catch(() => null);
        if (!res.ok || body?.ok === false) {
            throw new BridgeError(
                body?.error ?? { code: "internal", message: `proxy call failed (${res.status})` }
            );
        }

        void this.refresh();
        return body.data as RpcResults[M];
    }

    async close(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}

/**
 * Is someone already serving the bridge on this machine?
 *
 * Asks over HTTP rather than trying to bind, because a bound-and-released probe
 * races anything else starting at the same moment, and because a positive answer
 * here also proves the owner is one of ours and shares our token.
 */
export async function findOwner(cfg: Config): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${cfg.httpPort}/status`, {
            headers: { authorization: `Bearer ${cfg.token}` },
            signal: AbortSignal.timeout(1500)
        });
        if (res.ok) return true;
        if (res.status === 401) {
            log.warn("something is on the http port but rejects our token; starting our own bridge");
        }
        return false;
    } catch {
        return false;
    }
}
