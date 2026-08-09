/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Who holds the bridge, and what happens when they stop.
 *
 * Exactly one process can own the Discord socket; everyone else proxies through
 * it over HTTP. Before this file existed, the death of that one process stranded
 * every proxy permanently: `RemoteBridge` would flip `connected` to false, every
 * tool call would report that the owner stopped answering, and the only way out
 * was to restart every session's sidecar by hand — including the ones Claude
 * Code and Claude Desktop had spawned for themselves, which a user cannot
 * conveniently restart at all.
 *
 * The election is `bind()`. That is the whole mechanism, and it is why there is
 * no consensus protocol, no lease file, no owner identity anywhere in the
 * decision path: binding a loopback port is atomic, the OS already arbitrates it,
 * and a listening socket cannot be stolen (Node does not set SO_REUSEADDR on
 * Windows, and on POSIX SO_REUSEADDR does not permit taking a live listener).
 * So a promotion attempt is a bind and nothing else, and guessing wrong about a
 * slow owner costs one failed syscall and one log line rather than the socket.
 * Nothing is ever forcibly taken — `--takeover` remains the only thing in this
 * codebase that kills anything, and it stays explicit.
 *
 * Because an attempt is that cheap, losing one is not a verdict, it is a reason
 * to try again shortly — and everything above only holds if trying again is what
 * actually happens. It did not, for a while: the trigger fired once per death
 * and one lost bind stranded the proxy for the life of the process, which is the
 * exact state described two paragraphs up. The trigger is level-triggered now
 * and `PROMOTION_COOLDOWN_MS` is what spaces the retries out.
 *
 * `BridgeHolder` is the indirection that makes a promotion invisible. The MCP
 * server and the HTTP mirror capture a bridge once, at startup, so the object
 * they hold has to be the one that can change its mind about what it wraps.
 */

import { BridgeError, BridgeServer, type Bridge, type BridgeStatus } from "./bridge-server.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import type { RpcMethod, RpcParams, RpcResults } from "./protocol.js";
import { RemoteBridge, waitForOwner } from "./remote-bridge.js";

/**
 * Everything that has to happen between binding the socket and being findable.
 *
 * A required constructor argument rather than something a promoted process is
 * trusted to remember, because a promoted owner that skips the HTTP mirror is
 * invisible: the next sidecar's `findOwner()` gets nothing, starts a second
 * bridge, fails to bind, and the whole find-the-owner mechanism is broken from
 * that moment on. It is literally the same function the startup owner runs, so
 * the two cannot drift.
 */
export type Serve = (server: BridgeServer) => Promise<void>;

/**
 * The floor between two bind attempts from this process, however many fire.
 *
 * A throttle, not a budget. The owner watch is level-triggered — `gone()` fires
 * on every 5s probe for as long as the owner stays missing — so a trigger that
 * lands inside the cooldown is dropped knowing the next one is at most a poll
 * away. That is the whole retry loop, and it is deliberately not more than that:
 * a timer scheduled here would be a second thing for `close()` to cancel and a
 * second way to attempt a bind after the process has been asked to stop, to buy
 * at most five seconds.
 *
 * Fifteen seconds is chosen to be comfortably longer than one whole failed
 * attempt (up to 250ms of jitter, the bind, then `waitForOwner`'s 5s), so
 * retries are spaced rather than stacked back to back.
 */
const PROMOTION_COOLDOWN_MS = 15_000;

/**
 * Spread simultaneous attempts over this window before binding.
 *
 * Not for correctness — the bind is atomic and one process wins regardless. It
 * spreads the *losers*, so they don't all start looking for the winner in the
 * same millisecond, when the winner's HTTP mirror is least likely to be up yet.
 */
const BIND_JITTER_MS = 250;

/**
 * Failed attempts before the stuck-port warning is worth a human's attention.
 *
 * Attempts, not polls: each one costs `waitForOwner`'s 5s and then waits out the
 * 15s cooldown before the next trigger is let through, so three of them land
 * between roughly 40 seconds and a minute after the owner went quiet. Long
 * enough that a slow-but-working handover has finished; short enough to still be
 * about the thing the user is watching.
 */
const STUCK_WARN_AFTER = 3;

/**
 * Binds the websocket port. `null` means someone else got there first.
 *
 * A fresh `BridgeServer` per attempt on purpose: `listen()` builds the
 * `WebSocketServer` internally, so calling it twice on one instance would
 * overwrite `this.wss` with the failed listener still attached to the old one.
 */
export async function bindBridge(cfg: Config, version: string): Promise<BridgeServer | null> {
    const server = new BridgeServer(cfg, version);
    try {
        await server.listen();
        return server;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
        // A WebSocketServer that failed to bind still calls back from close() —
        // measured at 2ms here — and leaving it unclosed leaks the internal
        // http.Server it built before the bind failed.
        void server.close();
        return null;
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class BridgeHolder implements Bridge {
    private closed = false;
    private promoting: Promise<boolean> | null = null;
    private lastAttemptAt = 0;
    private promotedAt: number | null = null;
    private stuckCycles = 0;
    private warnedStuck = false;

    private constructor(
        private inner: Bridge,
        private owner: boolean,
        private readonly cfg: Config,
        private readonly version: string,
        private readonly serve: Serve
    ) {}

    /** This process bound the socket. */
    static owning(server: BridgeServer, cfg: Config, version: string, serve: Serve): BridgeHolder {
        return new BridgeHolder(server, true, cfg, version, serve);
    }

    /**
     * Someone else has it. Both branches get wrapped rather than only the proxy:
     * one type flows through `index.ts` and every consumer, which is worth more
     * than the allocation it saves.
     */
    static proxying(remote: RemoteBridge, cfg: Config, version: string, serve: Serve): BridgeHolder {
        return new BridgeHolder(remote, false, cfg, version, serve);
    }

    get isOwner(): boolean {
        return this.owner;
    }

    status(): BridgeStatus {
        return this.inner.status();
    }

    describe(): string {
        return this.inner.describe();
    }

    async call<M extends RpcMethod>(method: M, params: RpcParams[M]): Promise<RpcResults[M]> {
        try {
            return await this.inner.call(method, params);
        } catch (err) {
            /*
             * The stock no_client message sends you to check Vesktop and the
             * plugin toggle, which is right almost always and wrong in exactly
             * this window: we took the socket over seconds ago and the plugin has
             * not finished redialling. It is the message a user is most likely to
             * hit during a *working* handover, so it says what is happening.
             *
             * "About 10 seconds" is the one estimate this feature quotes, here
             * and everywhere else it appears, and it comes from the plugin's
             * ladder: `plugin/bridge.ts` starts at RECONNECT_MIN_MS = 1000 and
             * doubles to a 30s cap, resetting only on a successful handshake, so
             * dials land at +1s, +3s, +7s, +15s, +31s from the moment the old
             * owner died — not from the handover. Detection plus a bind puts the
             * handover 1-6s in, which usually means the +7s or +15s rung, and a
             * handover that needed a retry lands near +20s and catches +31s. Ten
             * seconds is the honest middle of that; thirty is the worst case.
             */
            if (err instanceof BridgeError && err.rpc.code === "no_client" && this.promotedAt !== null) {
                const secs = Math.round((Date.now() - this.promotedAt) / 1000);
                if (secs < 30) {
                    throw new BridgeError({
                        code: "no_client",
                        message:
                            `This sidecar took the bridge over ${secs}s ago because the previous owner stopped answering. ` +
                            "Discord redials on its own, usually within about 10 seconds of the handover — try again shortly. " +
                            "Nothing is wrong with Vesktop or the plugin."
                    });
                }
            }
            throw err;
        }
    }

    async close(): Promise<void> {
        this.closed = true;
        await this.inner.close();
    }

    /** The owner answered again, so anything we latched about it being missing is stale. */
    ownerAnswered(): void {
        this.stuckCycles = 0;
        this.warnedStuck = false;
    }

    /**
     * Tries to become the owner. Never rejects.
     *
     * Called repeatedly, not once. Both triggers — the 5s owner poll and a failed
     * `call()` — feed one miss counter that is tested on the level, so while the
     * owner is missing this is invoked over and over and the cooldown below is
     * what decides which invocation becomes a real attempt. That is the entire
     * retry mechanism, and it is why there is no scheduler here: the poll that
     * detects the outage is already a timer, it runs for exactly as long as the
     * outage lasts, and reusing it cannot outlive `close()`.
     *
     * Every trigger site calls this with `void`, on a path whose entire purpose
     * is recovery — an unhandled rejection here would turn a recoverable outage
     * into a crashed sidecar.
     */
    async promote(): Promise<boolean> {
        if (this.owner) return true;
        if (this.closed) return false;
        // Single-flight. Both triggers land here independently and repeatedly, so
        // without this a burst of failing tool calls would each start a bind of
        // their own while the poll was already halfway through one.
        if (this.promoting) return this.promoting;

        const waited = Date.now() - this.lastAttemptAt;
        if (waited < PROMOTION_COOLDOWN_MS) {
            /*
             * Dropped rather than deferred, which is only safe because the
             * trigger keeps coming: the next probe re-fires `gone()` within 5s,
             * and the first one that arrives after the cooldown expires is the
             * retry. When this returned false against an *edge*-triggered
             * `gone()` it was not a throttle at all — it silently converted a
             * transient (die, fail to promote, come back, die again inside 15s)
             * into a permanent outage, because nothing ever asked again.
             */
            log.debug(
                `not trying for the bridge again yet (${Math.round((PROMOTION_COOLDOWN_MS - waited) / 1000)}s of the cooldown left)`
            );
            return false;
        }
        // Stamped before the attempt, not after, so failures are spaced by the
        // cooldown rather than by however long a failure happens to take.
        this.lastAttemptAt = Date.now();

        this.promoting = this.attempt().catch(err => {
            log.error("tried to take the bridge over and something unexpected went wrong:", err);
            return false;
        });
        try {
            return await this.promoting;
        } finally {
            this.promoting = null;
        }
    }

    private async attempt(): Promise<boolean> {
        await sleep(Math.random() * BIND_JITTER_MS);
        if (this.closed) return false;

        const server = await bindBridge(this.cfg, this.version);
        if (!server) return this.standDown();

        // The process could have been asked to shut down during the jitter or
        // the bind. Holding a socket nobody is going to serve is worse than not
        // having won it.
        if (this.closed) {
            await server.close();
            return false;
        }

        const previous = this.inner;
        this.inner = server;
        this.owner = true;
        this.promotedAt = Date.now();
        this.ownerAnswered();
        await previous.close();

        log.info(
            `the previous owner is gone; this process (pid ${process.pid}) now holds the bridge on :${this.cfg.port}. ` +
                "Discord redials on its own, usually within about 10 seconds."
        );
        await this.serve(server);
        return true;
    }

    /**
     * We lost the bind, so somebody else is holding the socket. This is the path
     * that must not give up — and now doesn't: returning false here leaves the
     * owner watch running, and its next `gone()` is the next attempt.
     */
    private async standDown(): Promise<boolean> {
        // Captured before the lookup. Whoever is serving http a moment from now
        // is either a genuine new owner or the one we gave up on, and from here
        // those two observations are identical.
        const before = this.inner instanceof RemoteBridge ? this.inner.lastKnownOwner() : null;

        const winner = await waitForOwner(this.cfg);
        if (winner) {
            /*
             * Nothing to do at all. `inner` is still the RemoteBridge pointed at
             * 127.0.0.1:httpPort, which is now whoever holds it — the base url
             * was derived from config, never from who happened to be there. Its
             * next probe answers `alive` and everything resets itself.
             *
             * Named rather than logged silently because a user who just typed
             * --takeover in another window needs to see why this one didn't win.
             */
            this.ownerAnswered();
            const who = winner.pid ? `pid ${winner.pid}` : "another process";
            if (winner.pid !== null && winner.pid === before) {
                /*
                 * Same pid as before we started: nobody took anything over, the
                 * owner we wrote off came back. This line used to claim a
                 * handover unconditionally, which meant a merely-slow owner
                 * produced a phantom one in the logs — and a phantom handover in
                 * a bug report sends whoever reads it looking for a second
                 * sidecar that never existed.
                 */
                log.info(
                    `${who} is answering again and still holds the bridge; proxying through :${this.cfg.httpPort} as before`
                );
            } else {
                log.info(`${who} won the bridge on :${this.cfg.port}; proxying through :${this.cfg.httpPort} instead`);
            }
            return false;
        }

        this.stuckCycles++;
        if (this.stuckCycles < STUCK_WARN_AFTER) {
            /*
             * Debug only, because this state is reachable while everything is
             * fine: `findOwner()` gives up after 1500ms, and the winner's own
             * HTTP bind may still be retrying a port the dead owner has not
             * finished releasing. Telling a user to stop a healthy sidecar is the
             * worst false positive this feature can produce, and unlike a wrong
             * bind it does not self-correct, because a human acts on it.
             */
            log.debug(
                `lost the bind and could not find who won on :${this.cfg.httpPort}; still proxying, will try again after the cooldown`
            );
        } else if (!this.warnedStuck) {
            this.warnedStuck = true;
            /*
             * Latched, so a machine that stays in this state says this once
             * rather than every cycle forever. `ownerAnswered()` unlatches it,
             * which is right: if the port ever starts answering again, the next
             * time it stops is genuinely new news.
             *
             * The advice deliberately is not `--takeover`, which is what this
             * used to recommend. --takeover finds and stops the owner by asking
             * over http and reading `owner.pid` out of the reply, and no http is
             * the entire premise of this warning — so the one command suggested
             * here provably could not work in the only state that prints it.
             */
            log.warn(
                `something has held ws://127.0.0.1:${this.cfg.port} for the better part of a minute but nothing answers on :${this.cfg.httpPort}. ` +
                    "Either it is not a VesktopClaudeBridge sidecar, or it was started with http disabled. `--takeover` cannot help — it works " +
                    `over http, which is the missing piece. Find the holder with \`netstat -ano | findstr :${this.cfg.port}\` and stop that pid; ` +
                    "this process takes the bridge within about 20 seconds of the port coming free."
            );
        }
        return false;
    }
}
