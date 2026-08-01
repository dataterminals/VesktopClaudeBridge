# VesktopClaudeBridge

Read your Discord from Claude Code — an Equicord/Vencord userplugin plus a local MCP sidecar.

Point at a message in Discord, and the model reads it. No screenshots, no copy-paste, no bot account.

---

## Why

Getting Discord content in front of a coding agent currently costs more than it should:

- **Screenshots** can't be selected, hold one screen of scrollback, and mangle code blocks — which is exactly what a log is.
- **Copy-paste** loses reply chains, timestamps, attachments, and nested backticks.
- **Driving the window** with computer-use is slow, and Discord's message list is virtualised: only ~50 messages exist in the DOM at once.
- **Attachments** — the actual `.log` file someone dropped in the channel — sit behind CDN urls with expiring signatures, so passing the url along usually doesn't work.
- And every "read the logs" costs a round-trip of *which channel, how far back*.

The client already has all of this resolved in memory. This project just exposes it.

## What comes out

````
── #modding-help · The Forever Winter Modding · text
── 6 messages · 2026-08-01T14:31:02Z → 14:35:40Z · ids 1399482100000000000 → 1399482900000000000

[14:31:02] Avery: did the pak actually load or is it silently failing again
[14:32:40] Bob: silently failing
   ↳ replying to Avery: "did the pak actually load or is it silently…"
   [attachment] UE4SS.log · 43.2 KB · text/plain · msg 1399482400000000000
[14:33:10] Bob:
```
[2026.08.01-14.32.55:123][  0]LogUE4SS: Starting UE4SS
[2026.08.01-14.32.55:481][  0]LogUE4SS: Error: mod folder not found
```
[14:35:40] Avery: ah that's the -894 path thing (edited)
   👍 2
````

Mentions, channel links, custom emoji and `<t:>` stamps are resolved to readable text **before** they leave the client — because that's where the stores are. Code fences are passed through byte-exact.

## Architecture

```
  Vesktop renderer                    sidecar (node)                Claude Code
 ┌──────────────────┐              ┌───────────────────┐         ┌─────────────┐
 │ Equicord plugin  │──ws 8787────▶│ bridge server     │         │             │
 │  · stores        │◀─── rpc ─────│ MCP server (stdio)│◀───────▶│  discord_*  │
 │  · RestAPI       │              │ HTTP api :8788    │◀─curl───│    tools    │
 │  · mark queue    │              └───────────────────┘         └─────────────┘
 └──────────────────┘
```

The plugin **dials out** — renderers can't listen on a socket — and after the handshake the traffic inverts: the sidecar asks, the plugin answers. Reads go through the client's own authenticated `RestAPI`, so it's the same request the app makes when you scroll up. No bot, no second token.

## Install

### 1. Sidecar

```bash
npm run install:sidecar && npm run build
```

Grab the token it minted (you'll paste this into the plugin):

```bash
npm --prefix sidecar run token
```

### 2. Plugin

Userplugins are compiled into the client bundle, so this needs an Equicord source build — the prebuilt Vesktop bundle can't load them. This is the one genuinely annoying part, and it has to be redone on every Equicord update.

```bash
git clone https://github.com/Equicord/Equicord.git D:/Equicord
```

```powershell
.\scripts\install-plugin.ps1 -EquicordPath D:\Equicord -Build
```

The first run installs Equicord's own dependencies, so give it a few minutes. If `pnpm` can't self-switch to the version pinned in Equicord's `packageManager` field, the script retries with whatever `pnpm` is on your `PATH`.

Then point Vesktop at **`D:\Equicord\dist\equibop`** (Vesktop settings → *Vencord Location*) and restart it. Enable **VesktopClaudeBridge** in Equicord settings, paste the token into its settings field, and reload Discord (`Ctrl+R`).

`dist\equibop`, not `dist` and not `dist\desktop`. Vesktop `require()`s the Vencord main from that folder, and the two builds are not interchangeable: `dist\desktop\patcher.js` is the Discord `app.asar` injector and pulls in `discord_desktop_core`. Hand Vesktop that one and it hangs on the splash screen with no error in any log. Equibop is Equicord's Vesktop fork, so `dist\equibop` is the "host app loads Vencord" build.

Vesktop also validates the folder against Vencord's *release asset* names (`vencordDesktopMain.js` and friends), which Equicord doesn't build — so a stock Equicord dist is rejected as "invalid". `-Build` writes those four names in beside the real ones for you. They're copies of build output, so re-run the script after every Equicord rebuild rather than aliasing once by hand.

The token box clears itself on reload — that's intentional. Vencord's cloud settings sync uploads the settings blob to a remote host, so the plugin moves the token into `localStorage` instead, where it stays on this machine.

One surprise worth knowing: once Vesktop is loading Equicord from a custom *Vencord Location*, Equicord keeps its settings in **`%APPDATA%\Equicord\settings`**, not `%APPDATA%\vesktop\settings`. That folder is empty until you do this, which makes it easy to spend a while editing a file nothing reads.

### 3. Wire up MCP

```bash
claude mcp add discord -- node "D:/Github Repositories/VesktopClaudeBridge/sidecar/dist/index.js"
```

Check it took with `discord_status`. If it says `no_client`, Vesktop isn't running or the plugin isn't enabled.

**Only one sidecar can run at a time.** It binds two loopback ports, so a second one exits immediately with `EADDRINUSE` — which Claude Code surfaces as the much less helpful `Failed to connect: Connection closed`. If you've got a sidecar running by hand (`npm start`), stop it before letting Claude Code spawn its own. The plugin reconnects on its own within ~15s of a sidecar appearing, so you don't need to reload Discord when sessions come and go.

If port 8787 is already taken on your machine, change it in **both** halves or the plugin will dial a socket nothing is listening on:

- `%APPDATA%\vesktop-claude-bridge\config.json` → `port` (the HTTP mirror defaults to `port + 1`)
- the plugin's **Port** setting in Equicord settings

## Tools

| Tool | Use it when |
| --- | --- |
| `discord_current_view` | "read the logs" with no other detail — reads whatever channel is on screen |
| `discord_marked` | the user right-clicked → **Mark for Claude**, or hit the chat-bar button |
| `discord_fetch_attachment` | a log/crash dump/diff is attached; downloads it and previews the head |
| `discord_resolve_link` | the user pasted a `discord.com/channels/...` link |
| `discord_history` | paging back past what the client has cached |
| `discord_guilds` / `discord_channels` | turning "the modding server" into an id |
| `discord_status` | anything above returned `no_client` |

Everything is also on `http://127.0.0.1:8788` with `Authorization: Bearer <token>`, returning the same text — useful from Bash when MCP isn't wired:

```bash
curl -s -H "Authorization: Bearer $(npm --prefix sidecar run --silent token)" http://127.0.0.1:8788/current-view
```

This is also the fastest way to debug the bridge itself, since it doesn't need MCP wired up or a session restart to pick up changes.

## Tests

```bash
npm test
```

Boots the real sidecar with a fake plugin standing in for Discord, then checks the things that are invisible until you're debugging live: token and origin rejection, the `no_client` path, code fences surviving the formatter unindented, and the DM guard actually refusing.

The plugin half has no runtime tests — it needs a live client. Typecheck it against a real checkout instead:

```bash
cd D:/Equicord && npx tsc --noEmit
```

## Scope and safety

A websocket on loopback has no same-origin protection — any page you visit can open one. Two things stop that page reading your Discord: it can't read the token (so it can't authenticate), and it can't forge an `Origin` header. Both are checked; either alone would do.

Scope defaults, in `%APPDATA%\vesktop-claude-bridge\config.json`:

- `denyDms: true` — "read my discord" shouldn't quietly mean all of it.
- `allowGuilds: []` — set guild ids to restrict further. Empty means all.
- `pseudonymize: false` — flip on to replace handles with `user_a`, `user_b` on the way out, so real handles never reach the model's context. Handy when the transcript is headed for a public repo.

## Why it's read-only

Automating a *user* account is against Discord's ToS. Reading through the client's own stores is very low-risk — it's data the client already has, and history fetches are the same calls the app makes when you scroll. **Sending** is where accounts actually get flagged, so there's no send path here at all.

If a write path is ever added, it should be draft-into-composer: the model writes the message, it appears in the box, you press enter. Safer, and honestly the behaviour you'd want anyway.

## Roadmap

- [x] `current_view`, mark queue, history, link resolution, attachments
- [ ] `discord_search` — guild search by author/text/date
- [ ] `discord_threads` — forum channel listing and thread reads
- [ ] Mark ranges (shift-click two messages) rather than a fixed context window
- [ ] Draft-into-composer write path

## Licence

GPL-3.0-or-later. The plugin half links against Vencord/Equicord, which is GPL-3.0, so the whole repo follows.
