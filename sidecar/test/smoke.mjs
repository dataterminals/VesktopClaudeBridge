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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

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
                        return answer({ items: [{
                            markId: 1, markedAt: "2026-08-01T14:36:10.000Z", note: "last 2",
                            guild: GUILD, channel: DM_CHANNEL, messages: MESSAGES
                        }] });
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

function spawnSidecar({ wsPort, httpPort, dir, env = {} }) {
    const proc = spawn(process.execPath, ["dist/index.js", "--no-mcp"], {
        cwd: ROOT,
        env: {
            ...process.env,
            VCB_PORT: String(wsPort),
            VCB_HTTP_PORT: String(httpPort),
            VCB_TOKEN: TOKEN,
            VCB_CONFIG_DIR: dir,
            VCB_DOWNLOAD_DIR: join(dir, "downloads"),
            VCB_LOG_LEVEL: "warn",
            ...env
        },
        stdio: ["ignore", "inherit", "pipe"]
    });
    proc.stderr.on("data", d => { stderr += d.toString(); });
    return proc;
}

const child = spawnSidecar({ wsPort: WS_PORT, httpPort: HTTP_PORT, dir: workDir });
const childDm = spawnSidecar({
    wsPort: WS_PORT_DM,
    httpPort: HTTP_PORT_DM,
    dir: workDirDm,
    env: { VCB_DENY_DMS: "0" }
});

function cleanup(code) {
    child.kill();
    childDm.kill();
    for (const dir of [workDir, workDirDm]) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ }
    }
    process.exit(code);
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
    check("omits per-message ids by default", !view.includes("⟨3001⟩"));
    check("ids=1 adds them back", (await (await get("/current-view?ids=1")).text()).includes("⟨3001⟩"));

    console.log("\nscope guard");
    const marked = await get("/marked");
    check("DM content is refused", marked.status === 403, `got ${marked.status}`);
    check("and names the setting", (await marked.text()).includes("denyDms"));

    console.log("\nscope guard, opened (denyDms: false)");
    if (!(await waitForPort(BASE_DM))) {
        check("the second sidecar came up", false, "it never started");
    } else {
        await fakePlugin({ wsPort: WS_PORT_DM, dm: true });

        const markedDm = await getFrom(BASE_DM, "/marked");
        check("the same DM content is served", markedDm.status === 200, `got ${markedDm.status}`);
        check("and carries the body", (await markedDm.text()).includes("did the pak actually load"));

        // The counterpart to the plugin marking every DM message notable. If that
        // tier were empty in a DM, the buffer would still fill and this hook would
        // still run -- and print nothing, which is indistinguishable from a watch
        // that never armed. So pin that notable-only is non-empty here.
        const liveDm = await getFrom(BASE_DM, "/live?notableOnly=1");
        check("a notable-only DM drain is served", liveDm.status === 200, `got ${liveDm.status}`);
        const liveDmBody = await liveDm.text();
        check("and is not empty", liveDmBody.includes("did the pak actually load"));
        check("and names the DM it came from", liveDmBody.includes("dm:bob"));
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
