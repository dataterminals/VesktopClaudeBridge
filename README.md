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

Vesktop also validates the folder against Vencord's *release asset* names (`vencordDesktopMain.js` and friends), which Equicord doesn't build — so a stock Equicord dist is rejected as "invalid". `-Build` writes those four names in beside the real ones for you. They're copies of build output rather than links, which is why rebuilding has to go through the script — see [Living with it](#living-with-it).

The token box clears itself on reload — that's intentional. Vencord's cloud settings sync uploads the settings blob to a remote host, so the plugin moves the token into `localStorage` instead, where it stays on this machine.

One surprise worth knowing: once Vesktop is loading Equicord from a custom *Vencord Location*, Equicord keeps its settings in **`%APPDATA%\Equicord\settings`**, not `%APPDATA%\vesktop\settings`. That folder is empty until you do this, which makes it easy to spend a while editing a file nothing reads.

Which also means an existing Vencord setup does not come with you — Equicord starts from defaults, and the old config sits there looking current. Moving it over is mostly a copy, with three snags:

- **`quickCss.css` and `themes/`** just copy across, but `useQuickCss` lives in `settings.json` and has to come too or the CSS loads and does nothing.
- **Some plugins are renamed.** `VencordToolbox` is `EquicordToolbox` (that's the toolbar QuickCSS toggle, under *Themes* in its menu), and `petpet` is `PetPet`. Same plugin bank otherwise — Equicord is a Vencord superset, so most names match exactly.
- **Don't copy the `cloud` block.** It points at Vencord's cloud host with sync on; Equicord has its own. Carrying it over turns settings sync back on against a different service.

Required plugins (`BadgeAPI`, `NoticesAPI`, `ContextMenuAPI`, `SupportHelper`) don't need migrating — Vencord manages those itself.

### 3. Wire up MCP

```bash
claude mcp add discord -- node "D:/Github Repositories/VesktopClaudeBridge/sidecar/dist/index.js"
```

Check it took with `discord_status`. If it says `no_client`, Vesktop isn't running or the plugin isn't enabled.

Start it by hand with `npm start` if you want one running independently — otherwise Claude Code spawns it for you when a session begins.

**Several can run at once.** The plugin dials exactly one socket, so exactly one process owns the Discord connection — whoever starts first. Everyone after that detects the owner and proxies through it over `/rpc`, which is how Claude Code and Claude Desktop can both use this at the same time. The plugin reconnects on its own within ~15s of an owner appearing, so you don't need to reload Discord when sessions come and go.

### Claude Desktop

Same server, registered in `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{ "mcpServers": { "discord": { "command": "node",
  "args": ["D:\\Github Repositories\\VesktopClaudeBridge\\sidecar\\dist\\index.js"] } } }
```

Browser claude.ai can't use this: it needs a *remote* MCP endpoint, and the whole security model here is loopback plus a token plus an `Origin` check — two of those three stop meaning anything the moment it's internet-reachable.

If port 8787 is already taken on your machine, change it in **both** halves or the plugin will dial a socket nothing is listening on:

- `%APPDATA%\vesktop-claude-bridge\config.json` → `port` (the HTTP mirror defaults to `port + 1`)
- the plugin's **Port** setting in Equicord settings

## Third eye

Toggle it from the chat-bar button (it opens a menu — mark, or watch) and it quietly buffers the channel you're in. Nothing reads that buffer until you ask, or until you next send Claude a message.

Capture costs nothing at all — no model, no tokens, no session — so it's fine to leave armed. Reading is the only part that spends anything, which is why the icon's burst only lights while a drain is happening: you can tell at a glance whether it's just watching or actually being read.

Set **Third eye terms** in the plugin settings to a comma-separated list of things you care about — a repo name, a mod name, a build number. Mentions and replies are caught automatically, but conversations *about* your work usually never name you, and that's the case the term list exists for.

Watches lapse after four hours and say so. Turning Discord off and on again keeps the watch but drops anything unread, because message bodies are never written to disk.

**DMs need two switches, and they are deliberately separate.** Set **Third eye watch DMs** in the plugin settings to let the buffer fill from a DM at all, and `denyDms: false` in the sidecar config to let that content leave the renderer. Flip only the first and the buffer fills correctly and then the drain is refused at the boundary; flip only the second and the button still won't arm. The split is the point — the plugin setting decides what is *collected*, the sidecar decides what reaches a model — but it does mean a half-configured setup fails in two different-looking ways.

Inside a DM every message counts as notable, because a one-to-one has no ambient tier to sort against: nobody @-mentions you or uses the reply affordance, so the guild rules would find nothing to fire on and the notable-only hook below would stay silent while the buffer filled. Group DMs count the same way.

For the button alone to be enough, register the hook — otherwise you'd have to tell Claude the watch is running once per session:

```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command",
  "command": "node \"<repo>/scripts/third-eye-hook.mjs\"" } ] } ] } }
```

It runs on every message you send, times out after 2s, exits 0 on every failure path, and prints nothing when there's nothing to say.

## Living with it

Once this is set up, Vesktop stops using the Vencord it downloads for itself and loads your Equicord build off disk instead. You still launch Vesktop the same way — nothing about the shortcut changes — but the chain underneath is now:

```
vesktop.exe
  └─ reads vencordDir from %APPDATA%\vesktop\state.json
       → D:\Equicord\dist\equibop
         ├─ require()s vencordDesktopMain.js   (main process)
         └─ injects  vencordDesktopPreload.js + vencordDesktopRenderer.js
              └─ Equicord reads its settings from %APPDATA%\Equicord\settings
```

Three things follow from that, and all three fail quietly rather than loudly:

**The Equicord checkout is a runtime dependency, not a build artifact.** Vesktop reads it on every launch, so it can't be cleaned up or moved. If those files go missing, Vesktop doesn't error — `ensureVencordFiles()` downloads *stock Vencord release files into `dist\equibop`*, leaving a half-Vencord-half-Equicord folder that behaves strangely rather than failing.

**Never run a bare `pnpm build` in the Equicord checkout.** The four `vencordDesktop*` files Vesktop loads are *copies*, not links. esbuild rewrites `main.js` and `renderer.js` and leaves the copies alone, so Vesktop silently keeps loading your previous build — no error anywhere, and the change you just made simply isn't there. Always rebuild through the script:

```powershell
.\scripts\install-plugin.ps1 -EquicordPath D:\Equicord -Build
```

**Run that same command after every `git pull` in Equicord.** The plugin lives *inside* the Equicord tree at `src/userplugins/vesktopClaudeBridge`, so an update needs it re-copied and the aliases regenerated. This is the standing cost of userplugins; it's one command, but forgetting it looks like "my change didn't do anything" rather than like an error.

### Getting back out

Clear *Vencord Location* in Vesktop settings and it reverts to the Vencord it manages itself, with the config in `%APPDATA%\vesktop\settings`. Both are left untouched by any of this, so that's a clean escape hatch if an Equicord update ever breaks something mid-conversation.

Note that the two configs are separate stores, not one shared one — changes you make under Equicord don't appear in the Vesktop-managed Vencord, and vice versa.

## Tools

| Tool | Use it when |
| --- | --- |
| `discord_current_view` | "read the logs" with no other detail — reads whatever channel is on screen |
| `discord_marked` | the user right-clicked → **Mark for Claude**, or hit the chat-bar button |
| `discord_live` | third eye is on and they're asking what's been happening while they worked |
| `discord_fetch_attachment` | a log/crash dump/diff is attached; downloads it and previews the head |
| `discord_resolve_link` | the user pasted a `discord.com/channels/...` link |
| `discord_search` | "find where someone mentioned X" — you know roughly what was said, not where |
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

Boots the real sidecar with a fake plugin standing in for Discord, then checks the things that are invisible until you're debugging live: token and origin rejection, the `no_client` path, code fences surviving the formatter unindented, and the DM guard refusing — plus a second sidecar with `denyDms: false` to check it then *serves*, including a notable-only drain of a DM coming back non-empty.

The plugin half has no runtime tests — it needs a live client. Typecheck it against a real checkout instead:

```bash
cd D:/Equicord && npx tsc --noEmit
```

## Scope and safety

A websocket on loopback has no same-origin protection — any page you visit can open one. Two things stop that page reading your Discord: it can't read the token (so it can't authenticate), and it can't forge an `Origin` header. Both are checked; either alone would do.

Scope defaults, in `%APPDATA%\vesktop-claude-bridge\config.json`:

- `denyDms: true` — "read my discord" shouldn't quietly mean all of it. Third eye has its own switch for the same question (see above); this one governs every tool, that one governs what the renderer will even buffer.
- `allowGuilds: []` — set guild ids to restrict further. Empty means all.
- `pseudonymize: false` — flip on to replace handles with `user_a`, `user_b` on the way out, so real handles never reach the model's context. Handy when the transcript is headed for a public repo.

## Why it's read-only

Automating a *user* account is against Discord's ToS. Reading through the client's own stores is very low-risk — it's data the client already has, and history fetches are the same calls the app makes when you scroll. **Sending** is where accounts actually get flagged, so there's no send path here at all.

If a write path is ever added, it should be draft-into-composer: the model writes the message, it appears in the box, you press enter. Safer, and honestly the behaviour you'd want anyway.

## Roadmap

- [x] `current_view`, mark queue, history, link resolution, attachments
- [x] `discord_search` — guild search by text/author/mentions/attachment, with paging
- [x] Third eye — watch a channel in the background, read it back on demand
- [ ] `discord_threads` — forum channel listing and thread reads
- [ ] Mark ranges (shift-click two messages) rather than a fixed context window
- [ ] Draft-into-composer write path

## Licence

GPL-3.0-or-later. The plugin half links against Vencord/Equicord, which is GPL-3.0, so the whole repo follows.
