#!/usr/bin/env node
/*
 * VesktopClaudeBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * End-to-end smoke test for the sidecar, with a fake plugin standing in for
 * Discord. Boots the real process, does the real handshake, answers real RPCs
 * with fixture data, and checks what comes back out of the HTTP api.
 *
 * Covers the things that are easy to get wrong and invisible until you're
 * debugging live: token rejection, origin rejection, code fences surviving the
 * formatter, and the DM guard actually refusing.
 *
 *   node test/smoke.mjs
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect as tcpConnect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// The age buckets are pure and the suite always runs after a build, so they get
// checked directly rather than inferred from rendered output — a fixture can
// only ever pin one bucket, and pinning the rest would mean asserting the
// formatter against itself.
import { markAge } from "../dist/format.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const WS_PORT = 8899;
const HTTP_PORT = 8900;
const TOKEN = "smoke-test-token-not-a-real-secret";
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

// A second sidecar with the DM guard opened, so one run covers both sides of
// `denyDms`. Two processes rather than a restart: the config is read once at
// boot, and a half-configured sidecar is not a state worth being able to reach.
const WS_PORT_DM = 8901;
const HTTP_PORT_DM = 8902;
const BASE_DM = `http://127.0.0.1:${HTTP_PORT_DM}`;

const workDir = mkdtempSync(join(tmpdir(), "vcb-smoke-"));
const workDirDm = mkdtempSync(join(tmpdir(), "vcb-smoke-dm-"));

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
    if (condition) {
        passed++;
        console.log(`  ok   ${name}`);
    } else {
        failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
        console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

// --- fixtures --------------------------------------------------------------

const CHANNEL = {
    id: "2000", name: "modding-help", type: 0, topic: null,
    guildId: "1000", parentId: null, isThread: false, isDm: false
};

const DM_CHANNEL = { ...CHANNEL, id: "2999", name: "dm:bob", type: 1, guildId: null, isDm: true };

const OTHER_CHANNEL = { ...CHANNEL, id: "2001", name: "tech-support" };

const GUILD = { id: "1000", name: "Test Server" };

const user = (id, name) => ({ id, username: name, displayName: name, bot: false });

const MESSAGES = [
    {
        id: "3001", channelId: "2000", guildId: "1000", author: user("9001", "Avery"),
        timestamp: "2026-08-01T14:31:02.000Z", editedTimestamp: null,
        content: "did the pak actually load", replyTo: null,
        attachments: [], embeds: [], reactions: [], pinned: false,
        link: "https://discord.com/channels/1000/2000/3001"
    },
    {
        id: "3002", channelId: "2000", guildId: "1000", author: user("9002", "Bob"),
        timestamp: "2026-08-01T14:32:40.000Z", editedTimestamp: null,
        // A fenced log, which is the whole reason this project exists.
        content: "nope:\n```\n[2026.08.01-14.32.55:123][  0]LogUE4SS: mod folder not found\n```",
        replyTo: { id: "3001", author: "Avery", excerpt: "did the pak actually load", unresolved: false },
        attachments: [{
            id: "4001", filename: "UE4SS.log", size: 44236, contentType: "text/plain",
            url: "https://cdn.discordapp.com/attachments/2000/4001/UE4SS.log", likelyText: true
        }],
        embeds: [], reactions: [{ emoji: "👍", count: 2, me: false }], pinned: false,
        link: "https://discord.com/channels/1000/2000/3002"
    }
];

// Search hits are scattered rather than contiguous: two channels, years apart,
// and a total far larger than the page, so paging and grouping both get tested.
const SEARCH_HITS = [
    { message: MESSAGES[1], channel: CHANNEL },
    {
        message: {
            ...MESSAGES[0], id: "3500", channelId: "2001",
            timestamp: "2024-02-11T09:18:05.000Z",
            content: "old mention of the pak loader"
        },
        channel: OTHER_CHANNEL
    }
];

const THIRD_EYE_STATE = {
    watching: true, guild: GUILD, channel: CHANNEL,
    since: "2026-08-01T14:00:00.000Z", expiresAt: "2026-08-01T18:00:00.000Z",
    pending: 2, notablePending: 1, seen: 412, matched: 7, dropped: 2
};

const LIVE = [
    { message: MESSAGES[0], notable: false, reason: null },
    { message: MESSAGES[1], notable: true, reason: "mention" }
];

// The same traffic as seen inside a DM, where the plugin marks everything
// notable: a one-to-one has no ambient tier, so nothing would ever fire the
// mention/reply/term rules and the notable-only hook would stay silent.
const DM_MESSAGES = MESSAGES.map(m => ({
    ...m,
    channelId: DM_CHANNEL.id,
    guildId: null,
    link: `https://discord.com/channels/@me/${DM_CHANNEL.id}/${m.id}`
}));

const DM_THIRD_EYE_STATE = {
    ...THIRD_EYE_STATE, guild: null, channel: DM_CHANNEL, pending: 2, notablePending: 2
};

const DM_LIVE = DM_MESSAGES.map(message => ({ message, notable: true, reason: "dm" }));

// --- fake plugin -----------------------------------------------------------

function fakePlugin({ token = TOKEN, origin = "https://discord.com", wsPort = WS_PORT, dm = false } = {}) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`, { origin });
        const closes = [];
        // Params the sidecar actually put on the wire, per method.
        const received = {};

        socket.on("open", () => {
            socket.send(JSON.stringify({
                t: "hello", protocol: 1, token,
                user: user("9001", "Avery"), pluginVersion: "0.1.0-test"
            }));
        });

        socket.on("message", raw => {
            const frame = JSON.parse(raw.toString());

            if (frame.t === "hello-ok") return resolve({ socket, closes, received });

            if (frame.t === "req") {
                const answer = data => socket.send(JSON.stringify({ t: "res", id: frame.id, ok: true, data }));
                received[frame.method] = frame.params;

                switch (frame.method) {
                    case "history":
                        return answer({ channel: CHANNEL, messages: MESSAGES });
                    case "current_view":
                        return answer({
                            guild: GUILD, channel: CHANNEL, messages: MESSAGES,
                            capturedAt: "2026-08-01T14:36:00.000Z", fromCache: true
                        });
                    case "marked.list":
                        // Both marks sit in DM_CHANNEL so the existing scope-guard
                        // assertions still hold. The stamps are pinned like every
                        // other fixture here: a pinned past instant is permanently
                        // in the "N days ago" bucket and permanently stale, which
                        // makes the age assertions below true forever. The sub-day
                        // buckets are checked directly against markAge() instead,
                        // with an injected clock.
                        return answer({ items: [
                            {
                                markId: 1, markedAt: "2026-08-01T14:36:10.000Z", note: "last 2",
                                guild: GUILD, channel: DM_CHANNEL, messages: MESSAGES
                            },
                            {
                                markId: 2, markedAt: "2026-08-01T15:02:00.000Z", note: null,
                                guild: GUILD, channel: DM_CHANNEL, messages: MESSAGES
                            }
                        ] });
                    case "marked.clear":
                        return answer({ cleared: frame.params?.markId ? 1 : 2 });
                    case "guilds":
                        return answer({ guilds: [GUILD] });
                    case "third_eye.state":
                        return answer(dm ? DM_THIRD_EYE_STATE : THIRD_EYE_STATE);
                    case "third_eye.drain": {
                        const buffer = dm ? DM_LIVE : LIVE;
                        return answer({
                            state: dm ? DM_THIRD_EYE_STATE : THIRD_EYE_STATE,
                            messages: frame.params?.notableOnly
                                ? buffer.filter(m => m.notable)
                                : buffer,
                            dropped: 2
                        });
                    }
                    case "search":
                        return answer({
                            guild: GUILD, totalResults: 385, hits: SEARCH_HITS,
                            offset: frame.params?.offset ?? 0, indexing: false
                        });
                    default:
                        return socket.send(JSON.stringify({
                            t: "res", id: frame.id, ok: false,
                            error: { code: "internal", message: `fixture missing for ${frame.method}` }
                        }));
                }
            }
        });

        socket.on("close", code => {
            closes.push(code);
            reject(new Error(`socket closed with ${code}`));
        });
        socket.on("error", err => reject(err));
    });
}

const getFrom = (base, path, token = TOKEN) =>
    fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

const get = (path, token = TOKEN) => getFrom(BASE, path, token);

// --- run -------------------------------------------------------------------

let stderr = "";

/*
 * `mcp: true` is what makes a sidecar an election candidate. A --no-mcp sidecar
 * that finds an owner exits 3 immediately, so it can never be the process that
 * takes over; only one with an MCP client attached sticks around as a proxy.
 * stdin is piped so the stdio transport has something to hold open, and stdout
 * is ignored rather than inherited so JSON-RPC framing doesn't interleave with
 * this suite's own ok/FAIL lines.
 */
function spawnSidecar({ wsPort, httpPort, dir, env = {}, mcp = false }) {
    const proc = spawn(process.execPath, mcp ? ["dist/index.js"] : ["dist/index.js", "--no-mcp"], {
        cwd: ROOT,
        env: {
            ...process.env,
            VCB_PORT: String(wsPort),
            VCB_HTTP_PORT: String(httpPort),
            VCB_TOKEN: TOKEN,
            VCB_CONFIG_DIR: dir,
            VCB_DOWNLOAD_DIR: join(dir, "downloads"),
            VCB_LOG_LEVEL: "warn",
            // Pinned, or every stamp assertion below reads differently depending
            // on which machine runs the suite. The rendering default is the
            // host's own zone, which is right for a user and useless for a test.
            VCB_TIMEZONE: "UTC",
            ...env
        },
        stdio: mcp ? ["pipe", "ignore", "pipe"] : ["ignore", "inherit", "pipe"]
    });
    // Per-process as well as shared. The election checks below assert on which
    // sidecar said what — "pid N won the bridge" is only meaningful if you know
    // it came from the process that lost — and one merged buffer cannot answer
    // that. The shared one stays because it is what gets dumped on a blow-up.
    proc.said = "";
    proc.stderr.on("data", d => { stderr += d.toString(); proc.said += d.toString(); });
    return proc;
}

const child = spawnSidecar({ wsPort: WS_PORT, httpPort: HTTP_PORT, dir: workDir });
const childDm = spawnSidecar({
    wsPort: WS_PORT_DM,
    httpPort: HTTP_PORT_DM,
    dir: workDirDm,
    // Also carries a non-UTC zone, so one run covers both sides of the rendering
    // timezone as well. The fixtures are stamped in August, so America/New_York
    // is EDT and every stamp here should land exactly four hours behind the
    // primary sidecar's UTC — which is the whole point of the setting.
    env: { VCB_DENY_DMS: "0", VCB_TIMEZONE: "America/New_York" }
});

/*
 * The re-election candidates, spawned late so they can't win the first bind.
 * Held at module scope purely so cleanup() can reach them: a promoted candidate
 * outlives this run holding both primary ports and breaks the next invocation of
 * the suite. Same for the squatter — a leaked listener on WS_PORT is worse, since
 * nothing in the next run would even be able to name what is holding it.
 */
const candidates = [];
let squatter = null;
let standIn = null;

/** A pid no real process here will have, so "who won" is unambiguous. */
const STANDIN_PID = 999_999;

/** A sidecar racing for the primary ports. `level` is how much stderr it owes. */
function spawnCandidate(level = "info") {
    const proc = spawnSidecar({
        wsPort: WS_PORT, httpPort: HTTP_PORT, dir: workDir, mcp: true,
        env: { VCB_LOG_LEVEL: level }
    });
    candidates.push(proc);
    return proc;
}

function cleanup(code) {
    child.kill();
    childDm.kill();
    for (const proc of candidates) proc.kill();
    try { squatter?.close(); } catch { /* already closed */ }
    try { standIn?.close(); } catch { /* already closed */ }
    for (const dir of [workDir, workDirDm]) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ }
    }
    process.exit(code);
}

/** Polls a predicate to a deadline. Returns whether it ever came true. */
async function waitFor(pred, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (pred()) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(r => setTimeout(r, 100));
    }
}

/**
 * Waits for one of `pids` to start answering /status as the owner.
 *
 * Every term in the default budget is real: up to 5s before a proxy's poll
 * notices the death, 750ms for the confirming probe, up to 250ms of bind jitter,
 * the bind itself, and up to 5 x 300ms of http bind retry if the dead owner's
 * port is slow to release. 25s leaves room for all of it on a loaded machine.
 */
async function waitForPromotion(pids, attempts = 100) {
    for (let i = 0; i < attempts; i++) {
        await new Promise(r => setTimeout(r, 250));
        try {
            const res = await get("/status");
            if (res.status !== 200) continue;
            const body = await res.json();
            if (pids.includes(body.owner?.pid)) return body.owner.pid;
        } catch { /* nobody is serving the port during the handover */ }
    }
    return null;
}

/**
 * Holds `port` against the sidecar, retrying until the dying owner lets go.
 *
 * A plain TCP listener is enough to fail a bind with EADDRINUSE; it never has to
 * speak websocket, and it holds nothing but that one port. What a candidate then
 * finds on the http port is a separate question, which is the point — the two
 * are what `standDown()` branches on.
 */
async function grabPort(server, port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const got = await new Promise(resolve => {
            const onError = () => resolve(false);
            server.once("error", onError);
            server.listen(port, "127.0.0.1", () => {
                server.removeListener("error", onError);
                resolve(true);
            });
        });
        if (got) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(r => setTimeout(r, 10));
    }
}

/**
 * A stand-in owner that refuses everything until it is being polled hard.
 *
 * Reaching `standDown()`'s found-a-winner branch needs an ordering, not just a
 * fake owner: miss, miss, attempt, lose the bind, and only *then* find somebody
 * serving http. Parking a plain fake on the http port produces none of it — the
 * candidate's 5s probe gets an answer, decides the owner is fine, and never
 * attempts a bind at all. That was this test's first shape and it asserted
 * nothing.
 *
 * Racing two real sidecars for it does not work either. The winner's http mirror
 * is up within ~15ms of its bind, so a loser whose confirming probe lands in
 * that window correctly concludes nothing is wrong and stays put; measured at
 * roughly one run in seven, which is a flaky test rather than a race worth
 * asserting on.
 *
 * The one thing observable from outside the process is the *rate*. Every caller
 * here fails instantly (the socket is destroyed, which is what a dead owner
 * looks like), so arrivals are: 5000ms apart for the status poll, 750ms after a
 * miss for the confirming probe, and 250ms apart once `waitForOwner()` is
 * looping. Nothing but the loser's own lookup arrives twice inside 400ms, so
 * arming on that is arming inside the window, by construction.
 */
function startStandIn(pid) {
    let lastAt = 0;
    let armed = false;

    const server = createHttpServer((req, res) => {
        const now = Date.now();
        if (!armed && now - lastAt < 400) armed = true;
        lastAt = now;

        // A destroyed socket is what `findOwner` and `probe` see from a dead
        // owner: a connection error, immediately, with nothing to parse.
        if (!armed) return req.socket.destroy();

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            connected: false, user: null, pluginVersion: null, connectedSince: null,
            port: WS_PORT, owner: { pid, since: new Date().toISOString() }
        }));
    });
    return new Promise(resolve => server.listen(HTTP_PORT, "127.0.0.1", () => resolve(server)));
}

/**
 * A stand-in owner that can be flipped from answering to rejecting.
 *
 * The token-mismatch case has no other way in: the real sidecar mints one token
 * per config dir, so two of ours always agree, and disagreeing needs a peer that
 * answers `/status` with a 401 while a candidate is already attached to it.
 */
function startRejectingStandIn(pid) {
    let rejecting = false;

    const server = createHttpServer((req, res) => {
        if (rejecting) {
            res.writeHead(401, { "content-type": "text/plain" });
            return res.end("unauthorized\n");
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            connected: false, user: null, pluginVersion: null, connectedSince: null,
            port: WS_PORT, owner: { pid, since: new Date().toISOString() }
        }));
    });

    return new Promise(resolve =>
        server.listen(HTTP_PORT, "127.0.0.1", () =>
            resolve({ server, startRejecting: () => { rejecting = true; } })
        )
    );
}

/** Is anything accepting connections on the websocket port yet? */
async function waitForWsOwner(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const held = await new Promise(resolve => {
            const sock = tcpConnect({ port: WS_PORT, host: "127.0.0.1" });
            sock.once("connect", () => { sock.destroy(); resolve(true); });
            sock.once("error", () => resolve(false));
        });
        if (held) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(r => setTimeout(r, 250));
    }
}

async function waitForPort(base = BASE, attempts = 50) {
    for (let i = 0; i < attempts; i++) {
        try {
            await getFrom(base, "/status");
            return true;
        } catch {
            await new Promise(r => setTimeout(r, 100));
        }
    }
    return false;
}

try {
    if (!(await waitForPort())) {
        console.error("sidecar never came up. stderr:\n" + stderr);
        cleanup(1);
    }

    console.log("\nauth");
    check("no token is rejected", (await get("/status", null)).status === 401);
    check("wrong token is rejected", (await get("/status", "nope")).status === 401);
    check("right token is accepted", (await get("/status")).status === 200);

    console.log("\nbefore a plugin connects");
    const cold = await get("/current-view");
    check("reads fail with 503", cold.status === 503);
    check("and say why", (await cold.text()).includes("no_client"));

    console.log("\nhandshake");
    await check2("bad origin is refused", async () => {
        try {
            await fakePlugin({ origin: "https://evil.example" });
            return false;
        } catch {
            return true;
        }
    });
    await check2("bad token is refused", async () => {
        try {
            await fakePlugin({ token: "wrong" });
            return false;
        } catch {
            return true;
        }
    });

    const { socket, received } = await fakePlugin();
    check("good handshake connects", socket.readyState === WebSocket.OPEN);

    const status = await (await get("/status")).json();
    check("status reports connected", status.connected === true);
    check("status reports the account", status.user?.displayName === "Avery");
    // What "already running" has to be able to name. Without it the only advice
    // a second sidecar can give is "something else has it", which is useless.
    check("status identifies the owning process", status.owner?.pid === child.pid);
    check("and when it came up", typeof status.owner?.since === "string");

    console.log("\ntranscript");
    const view = await (await get("/current-view")).text();
    check("has a header", view.includes("#modding-help") && view.includes("Test Server"));
    check("has the id range for paging", view.includes("ids 3001 → 3002"));
    check("renders a one-liner", view.includes("[14:31:02] Avery: did the pak actually load"));
    check("shows the reply target", view.includes("↳ replying to Avery"));
    check("lists the attachment", view.includes("UE4SS.log") && view.includes("43.2 KB"));
    check("shows reactions", view.includes("👍 2"));
    check(
        "code fence survives unindented",
        view.includes("\n```\n[2026.08.01-14.32.55:123][  0]LogUE4SS: mod folder not found\n```"),
        "fence was indented or mangled"
    );
    check("names the zone the stamps are in", view.includes("times in UTC"));
    check("omits per-message ids by default", !view.includes("⟨3001⟩"));
    check("ids=1 adds them back", (await (await get("/current-view?ids=1")).text()).includes("⟨3001⟩"));

    console.log("\nscope guard");
    const marked = await get("/marked");
    check("DM content is refused", marked.status === 403, `got ${marked.status}`);
    check("and names the setting", (await marked.text()).includes("denyDms"));

    // The regression test for the one that actually lost data: asking the plugin
    // to consume empties the queue BEFORE the sidecar renders, so a single
    // out-of-scope mark used to destroy everything the user had marked and hand
    // back an error. The read must never ask the plugin to consume, and a refused
    // read must clear nothing at all.
    const markedConsume = await get("/marked?consume=1");
    check("a refused read is still refused with consume=1", markedConsume.status === 403, `got ${markedConsume.status}`);
    check("a refused read never asked the plugin to consume", received["marked.list"]?.consume === false);
    check("a refused read does not empty the queue", received["marked.clear"] === undefined);

    console.log("\nscope guard, opened (denyDms: false)");
    if (!(await waitForPort(BASE_DM))) {
        check("the second sidecar came up", false, "it never started");
    } else {
        const { received: receivedDm } = await fakePlugin({ wsPort: WS_PORT_DM, dm: true });

        const markedDm = await getFrom(BASE_DM, "/marked");
        check("the same DM content is served", markedDm.status === 200, `got ${markedDm.status}`);
        const markedDmBody = await markedDm.text();
        check("and carries the body", markedDmBody.includes("did the pak actually load"));

        // The fixture stamps are pinned in the past, so these two are true
        // forever: every run is some number of days after August 2026.
        check("mark headers lead with a relative age", /### mark \d+ · ⚠ \d+ days? ago · 2026-08-01 /.test(markedDmBody));
        check("the queue preamble counts them", markedDmBody.includes("── 2 marks · newest "));
        check("stale marks are called out", markedDmBody.includes("not from the current session"));
        check("and the callout names the way out", markedDmBody.includes("consume=true"));
        check("the note survives the http path", markedDmBody.includes("note: last 2"));
        // Same rule as the transcript stamps: rendered in the configured zone,
        // with no UTC clock left lying around to be misread as local.
        check("mark stamps render in the configured zone", markedDmBody.includes("2026-08-01 10:36:10"));
        check("and leave no UTC mark clock behind", !markedDmBody.includes("14:36:10"));

        const markedDmConsume = await getFrom(BASE_DM, "/marked?consume=1");
        check("an allowed read with consume=1 is served", markedDmConsume.status === 200, `got ${markedDmConsume.status}`);
        check("and still never asked the plugin to consume", receivedDm["marked.list"]?.consume === false);
        // Cleared per rendered id rather than wholesale, so a mark made during
        // the round trip survives. The fake records the last call it saw.
        check("and clears what it actually rendered", receivedDm["marked.clear"]?.markId === 2);

        // The counterpart to the plugin marking every DM message notable. If that
        // tier were empty in a DM, the buffer would still fill and this hook would
        // still run -- and print nothing, which is indistinguishable from a watch
        // that never armed. So pin that notable-only is non-empty here.
        const liveDm = await getFrom(BASE_DM, "/live?notableOnly=1");
        check("a notable-only DM drain is served", liveDm.status === 200, `got ${liveDm.status}`);
        const liveDmBody = await liveDm.text();
        check("and is not empty", liveDmBody.includes("did the pak actually load"));
        check("and names the DM it came from", liveDmBody.includes("dm:bob"));

        // The fixture instant is 14:31:02Z. Rendered in America/New_York in
        // August that is 10:31:02, and the UTC clock must not survive anywhere
        // in the output — a stamp that renders correctly while the old one
        // lingers in a header is the same bug wearing a hat.
        check("renders stamps in the configured zone", liveDmBody.includes("2026-08-01 10:31:02"));
        check("and leaves no UTC clock behind", !liveDmBody.includes("14:31:02"));
        check("and says which zone that was", liveDmBody.includes("times in America/New_York"));
    }

    console.log("\nhistory anchors");
    // Discord ignores `before` when `after` is present, so the plugin enforces the
    // far bound itself. That enforcement can only be checked against a live client,
    // but the sidecar dropping either anchor on the way through would break it just
    // as silently — so pin that both actually reach the plugin.
    await get("/history?channelId=2000&after=3000&before=3100&limit=50");
    check("forwards `after` to the plugin", received.history?.after === "3000");
    check("forwards `before` alongside it", received.history?.before === "3100");
    check("does not silently drop one anchor", !!received.history?.after && !!received.history?.before);

    console.log("\nrpc passthrough (how a second sidecar borrows this one)");
    const rpcOk = await fetch(BASE + "/rpc", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ method: "guilds", params: {} })
    });
    const rpcBody = await rpcOk.json();
    check("proxies a call to the plugin", rpcBody.ok === true && rpcBody.data?.guilds?.[0]?.name === "Test Server");

    const rpcBad = await fetch(BASE + "/rpc", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ params: {} })
    });
    check("rejects a call with no method", rpcBad.status === 400);

    const rpcNoAuth = await fetch(BASE + "/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "guilds", params: {} })
    });
    // Same gate as everything else here - the passthrough is raw, so this matters more.
    check("rpc is behind the token too", rpcNoAuth.status === 401);

    const rpcErr = await fetch(BASE + "/rpc", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        // Not in the fixture, so the fake plugin answers with an RpcError.
        body: JSON.stringify({ method: "channels", params: { guildId: "1000" } })
    });
    const errBody = await rpcErr.json();
    check(
        "carries a plugin error back to the proxy",
        errBody.ok === false && !!errBody.error?.code,
        JSON.stringify(errBody).slice(0, 80)
    );

    console.log("\nthird eye");
    const live = await (await get("/live")).text();
    check("names the watched channel", live.includes("#modding-help"));
    check("surfaces the gap rather than swallowing it", live.includes("2 message(s) fell out"));
    check("stamps live lines with the date", live.includes("[2026-08-01 14:31:02]"));
    check("code fence survives the live path", live.includes("\n```\n[2026.08.01-14.32.55:123][  0]LogUE4SS: mod folder not found\n```"));
    // The hook runs on every keystroke-submitted message; a chatty default gets it disabled.
    check("consumes by default so the hook doesn't repeat itself", received["third_eye.drain"]?.consume === true);
    check("notableOnly is forwarded", (await get("/live?notableOnly=1")).status === 200 && received["third_eye.drain"]?.notableOnly === true);

    const teState = await (await get("/third-eye")).json();
    check("state exposes the volume counters", teState.seen === 412 && teState.matched === 7);

    console.log("\nsearch");
    const search = await (await get("/search?guildId=1000&content=pak")).text();
    check("reports the match count", search.includes("of 385"));
    check("groups hits under their channel", search.includes("── #modding-help") && search.includes("── #tech-support"));
    check(
        "stamps hits with the date, not just a clock",
        search.includes("[2024-02-11 09:18:05]"),
        "search spans years, so a bare time is ambiguous"
    );
    check("keeps ids so a hit can be followed up", search.includes("⟨3500⟩"));
    check("says how to get the next page", search.includes("offset=2"));
    check("code fence still survives", search.includes("\n```\n[2026.08.01-14.32.55:123][  0]LogUE4SS: mod folder not found\n```"));

    const dmSearch = await get("/search?content=pak");
    check("searching without a guild hits the DM guard", dmSearch.status === 403, `got ${dmSearch.status}`);
    check("and names the setting", (await dmSearch.text()).includes("denyDms"));

    const searchJson = await (await get("/search?guildId=1000&content=pak&json=1")).json();
    check("json mode returns hits with their channels", searchJson.hits?.[1]?.channel?.name === "tech-support");
    check("json mode carries the total", searchJson.totalResults === 385);

    console.log("\njson mode");
    const json = await (await get("/current-view?json=1")).json();
    check("returns objects", Array.isArray(json.messages) && json.messages.length === 2);
    check("keeps content verbatim", json.messages[1].content.includes("LogUE4SS"));

    console.log("\nmark ages");
    // The sub-day buckets can't be pinned into a fixture without asserting the
    // formatter against itself, so they're checked directly with an injected now.
    const NOW = Date.parse("2026-08-09T12:00:00.000Z");
    const ago = (ms) => markAge(new Date(NOW - ms).toISOString(), "UTC", NOW);
    check("seconds read as just now", ago(30_000).label === "just now");
    check("minutes read as minutes", ago(4 * 60_000).label === "4 minutes ago");
    check("one minute is not pluralised", ago(61_000).label === "1 minute ago");
    check("hours read as hours", ago(3 * 3_600_000).label === "3 hours ago");
    check("days read as days", ago(3 * 86_400_000).label === "3 days ago");
    check("a fresh mark is not stale", ago(4 * 60_000).stale === false);
    check("six hours old is stale even on the same day", ago(6 * 3_600_000).stale === true);
    check("an unparseable stamp is stale, not dropped", markAge("not a date", "UTC", NOW).stale === true);
    check("and says so rather than guessing", markAge("not a date", "UTC", NOW).label === "unknown age");

    console.log("\nclearing marks");
    const clearGet = await get("/marked/clear");
    check("GET is refused", clearGet.status === 405, `got ${clearGet.status}`);
    check("and says which verb to use", clearGet.headers.get("allow") === "POST");
    const clearGetBody = await clearGet.text();
    check("and shows the curl that works", clearGetBody.includes("-X POST"));

    const postClear = (path, token = TOKEN) =>
        fetch(BASE + path, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });

    check("an untokened POST is refused", (await postClear("/marked/clear", null)).status === 401);

    const cleared = await postClear("/marked/clear?json=1");
    check("POST clears the queue", cleared.status === 200, `got ${cleared.status}`);
    check("and reports how many went", (await cleared.json()).cleared === 2);

    await postClear("/marked/clear?markId=7");
    check("markId reaches the plugin", received["marked.clear"]?.markId === 7);
    // Never coerced to "clear everything" — a typo in the one parameter that
    // limits the blast radius must not widen it.
    check("a non-numeric markId is refused", (await postClear("/marked/clear?markId=abc")).status === 400);

    console.log("\nthird eye scope guard (a DM watch on a sidecar that refuses DMs)");
    /*
     * Neither standing fixture reaches this state on its own: the default
     * sidecar watches a guild channel, and the one watching a DM has denyDms
     * off. So supersede the plugin instead of standing a third sidecar up —
     * `adopt()` drops the previous socket as soon as a second one says hello —
     * which parks a DM watch behind the guard that is meant to refuse it.
     *
     * Last of the BASE assertions deliberately: it replaces the fixture every
     * block above reads its recorded params from, and re-election below kills
     * this sidecar anyway.
     */
    const { received: dmWatch } = await fakePlugin({ dm: true });

    const liveGuarded = await get("/live");
    check("a DM watch is refused", liveGuarded.status === 403, `got ${liveGuarded.status}`);
    check("and names the setting", (await liveGuarded.text()).includes("denyDms"));

    // The disclosure half. json mode returned the drained buffer from an exit
    // above the guard, so `?json=1` served precisely what the line above
    // refuses — same URL, same config, opposite answer.
    const liveJson = await get("/live?json=1");
    check("json mode is refused too", liveJson.status === 403, `got ${liveJson.status}`);
    check("and does not carry the DM body", !(await liveJson.text()).includes("did the pak actually load"));

    /*
     * The data-loss half, and the reason the guard moved rather than being
     * copied to the second exit. `consume` defaults to true on this route, and
     * the plugin empties its ring the moment it answers — so a guard that ran
     * after the drain had already destroyed the buffer it then refused to show,
     * with nothing left to re-read once the config was fixed.
     */
    check("a refused drain never reached the plugin", dmWatch["third_eye.drain"] === undefined);
    check("and asked only what was being watched", dmWatch["third_eye.state"] !== undefined);

    console.log("\nre-election (must be last — it kills the sidecar above)");
    /*
     * Two more sidecars on the SAME ports as the first, spawned now rather than
     * at the top so neither can win the original bind. With MCP attached they
     * stay alive as proxies, which is what makes them candidates — and two of
     * them rather than one because the interesting half of a promotion is the
     * half that loses: exactly one wins the bind, and what the other does about
     * it is `standDown()`.
     */
    const electA = spawnCandidate();
    const electB = spawnCandidate();
    await new Promise(r => setTimeout(r, 2500));

    const beforeDeath = await (await get("/status")).json();
    check("the original owner still holds it while all three live", beforeDeath.owner?.pid === child.pid);

    child.kill();

    const winnerPid = await waitForPromotion([electA.pid, electB.pid]);
    check("a stranded proxy takes the bridge over", winnerPid !== null, "nobody promoted within 25s");

    const winner = winnerPid === electB.pid ? electB : electA;
    const loser = winner === electA ? electB : electA;

    if (winnerPid) {
        // The http mirror alone would prove nothing: a promoted process that
        // served http without holding the websocket is exactly the broken state
        // this needs to rule out. So make a plugin dial the ws port and check the
        // new owner answers as connected.
        await fakePlugin();
        const reconnected = await (await get("/status")).json();
        check("and owns the websocket, not just the mirror", reconnected.connected === true);
        check("and serves reads through it", (await (await get("/current-view")).text()).includes("#modding-help"));

        // Exactly one of them can have won, and the other's whole job is to keep
        // going: a candidate that exits when it loses takes its MCP client's
        // session down with it, which is worse than the outage it was fixing.
        check("the other candidate is still running", loser.exitCode === null);
        // Whatever the loser did or didn't do about the bind, the one thing it
        // can never truthfully say here is that the owner came back — that pid
        // is dead. This is the wording a merely-slow owner used to produce, and
        // a phantom handover in a log is a bug report about a second sidecar
        // that never existed.
        check("and reports no handover that did not happen", !loser.said.includes("is answering again"));
    }

    console.log("\nre-election, contested (losing the bind is not losing the session)");
    /*
     * One candidate from here on. The loser above is killed so that anything the
     * remaining process does is unambiguously its own, and a fresh candidate is
     * spawned rather than reusing one, so its promotion cooldown starts here.
     */
    loser.kill();
    const electC = spawnCandidate("debug");
    check(
        "a fresh candidate comes up as a proxy",
        await waitFor(() => electC.said.includes("proxying through"), 15_000),
        electC.said.slice(-240)
    );

    winner.kill();
    squatter = createTcpServer();
    /*
     * Taking the websocket port wins by a wide margin and does not need to be
     * tight: the candidate cannot reach bind() until a probe has missed (up to
     * 5s), the confirming probe 750ms later has missed too, and up to 250ms of
     * jitter has elapsed. This retries every 10ms from the moment the owner is
     * signalled. A plain TCP listener is enough — it never has to speak
     * websocket, it only has to make the bind fail.
     */
    check("the test takes the websocket port before the candidate can", await grabPort(squatter, WS_PORT, 10_000));
    standIn = await startStandIn(STANDIN_PID);

    check(
        "the candidate loses the bind and names who has it",
        await waitFor(
            () => new RegExp(`pid ${STANDIN_PID} won the bridge on :${WS_PORT}; proxying through :${HTTP_PORT} instead`).test(electC.said),
            30_000
        ),
        electC.said.slice(-300)
    );
    // The stand-in is a different pid from the owner this process was proxying
    // through, so this is a handover and must not be reported as a revival.
    check("and calls it a handover rather than a revival", !electC.said.includes("is answering again"));
    check("and keeps proxying rather than exiting", electC.exitCode === null);

    console.log("\nre-election, retried (one failed attempt must not be the last)");
    /*
     * The regression test for the defect that made this whole feature a no-op.
     * Promotion used to be triggered on the *edge* of the owner going missing —
     * `goneStreak === 2` exactly — and only a successful probe resets that
     * streak. So a death bought exactly one attempt, and an attempt that lost
     * the bind and then found nothing serving http left the process proxying to
     * a corpse for the rest of its life, with one log.debug to say so.
     *
     * That state is what this reproduces: the websocket port stays squatted and
     * the stand-in's http goes away, so `waitForOwner()` comes back empty and
     * standDown() has nothing it can do. The attempt above already happened and
     * failed, so nothing here depends on a fresh edge.
     */
    // closeAllConnections first, or close() never calls back: undici keeps the
    // proxy's connection to this port alive between probes.
    standIn.closeAllConnections();
    await new Promise(r => { standIn.close(() => r()); });
    standIn = null;

    check(
        "the candidate tries again and finds nothing serving http",
        await waitFor(() => electC.said.includes("lost the bind and could not find who won"), 40_000),
        electC.said.slice(-300)
    );

    await new Promise(r => { squatter.close(() => r()); });
    squatter = null;

    /*
     * Both ports are free now, so the only question left is whether this process
     * ever asks again. Budget: 15s of promotion cooldown measured from the
     * failed attempt, up to 5s more for the next poll to re-arm the trigger, and
     * then the attempt itself. 45s is that with room on a loaded machine — and
     * before the fix no budget at all would have been enough.
     */
    const retriedPid = await waitForPromotion([electC.pid], 180);
    check("a promotion that failed is retried until it wins", retriedPid === electC.pid, "the candidate never tried again");

    if (retriedPid) {
        await fakePlugin();
        check("and the retry holds the websocket, not just the mirror", (await (await get("/status")).json()).connected === true);
    }

    console.log("\nre-election, past a token mismatch (a 401 is not an owner)");
    /*
     * The second way to strand a proxy forever, which survived the first fix.
     *
     * `probe()` used to count any HTTP response as proof of an owner, 401
     * included, reasoning that something held the port and "the bind would fail
     * anyway". It would not: the answer comes from httpPort, the bind happens on
     * port, and nothing links the two. So an owner that came back on a
     * regenerated token pinned `goneStreak` at zero forever — no promotion was
     * ever attempted while the websocket port stood free, and `status()` went on
     * reporting the dead owner's account because `cached` only updates on a 2xx.
     *
     * Reproduced by attaching a candidate to a stand-in that answers, then
     * flipping it to 401 and freeing the websocket. The assertion is on who ends
     * up holding WS_PORT rather than on /status, because the stand-in keeps
     * httpPort throughout — which is the whole point, and also why a candidate
     * that promotes here stays invisible to /status.
     */
    for (const proc of candidates) proc.kill();
    await new Promise(r => setTimeout(r, 1500));

    const wsHold = createTcpServer();
    check("the websocket port is held so the candidate has to proxy", await grabPort(wsHold, WS_PORT, 10_000));

    const mismatch = await startRejectingStandIn(424242);
    const electD = spawnCandidate("debug");
    // Long enough to have found the stand-in, attached, and settled into polling.
    await new Promise(r => setTimeout(r, 3000));

    mismatch.startRejecting();
    await new Promise(r => { wsHold.close(() => r()); });

    /*
     * Budget: up to 5s for the poll that sees the first 401, 750ms for the
     * confirming probe, then the bind — which succeeds first time, because
     * nothing holds the websocket now. 30s is that with room to spare, and
     * before the fix no budget would have sufficed: the candidate was not
     * counting those 401s as misses at all.
     */
    check("a rejected token does not count as an owner", await waitForWsOwner(30_000), electD.said.slice(-400));
    check("and says which port is answering on the wrong token", electD.said.includes("rejects our token"));
    check("and did not exit over it", electD.exitCode === null);

    try { mismatch.server.closeAllConnections(); } catch { /* already gone */ }
    await new Promise(r => { mismatch.server.close(() => r()); });

    console.log("\npromotion with the mirror's port squatted (an owner nobody can find must not stay that way)");
    /*
     * Winning the websocket and losing the http mirror used to be terminal.
     * `attempt()` sets `owner = true` before calling `serve()`, and `serve()`
     * swallowed the bind failure, so `promote()` returned early on `owner` for
     * the rest of the process's life and nothing ever tried the mirror again.
     *
     * The state that leaves behind is the nasty one: a perfectly healthy bridge
     * serving Discord that no other sidecar can discover, so the next session's
     * findOwner() sees nothing, its own bind loses to this process's websocket,
     * and it exits 1 -- surfacing as "Connection closed" with everything running.
     *
     * Reproduced by holding httpPort while a candidate promotes, then letting go
     * and checking it recovers on its own rather than needing a restart.
     */
    for (const proc of candidates) proc.kill();
    await new Promise(r => setTimeout(r, 1500));

    /*
     * Destroys what it accepts, for two separate reasons.
     *
     * It has to look like a dead owner rather than a live one, or the candidate
     * would see something answering on httpPort and never promote at all. And a
     * plain `createTcpServer()` here deadlocks the test: `close()` waits for
     * open connections to end, the candidate keeps one alive between probes, and
     * the callback never fires. Same trap the stand-in above needs
     * `closeAllConnections()` for — net.Server has no such method, so the
     * sockets are dropped as they arrive instead.
     */
    const httpHold = createTcpServer(socket => socket.destroy());
    check("the mirror's port is held before the promotion", await grabPort(httpHold, HTTP_PORT, 10_000));

    const electE = spawnCandidate("debug");
    check(
        "the candidate takes the websocket anyway",
        await waitForWsOwner(30_000),
        electE.said.slice(-400)
    );
    check(
        "and says it is unfindable rather than failing quietly",
        await waitFor(() => electE.said.includes("could not serve http"), 15_000),
        electE.said.slice(-400)
    );

    /*
     * The whole point: releasing the port is enough, with no restart and no
     * second candidate.
     *
     * waitForPort polls at 100ms, so the budget has to clear one whole
     * HTTP_RETRY_MS cycle in the sidecar -- 15s, or 150 attempts -- before it
     * can possibly succeed. 400 is that with room on a loaded machine, and it
     * costs nothing on the happy path because the loop returns the moment the
     * mirror answers. Getting this wrong reads exactly like the bug: the first
     * version budgeted 120 and failed a working fix.
     */
    await new Promise(r => { httpHold.close(() => r()); });
    check(
        "and picks the mirror up on its own once the port frees",
        await waitForPort(BASE, 400),
        electE.said.slice(-400)
    );
    check("and did not have to be restarted to do it", electE.exitCode === null);

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
        console.error("\nfailures:\n" + failures.map(f => "  - " + f).join("\n"));
        cleanup(1);
    }
    cleanup(0);
} catch (err) {
    console.error("smoke test blew up:", err);
    console.error("sidecar stderr:\n" + stderr);
    cleanup(1);
}

async function check2(name, fn) {
    check(name, await fn());
}
