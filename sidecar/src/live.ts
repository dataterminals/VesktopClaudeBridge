/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Draining the third-eye buffer, in the one place both consumers share.
 *
 * Same shape of bug as marks.ts, and it survived that fix because each consumer
 * open-coded the order for itself. `/live?json=1` returned the drained buffer
 * out of `sendJson` several lines *above* the `assertAllowed` on the text path,
 * so json mode served DM content that the very same URL correctly refused with a
 * 403 without it. The guard was present and correct; it just sat downstream of
 * one of the two exits.
 *
 * The consuming half was worse than the disclosure half. `/live` defaults
 * `consume` to true — the UserPromptSubmit hook curls it on every message the
 * user sends and must not be handed the same messages twice — and the plugin
 * empties its ring the moment it answers the RPC, before the sidecar sees a
 * byte. So a refused read had already destroyed the buffer by the time anything
 * decided it was not allowed to show it: the messages were gone, the user got a
 * 403, and there was nothing left to re-read once they fixed the config.
 *
 * The fix is to ask what is being watched *before* asking for its contents.
 * `third_eye.state` names the channel and carries no message bodies at all, so
 * the guard runs against a cheap answer and a refusal leaves the buffer exactly
 * where it was.
 *
 * That is deliberately not the cheaper "drain without consuming, guard, drain
 * again to commit". Draining first pulls message bodies across the process
 * boundary before anything has established we are allowed to read them, and the
 * entire reason this buffer lives in the renderer is so content the sidecar may
 * not have never crosses that boundary at all — see the header of
 * plugin/thirdEye.ts, which makes that the load-bearing claim of the feature.
 * The price is one extra round trip on a path whose own comment says it has to
 * stay cheap; on loopback that is single-digit milliseconds, on a request that
 * is already waiting for the plugin once.
 *
 * Rendering stays with each caller — the HTTP mirror wants one terse line, the
 * MCP tool wants a counted header — because what is worth sharing here is the
 * *order*, not the prose. Sharing only the order is also what stops this
 * drifting apart again, which is how /live came to be the odd one out.
 */

import type { Bridge } from "./bridge-server.js";
import type { Config } from "./config.js";
import { assertAllowed } from "./format.js";
import type { LiveMessage, ThirdEyeState } from "./protocol.js";

export interface LiveRead {
    /** The state the drain reported, which is fresher than the one we guarded. */
    state: ThirdEyeState;
    messages: LiveMessage[];
    /** Evicted before anything read them, carried through so callers can say so. */
    dropped: number;
    /** A Discord reload discarded the buffer, same reason: a named gap is recoverable. */
    resumed: string | null;
}

export async function readLive(
    bridge: Bridge,
    cfg: Config,
    opts: { consume: boolean; notableOnly: boolean; limit?: number; }
): Promise<LiveRead> {
    const watched = await bridge.call("third_eye.state", {});

    // The guard runs here, against an answer with no message bodies in it, so a
    // refusal costs nothing and destroys nothing.
    assertAllowed(cfg, watched.channel);

    const out = await bridge.call("third_eye.drain", {
        consume: opts.consume,
        notableOnly: opts.notableOnly,
        limit: opts.limit
    });

    /*
     * Guarded twice, against two different answers, because the user can move
     * the watch between the two calls — onto a DM, in the case that matters.
     *
     * The second check is not the belt-and-braces it looks like: without it the
     * window is small but the consequence is the whole point of `denyDms`. And
     * it costs nothing to be strict here, because retargeting is exactly what
     * empties the ring — `start()` in plugin/thirdEye.ts assigns `ring = []` —
     * so anything this refuses is at most the handful of messages that arrived
     * in the switching window, on a channel the user just told us to watch and
     * this sidecar is configured not to read.
     */
    assertAllowed(cfg, out.state.channel);

    return {
        state: out.state,
        messages: out.messages,
        dropped: out.dropped,
        resumed: out.resumed ?? null
    };
}
