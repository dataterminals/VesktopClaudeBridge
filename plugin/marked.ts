/*
 * VesktopClaudeBridge — Equicord/Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The mark queue.
 *
 * This is the feature the whole plugin is really for. "Read the logs" normally
 * costs a round-trip of *which* logs, where, how far back — marking collapses
 * that into one right-click, and the model just reads what was pointed at.
 *
 * Marks are pulled, never pushed: MCP gives a server no way to wake a model up,
 * so the queue simply waits until something asks for it.
 */

import * as DataStore from "@api/DataStore";

import type { MarkedItem } from "./protocol";

const STORE_KEY = "VesktopClaudeBridge_marks";
const MAX_ITEMS = 50;

let items: MarkedItem[] = [];
let nextId = 1;

/** Restores marks made before the last Ctrl+R. Best effort — never throws. */
export async function loadMarks(): Promise<void> {
    try {
        const saved = await DataStore.get<MarkedItem[]>(STORE_KEY);
        if (Array.isArray(saved) && saved.length) {
            items = saved.slice(-MAX_ITEMS);
            nextId = Math.max(...items.map(i => i.markId)) + 1;
        }
    } catch (err) {
        console.warn("[VesktopClaudeBridge] could not restore marks:", err);
    }
}

function persist(): void {
    void DataStore.set(STORE_KEY, items).catch(err =>
        console.warn("[VesktopClaudeBridge] could not persist marks:", err)
    );
}

export function addMark(item: Omit<MarkedItem, "markId" | "markedAt">): MarkedItem {
    const entry: MarkedItem = {
        ...item,
        markId: nextId++,
        markedAt: new Date().toISOString()
    };
    items.push(entry);
    if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS);
    persist();
    return entry;
}

export function listMarks(consume: boolean): MarkedItem[] {
    const snapshot = items.slice();
    if (consume) {
        items = [];
        persist();
    }
    return snapshot;
}

export function clearMarks(markId?: number): number {
    const before = items.length;
    items = markId == null ? [] : items.filter(i => i.markId !== markId);
    persist();
    return before - items.length;
}

export function markCount(): number {
    return items.length;
}
