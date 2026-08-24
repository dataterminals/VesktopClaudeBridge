/*
 * VesktopClaudeBridge — Equicord/Vencord userplugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The permanently-allowed DM list, rendered inside plugin settings.
 *
 * This exists because of where the list is stored. "Always allow" writes to
 * DataStore (IndexedDB, per-install) rather than to plugin settings, so that a
 * record of who you DM never rides along with Vencord's cloud settings sync —
 * the same reasoning that keeps the bridge token in localStorage, spelled out
 * at the top of settings.ts.
 *
 * The cost of storing it out there is that Vencord's settings UI cannot render
 * it for free, which is precisely how a permission you granted once becomes a
 * permission you can no longer find. So this draws it: what is allowed, when you
 * agreed to it, and a revoke button for each. A grant with no visible way back
 * is not a grant, it is a change of default.
 *
 * Plain elements and Discord's own CSS variables rather than Vencord's form
 * components, most of which are deprecated in this tree and are being moved
 * around. Nothing here is worth a rebuild over a renamed export.
 */

import { Button, React, useState } from "@webpack/common";

import { alwaysAllowed, LISTING_KEY, revokeForever } from "./dmLedger";

/** "3 days ago", for a list whose whole job is to make old grants conspicuous. */
function ago(iso: string): string {
    const at = new Date(iso).getTime();
    if (Number.isNaN(at)) return "at an unknown time";

    const ms = Math.max(0, Date.now() - at);
    if (ms < 60_000) return "just now";
    if (ms < 3_600_000) {
        const n = Math.round(ms / 60_000);
        return `${n} minute${n === 1 ? "" : "s"} ago`;
    }
    if (ms < 86_400_000) {
        const n = Math.round(ms / 3_600_000);
        return `${n} hour${n === 1 ? "" : "s"} ago`;
    }
    const n = Math.round(ms / 86_400_000);
    return `${n} day${n === 1 ? "" : "s"} ago`;
}

export function DmAllowList() {
    // The ledger is a module, not a store, so nothing re-renders on its own.
    // A counter is enough: the list is re-read from the ledger on every render,
    // so bumping this is the whole of "refresh".
    const [tick, setTick] = useState(0);
    const entries = alwaysAllowed();

    return (
        <div style={{ marginBottom: 20 }} data-tick={tick}>
            <div
                style={{
                    color: "var(--header-primary)",
                    fontSize: 16,
                    fontWeight: 600,
                    marginBottom: 4
                }}
            >
                Permanently allowed DMs
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 8 }}>
                Conversations you picked <strong>Always allow</strong> for. These skip the
                confirmation prompt until you revoke them here. They are stored on this machine
                only and are never uploaded by settings sync. Switching <strong>DM access</strong>{" "}
                to <strong>Off</strong> overrides every one of them.
            </div>

            {entries.length === 0 ? (
                <div style={{ color: "var(--text-muted)", fontSize: 14, fontStyle: "italic" }}>
                    Nothing is permanently allowed. Every DM will ask first.
                </div>
            ) : (
                entries.map(entry => (
                    <div
                        key={entry.key}
                        style={{
                            alignItems: "center",
                            background: "var(--background-secondary)",
                            borderRadius: 4,
                            display: "flex",
                            gap: 8,
                            justifyContent: "space-between",
                            marginBottom: 4,
                            padding: "8px 12px"
                        }}
                    >
                        <div style={{ minWidth: 0 }}>
                            <div style={{ color: "var(--text-normal)", fontSize: 14 }}>
                                {entry.key === LISTING_KEY ? "Your DM list (all of it)" : entry.label}
                            </div>
                            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                                allowed {ago(entry.addedAt)}
                            </div>
                        </div>
                        <Button
                            size={Button.Sizes.SMALL}
                            color={Button.Colors.RED}
                            onClick={() => {
                                revokeForever(entry.key);
                                setTick(n => n + 1);
                            }}
                        >
                            Revoke
                        </Button>
                    </div>
                ))
            )}
        </div>
    );
}
