/*
 * VesktopClaudeBridge — Equicord/Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Who may read which DM, and until when.
 *
 * Deliberately free of any UI import, so the rule — "is this conversation
 * readable right now" — can be read and audited on its own, away from the modal
 * that populates it. dmConsent.ts is the half that asks; this is the half that
 * remembers.
 *
 * Three tiers, and the split between them is the design:
 *
 *  - Temporary grants live in memory only and die with the renderer, so Ctrl+R
 *    revokes every one of them. Same stance the third eye takes on its buffer:
 *    consent that quietly outlives the session it was given in is worse than
 *    consent you have to give twice.
 *  - Permanent grants go to DataStore, which is IndexedDB and per-install.
 *    Deliberately NOT plugin settings — Vencord's cloud settings sync uploads
 *    that blob wholesale, and a list of the people you DM is precisely the kind
 *    of thing that should not leave the machine. Same reasoning that keeps the
 *    bridge token out of settings; see the note at the top of settings.ts.
 *  - Denials are remembered too, briefly. Without that, an agent that retries
 *    on refusal reopens the modal immediately and the only way out is to allow
 *    the thing you just refused. A denial has to cost the asker something, or
 *    it is not a denial.
 */

import * as DataStore from "@api/DataStore";

const STORE_KEY = "VesktopClaudeBridge_dmAllow";

/**
 * How long a refusal suppresses further prompts for the same conversation.
 *
 * Long enough that a retry loop gives up rather than grinding, short enough
 * that changing your mind costs one read and not a reload.
 */
const DENY_COOLDOWN_MS = 5 * 60_000;

/**
 * The DM listing is gated as though it were one more conversation.
 *
 * `dms` returns no message bodies at all, and is still the disclosure that
 * matters most in aggregate: every handle you talk to, with account ids beside
 * them. Giving it a key rather than a special case means it gets the same
 * grant, the same expiry and the same revoke button as anything else.
 */
export const LISTING_KEY = "*dm-listing*";

export interface AlwaysAllowed {
    /** Channel id, or LISTING_KEY. */
    key: string;
    /** Who it was with when it was granted, for the settings list to show. */
    label: string;
    /** ISO 8601, so the settings list can say how long ago you agreed to this. */
    addedAt: string;
}

let always: AlwaysAllowed[] = [];
const temporary = new Map<string, number>();
const refused = new Map<string, number>();

/** Reads the permanent list back off disk. Called once, from the plugin's start(). */
export async function loadDmLedger(): Promise<void> {
    try {
        const saved = await DataStore.get<AlwaysAllowed[]>(STORE_KEY);
        always = Array.isArray(saved) ? saved : [];
    } catch (err) {
        // Fails closed by leaving the list empty: the cost is re-approving a
        // conversation, which is a prompt. The other direction would be reading
        // a DM because a database read failed, which is not recoverable.
        console.warn("[VesktopClaudeBridge] could not read the DM allowlist; starting empty:", err);
        always = [];
    }
}

function persist(): void {
    void DataStore.set(STORE_KEY, always).catch(err =>
        console.warn("[VesktopClaudeBridge] could not save the DM allowlist:", err)
    );
}

/** Everything permanently allowed, newest first. For the settings UI. */
export function alwaysAllowed(): AlwaysAllowed[] {
    return [...always].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

/**
 * Whether this conversation may be read right now, without asking.
 *
 * Expiry is checked on read rather than swept on a timer. There is no
 * background tick to get wrong, nothing to leak when the plugin stops, and a
 * grant cannot outlive its deadline just because nothing happened to sweep it.
 */
export function isGranted(key: string): boolean {
    if (always.some(a => a.key === key)) return true;

    const until = temporary.get(key);
    if (until === undefined) return false;
    if (until > Date.now()) return true;

    temporary.delete(key);
    return false;
}

/** Milliseconds left on a temporary grant, or 0 if there isn't a live one. */
export function grantedFor(key: string): number {
    const until = temporary.get(key);
    return until && until > Date.now() ? until - Date.now() : 0;
}

export function grantFor(key: string, ms: number): void {
    temporary.set(key, Date.now() + ms);
}

export function grantForever(key: string, label: string): void {
    if (always.some(a => a.key === key)) return;
    always.push({ key, label, addedAt: new Date().toISOString() });
    persist();
}

export function revokeForever(key: string): void {
    const before = always.length;
    always = always.filter(a => a.key !== key);
    if (always.length !== before) persist();
}

export function refuse(key: string): void {
    refused.set(key, Date.now() + DENY_COOLDOWN_MS);
    // A refusal beats a live temporary grant. Saying no has to mean no now, not
    // no once the clock you already started happens to run out.
    temporary.delete(key);
}

/** Milliseconds left on a refusal cooldown, or 0 when there is none. */
export function refusedFor(key: string): number {
    const until = refused.get(key);
    if (until === undefined) return 0;
    if (until > Date.now()) return until - Date.now();
    refused.delete(key);
    return 0;
}

/**
 * Drops every temporary grant and every cooldown.
 *
 * Called when the access mode changes, because a grant is consent given under
 * one set of rules and the rules just moved. Switching to "off" and back to
 * "ask" must not silently restore an hour of access you agreed to before.
 */
export function clearSession(): void {
    temporary.clear();
    refused.clear();
}
