/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Reading the mark queue, in the one place both consumers share.
 *
 * This exists because of a data-loss bug that both consumers had independently.
 * `marked.list` with `consume: true` empties the plugin's queue *before* it
 * answers, and the scope guard only runs afterwards, while the sidecar renders
 * each item. So one DM mark under the default `denyDms: true` threw on the first
 * item and the caller got an error back — with every mark the user had made
 * already gone from disk, with no undo. The existing smoke test proves that
 * precondition is routine rather than exotic: `/marked` 403s today because the
 * fixture mark is in a DM.
 *
 * The fix is to never ask the plugin to consume. List without consuming, render
 * (guard included), and only once that has actually succeeded clear the marks
 * that were rendered, one id at a time. That makes `consume` mean "consume what
 * you actually received", which is the honest reading of it: a mark the user
 * made during the round trip survives, and marks that failed the scope guard
 * stay put where the menu and `discord_clear_marks` can still reach them.
 *
 * Folding both callers into one function also repairs the drift that had the
 * HTTP mirror silently dropping each mark's `note`.
 */

import type { Bridge } from "./bridge-server.js";
import type { Config } from "./config.js";
import {
    Pseudonymizer,
    assertAllowed,
    markQueueNote,
    renderMarkHeader,
    renderTranscript
} from "./format.js";
import { log } from "./log.js";
import type { MarkedItem } from "./protocol.js";

export interface MarkRead {
    /** The queue as the plugin gave it, before any clearing. Empty is not an error. */
    items: MarkedItem[];
    /** Rendered text, preamble included. Empty string when there was nothing to render. */
    text: string;
}

export async function readMarks(
    bridge: Bridge,
    cfg: Config,
    pseudo: Pseudonymizer,
    opts: { consume: boolean; ids: boolean; }
): Promise<MarkRead> {
    const { items } = await bridge.call("marked.list", { consume: false });
    if (!items.length) return { items, text: "" };

    // Rendering is where the scope guard lives, and it still throws the whole
    // response rather than filtering: one out-of-scope mark means the user asked
    // for something this sidecar is not configured to hand over, and quietly
    // returning the rest would be answering a different question.
    const blocks = items.map(item => {
        assertAllowed(cfg, item.channel);
        const body = renderTranscript(item.guild, item.channel, pseudo.apply(item.messages), {
            truncateAt: cfg.truncateAt,
            timezone: cfg.timezone,
            ids: opts.ids
        });
        return `${renderMarkHeader(item, cfg.timezone)}\n${body}`;
    });

    const text = `${markQueueNote(items, cfg.timezone)}\n\n${blocks.join("\n\n")}`;

    if (opts.consume) {
        /*
         * One call per mark rather than the single wholesale `marked.clear` the
         * protocol also accepts, and the difference is a mark made during the
         * round trip: clearing by id destroys only what was actually rendered
         * above, while clearing everything would silently eat whatever the user
         * marked while this response was in flight. That is the same class of
         * data loss this whole file exists to fix, so it is not a trade worth
         * making — but it is worth knowing the price, because from a proxy each
         * of these is a full HTTP-plus-websocket round trip.
         *
         * Measured on loopback with a fixture plugin: 12ms per call, so the
         * plugin's own cap of 50 marks costs about 0.6s of wall clock, once, on
         * a request that explicitly asked to consume. The plugin's clear is a
         * queue splice, so that is transport and nothing else.
         */
        for (const item of items) {
            try {
                await bridge.call("marked.clear", { markId: item.markId });
            } catch (err) {
                // The content is already in hand, so failing the whole read
                // because the queue could not be emptied would throw away the
                // thing the caller actually asked for. Worst case the mark comes
                // back on the next read, which is the state we were already in.
                log.warn(`read mark ${item.markId} but could not clear it:`, err);
            }
        }
    }

    return { items, text };
}
