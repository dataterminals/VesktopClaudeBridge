#!/usr/bin/env node
/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Typechecks the plugin half, which nothing in this repo can otherwise compile.
 *
 * The sidecar's tsconfig covers `sidecar/src` and nothing else, so `npm run
 * typecheck` is silent about every file under plugin/ -- and those files import
 * `@webpack/common`, which only resolves inside an Equicord checkout. The two
 * halves genuinely do build in different trees; that is the standing cost of a
 * userplugin, not something a path alias fixes.
 *
 * So this copies the plugin in the way install-plugin.ps1 does and runs
 * Equicord's own tsc over it. That config is stricter than the sidecar's in ways
 * that matter: it caught an empty array literal widening to never[] on the last
 * plugin change, a real error the sidecar build could not see.
 *
 * Equicord's tree has pre-existing errors of its own (it runs with
 * skipLibCheck: false), so tsc's exit code is not usable as a verdict. Only
 * diagnostics naming our own folder count, which is also why this cannot just be
 * a line in package.json.
 *
 * The copies are left in place afterwards. That is deliberate: it means a
 * typecheck also stages the plugin for the next -Build, rather than leaving the
 * checkout holding a half-updated copy of it.
 *
 *   npm run typecheck:plugin -- --equicord=D:/Equicord
 *   EQUICORD_PATH=D:/Equicord npm run typecheck:plugin
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR_NAME = "vesktopClaudeBridge";
const COPIED_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function equicordPath() {
    const flag = process.argv.slice(2).find(a => a.startsWith("--equicord="));
    const wanted = flag ? flag.slice("--equicord=".length) : process.env.EQUICORD_PATH;

    if (!wanted) {
        console.error(
            "Where is your Equicord checkout? Pass it, or set EQUICORD_PATH:\n" +
                "  npm run typecheck:plugin -- --equicord=D:/Equicord\n" +
                "The README's install step clones it to D:/Equicord."
        );
        process.exit(2);
    }

    const path = resolve(wanted);
    if (!existsSync(join(path, "src"))) {
        console.error(`No src/ under ${path} -- that does not look like an Equicord checkout.`);
        process.exit(2);
    }
    return path;
}

const equicord = equicordPath();

// shared/protocol.ts is the source of truth and plugin/protocol.ts is a
// gitignored copy of it, so a stale copy would typecheck the wrong file.
const synced = spawnSync(process.execPath, [join(root, "scripts", "sync-protocol.mjs")], {
    stdio: "inherit"
});
if (synced.status !== 0) {
    console.error("protocol sync failed");
    process.exit(1);
}

const target = join(equicord, "src", "userplugins", PLUGIN_DIR_NAME);
mkdirSync(target, { recursive: true });

const source = join(root, "plugin");
let copied = 0;
for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !COPIED_EXTENSIONS.has(extname(entry.name))) continue;
    copyFileSync(join(source, entry.name), join(target, entry.name));
    copied++;
}
console.error(`copied ${copied} file(s) -> ${target}`);

/*
 * shell:true because this is npx on Windows more often than not, and one string
 * rather than an argv array because passing both trips DEP0190 -- the arguments
 * are concatenated into the shell line anyway, so the array only looks safer
 * than it is. Nothing here comes from user input.
 *
 * Output is captured rather than inherited because filtering it is the whole
 * point below.
 */
const tsc = spawnSync("npx tsc --noEmit -p tsconfig.json", {
    cwd: equicord,
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
});

if (tsc.error) {
    console.error(`could not run tsc in ${equicord}:`, tsc.error.message);
    process.exit(1);
}

const output = `${tsc.stdout ?? ""}${tsc.stderr ?? ""}`;
const ours = output
    .split(/\r?\n/)
    .filter(line => line.includes(PLUGIN_DIR_NAME));

if (ours.length) {
    console.error(`\n${ours.length} diagnostic(s) in ${PLUGIN_DIR_NAME}:\n`);
    console.error(ours.join("\n"));
    process.exit(1);
}

/*
 * tsc exiting non-zero with nothing of ours in the output is the normal case,
 * not a problem: Equicord's own tree does not typecheck clean. Said out loud
 * anyway, because "0 errors" and "plenty of errors, none of them yours" look
 * identical from here and only one of them means tsc actually ran.
 */
const total = output.split(/\r?\n/).filter(line => /error TS\d+/.test(line)).length;
console.error(
    total
        ? `\nclean: 0 of Equicord's ${total} diagnostic(s) are in ${PLUGIN_DIR_NAME}.`
        : `\nclean: tsc reported no errors at all.`
);
