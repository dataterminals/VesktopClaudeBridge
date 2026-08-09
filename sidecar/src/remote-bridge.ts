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
 *
 * This file also decides *that* the owner is gone, and deliberately does not
 * decide what to do about it. Once two probes in a row have missed it says so on
 * every probe after that, for as long as the owner stays missing; what to do
 * about it, and how often doing it is worth the trouble, belongs to
 * `bridge-holder.ts`. That split is what lets the detection stay as crude as it
 * is — see `OwnerProbe` — and the level-triggering is not an accident, see
 * `OwnerWatch.gone`.
 */

import { BridgeError, type Bridge, type BridgeStatus } from "./bridge-server.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import type { RpcMethod, RpcParams, RpcResults } from "./protocol.js";

const STATUS_REFRESH_MS = 5_000;

/**
 * How long to wait before taking a second look at an owner that just missed.
 *
 * Two independent observations are cheap insurance against a single dropped
 * packet or a one-off timeout, and 750ms costs under a second of recovery — the
 * plugin's own redial ladder is measured in seconds, so this disappears into it.
 *
 * It is *not* what gives a deliberate `npm start -- --takeover` a head start on
 * the socket it just cleared. That used to be claimed here and it named the
 * wrong term by an order of magnitude: the head start is STATUS_REFRESH_MS. A
 * proxy has to sit through up to a whole 5s poll before it has even its first
 * miss, while `stopOwner()` is already polling at 250ms and binds the moment the
 * port frees; 750ms is a rounding error next to that. Still a tendency and not a
 * guarantee — a proxy whose first miss came from an in-flight call rather than
 * the poll skips the 5s entirely — so the real safety net remains that whoever
 * loses the bind keeps proxying and says so out loud.
 */
const GONE_CONFIRM_MS = 750;

/** Misses in a row before we believe the owner is actually gone. */
const GONE_STREAK = 2;

/**
 * Did the owner answer at all?
 *
 * Two states, not three, and the reason is worth writing down because a finer
 * taxonomy is the obvious thing to reach for here. A promotion attempt is a
 * `bind()` and nothing else — it cannot take a socket a live process is holding,
 * on Windows or on POSIX — so a wrong guess costs one failed syscall and one log
 * line. Spending a per-errno classifier to buy precision we don't need was
 * measurably worse than useless: the shape a dying owner actually produces
 * mid-request is `UND_ERR_SOCKET`, not `ECONNREFUSED`, so the "precise" version
 * filed a real death under "probably just slow" and zeroed the counter that the
 * 5s poll had been building.
 */
export type OwnerProbe = "alive" | "unreachable";

/**
 * What a proxy wants to be told about the process it is borrowing from.
 *
 * Both are required rather than an optional field, because forgetting to wire
 * `gone` is a silent regression to the behaviour this whole mechanism exists to
 * remove: a proxy whose owner died staying stranded until a human restarted
 * every session's sidecar by hand.
 */
export interface OwnerWatch {
    /**
     * The owner has now missed twice in a row. Level-triggered: this fires on
     * *every* probe for as long as the owner stays missing, not once per death.
     *
     * Edge-triggered was the original design and it was the whole bug. `gone()`
     * fired on the single probe where the streak reached two, and the only thing
     * that resets that streak is a *successful* probe — so a promotion that
     * failed (lost the bind, then found nothing serving http) got exactly one
     * attempt, and the proxy stayed stranded for the life of the process. That
     * is precisely the state `bridge-holder.ts` exists to remove, so the file
     * that must never give up was giving up after one try.
     *
     * Firing on the level makes "still gone" exactly as loud as "just went",
     * which puts the throttling where it can be reasoned about: the handler's
     * own cooldown. See `PROMOTION_COOLDOWN_MS`.
     */
    gone(): void;
    /** The owner answered. Fires on every good probe, so latched state can clear. */
    alive(): void;
}

export class RemoteBridge implements Bridge {
    private readonly base: string;
    private cached: BridgeStatus;
    private timer: ReturnType<typeof setInterval> | null = null;
    private confirmTimer: ReturnType<typeof setTimeout> | null = null;
    private watch: OwnerWatch | null = null;
    private goneStreak = 0;
    private owner: OwnerInfo | null = null;

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
    async attach(watch: OwnerWatch): Promise<void> {
        this.watch = watch;
        await this.probe();
        // Keep `status()` honest without making it async; nobody needs this to
        // outlive the process, hence unref.
        this.timer = setInterval(() => void this.probe(), STATUS_REFRESH_MS);
        this.timer.unref?.();
    }

    /**
     * Asks the owner how it is, and updates the miss counter either way.
     *
     * Any HTTP response counts as alive, including a 401 — something is holding
     * that port, and if it is not one of ours then the bind would fail anyway,
     * so there is nothing a finer answer would let us do differently.
     */
    private async probe(): Promise<OwnerProbe> {
        let res: Response;
        try {
            res = await fetch(`${this.base}/status`, {
                headers: { authorization: `Bearer ${this.cfg.token}` },
                signal: AbortSignal.timeout(3000)
            });
        } catch {
            // The owner went away. Report disconnected rather than stale-but-happy.
            this.cached = { ...this.cached, connected: false, user: null };
            this.noteUnreachable();
            return "unreachable";
        }

        this.noteAlive();
        if (!res.ok) return "alive";

        const body: any = await res.json().catch(() => null);
        if (body) {
            this.cached = {
                connected: Boolean(body.connected),
                user: body.user ?? null,
                pluginVersion: body.pluginVersion ?? null,
                connectedSince: body.connectedSince ?? null,
                port: body.port ?? this.cfg.port
            };
            this.owner = { pid: body.owner?.pid ?? null, since: body.owner?.since ?? null };
        }
        return "alive";
    }

    /** An answer of any kind is the only thing that clears the miss counter. */
    private noteAlive(): void {
        this.goneStreak = 0;
        if (this.confirmTimer) clearTimeout(this.confirmTimer);
        this.confirmTimer = null;
        this.watch?.alive();
    }

    private noteUnreachable(): void {
        if (!this.watch) return;
        this.goneStreak++;

        /*
         * `>=`, not `===`, and the difference is the whole re-election feature.
         * Equality was defended here as noise control — a permanently dead owner
         * re-firing this every 5s for the life of the process — but the noise it
         * bought off is one `log.debug` per poll from the promotion cooldown,
         * and the stuck-port warning latches itself after the third real failure.
         * A stuck machine still says its piece exactly once at the default log
         * level. What equality cost was every retry after the first, because
         * nothing but a successful probe puts this counter back to zero.
         */
        if (this.goneStreak >= GONE_STREAK) return this.watch.gone();

        // Take the second look promptly rather than waiting out a whole poll
        // cycle: the point of the confirm is to survive one dropped packet, not
        // to add five seconds to every recovery.
        if (this.goneStreak === 1 && !this.confirmTimer) {
            this.confirmTimer = setTimeout(() => {
                this.confirmTimer = null;
                void this.probe();
            }, GONE_CONFIRM_MS);
            this.confirmTimer.unref?.();
        }
    }

    status(): BridgeStatus {
        return this.cached;
    }

    describe(): string {
        const who = this.owner ? describeOwner(this.owner) : "another process";
        return `${who}, reached over :${this.cfg.httpPort}`;
    }

    /**
     * The pid `/status` last reported, or null if nobody has ever answered.
     *
     * Exists for one caller. `BridgeHolder.standDown()` has lost a bind and found
     * *someone* serving http, and cannot otherwise tell a real handover from the
     * owner it gave up on simply coming back — both look identical from there,
     * and it used to report the second as the first.
     */
    lastKnownOwner(): number | null {
        return this.owner?.pid ?? null;
    }

    async call<M extends RpcMethod>(method: M, params: RpcParams[M]): Promise<RpcResults[M]> {
        // Two seconds of slack past the owner's own RPC deadline. The owner
        // times the plugin out at `rpcTimeoutMs` and answers with a proper
        // `timeout` error, so this fires only when the owner never answers at all.
        const budgetMs = this.cfg.rpcTimeoutMs + 2000;

        let res: Response;
        try {
            res = await fetch(`${this.base}/rpc`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${this.cfg.token}`,
                    "content-type": "application/json"
                },
                body: JSON.stringify({ method, params }),
                signal: AbortSignal.timeout(budgetMs)
            });
        } catch (err) {
            /*
             * Our own deadline expiring is evidence about our patience, not about
             * the owner's health, and the two used to be fed to the same counter.
             * They are distinguishable: measured on Node 24, `AbortSignal.timeout()`
             * surfaces as a DOMException named TimeoutError, while an owner that
             * really went away surfaces as a TypeError — `UND_ERR_SOCKET` when it
             * dies mid-request, a connect failure once the port is free.
             *
             * Conflating them was user-visible twice over. The message below
             * announced a takeover on the *first* miss — before the confirming
             * probe, before any bind, whether or not the cooldown would even let
             * a promotion run — which on a slow owner was simply untrue. And the
             * resulting stand-down logged a handover that never happened.
             *
             * So a timeout kicks a `/status` probe and lets that settle it.
             * `/status` never touches Discord, it answers off cached state, so an
             * owner that cannot produce it inside 3s is genuinely wedged and the
             * ordinary miss path takes over from there.
             */
            if ((err as Error)?.name === "TimeoutError") {
                void this.probe();
                throw new BridgeError({
                    code: "timeout",
                    message:
                        `The sidecar that owns the Discord connection did not answer ${method} within ${budgetMs}ms. ` +
                        `Its own deadline is ${this.cfg.rpcTimeoutMs}ms and it would have returned a timeout error at that point, ` +
                        "so this is that process being stuck rather than Discord being slow. Checking whether it is still alive — try again shortly."
                });
            }

            /*
             * A call that was in flight when the owner died is the single most
             * likely way a proxy learns about it, so it feeds the same counter
             * the poll does — and it deliberately does not wait for the outcome.
             * The confirming probe lands 750ms later on its own; blocking a tool
             * call on a bind plus an owner poll would trade a fast honest failure
             * for a slow one.
             */
            this.noteUnreachable();
            throw new BridgeError({
                code: "no_client",
                message:
                    "The sidecar that owned the Discord connection stopped answering. This one will try to take the bridge over; " +
                    "Discord redials on its own, usually within about 10 seconds of a handover. Try again shortly."
            });
        }

        const body: any = await res.json().catch(() => null);
        if (!res.ok || body?.ok === false) {
            throw new BridgeError(
                body?.error ?? { code: "internal", message: `proxy call failed (${res.status})` }
            );
        }

        void this.probe();
        return body.data as RpcResults[M];
    }

    async close(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        if (this.confirmTimer) clearTimeout(this.confirmTimer);
        this.timer = null;
        this.confirmTimer = null;
        // Nulled, not just cleared: a probe already in flight resolves after this
        // returns, and `--no-mcp` closes the bridge and then exits 3. Without
        // this the last gasp of a dying proxy is a promotion attempt.
        this.watch = null;
    }
}

/** Who currently holds the Discord socket. `pid` is absent on older sidecars. */
export interface OwnerInfo {
    pid: number | null;
    since: string | null;
}

/**
 * Renders an owner for a human:
 * "pid 29112, serving since 2026-08-09T20:58:20.123Z".
 *
 * "serving since", not "up since", because a process that took the bridge over
 * from a dead owner has been up far longer than it has held the socket, and the
 * number that matters when you are looking at two of these is when the handover
 * happened.
 *
 * The stamp goes out as the raw ISO string `/status` published rather than a
 * friendlier clock, because that is the string you are comparing against: these
 * lines are read next to another sidecar's `/status` output, and there is no
 * configured timezone in scope here anyway — `cfg.timezone` is a *rendering*
 * setting for transcripts, not for the sidecar's own logs. The parse is only
 * ever a validity guard, so a garbage `since` degrades to the bare pid instead
 * of printing "serving since not-a-date".
 */
export function describeOwner(owner: OwnerInfo): string {
    const who = owner.pid ? `pid ${owner.pid}` : "an unidentified process";
    if (!owner.since) return who;
    const at = new Date(owner.since);
    return Number.isNaN(at.getTime()) ? who : `${who}, serving since ${owner.since}`;
}

/**
 * Who is already serving the bridge on this machine, if anyone?
 *
 * Asks over HTTP rather than trying to bind, because a bound-and-released probe
 * races anything else starting at the same moment, and because an answer here
 * also proves the owner is one of ours and shares our token.
 *
 * Returns the owner rather than a boolean because every interesting thing you
 * might do about an existing owner — report it, stop it, take over from it —
 * needs to know which process it is.
 */
export async function findOwner(cfg: Config): Promise<OwnerInfo | null> {
    try {
        const res = await fetch(`http://127.0.0.1:${cfg.httpPort}/status`, {
            headers: { authorization: `Bearer ${cfg.token}` },
            signal: AbortSignal.timeout(1500)
        });
        if (res.ok) {
            const body: any = await res.json().catch(() => null);
            return { pid: body?.owner?.pid ?? null, since: body?.owner?.since ?? null };
        }
        if (res.status === 401) {
            log.warn("something is on the http port but rejects our token; starting our own bridge");
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Waits for whoever wins a contested bind to start answering.
 *
 * A single `findOwner()` right after losing a bind almost always misses: the
 * winner's websocket is up the instant its bind returns, but its HTTP mirror
 * comes up a moment later, and may itself be retrying a port the dead owner has
 * not finished releasing. This poll *is* the loser path — without it a process
 * that lost the race would conclude nobody owns the bridge and give up.
 *
 * Same 250ms shape as `stopOwner`'s wait below, for the same reason.
 */
export async function waitForOwner(cfg: Config, timeoutMs = 5_000): Promise<OwnerInfo | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const owner = await findOwner(cfg);
        if (owner) return owner;
        if (Date.now() >= deadline) return null;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

/**
 * Stops the current owner so this process can take the socket.
 *
 * The pid comes from a service that answered on our loopback port with our
 * token, which is the strongest identification available here — but it is still
 * a pid read off the wire, so a failure to signal it is reported rather than
 * retried against anything else.
 *
 * There is nothing to lose in the stopped process: the third-eye buffer lives in
 * the renderer, not here, and the plugin redials whoever is listening next.
 */
export async function stopOwner(cfg: Config, owner: OwnerInfo): Promise<boolean> {
    if (!owner.pid) {
        // Only one thing produces this: a sidecar from before /status carried a
        // pid, still running. Nothing here can name it, so say the one thing
        // that does resolve it rather than leaving a dead end.
        log.warn(
            "the running sidecar does not report a pid — it predates this build. " +
                "Stop it by hand (Task Manager, or `Stop-Process`) and start this one again."
        );
        return false;
    }

    try {
        process.kill(owner.pid, "SIGTERM");
    } catch (err) {
        log.warn(`could not stop pid ${owner.pid}:`, err);
        return false;
    }

    // Wait for it to actually stop answering. Binding the moment after the
    // signal lands is a race the old owner usually wins.
    for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        if (!(await findOwner(cfg))) {
            log.info(`stopped pid ${owner.pid}`);
            return true;
        }
    }

    log.warn(`pid ${owner.pid} was signalled but is still serving the bridge`);
    return false;
}
