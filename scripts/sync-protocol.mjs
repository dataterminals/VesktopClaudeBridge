#!/usr/bin/env node
/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copies shared/protocol.ts into both halves of the project.
 *
 * The two halves build in completely different trees — the sidecar builds here,
 * the plugin builds inside your Equicord checkout — so neither can reach a
 * shared/ folder by relative path. Rather than a package or a path alias, we
 * copy. The copies are gitignored and regenerated on every build.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "shared", "protocol.ts");

const targets = [
    join(root, "sidecar", "src", "protocol.ts"),
    join(root, "plugin", "protocol.ts")
];

const banner = `// GENERATED FILE — DO NOT EDIT.
// Copied from shared/protocol.ts by scripts/sync-protocol.mjs.
// Edit the original and re-run \`npm run sync\` from the repo root.

`;

const body = readFileSync(source, "utf8");

for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, banner + body, "utf8");
    console.error(`synced -> ${target.slice(root.length + 1)}`);
}
