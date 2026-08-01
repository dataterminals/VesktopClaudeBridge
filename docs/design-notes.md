# Design notes

Why this is shaped the way it is, and where it will break first.

## Why the plugin dials out

A Vencord plugin runs in Discord's renderer, which can't open a listening socket. So the plugin is the websocket *client* and the sidecar is the server, even though the request flow runs the other way — after the handshake the sidecar asks and the plugin answers.

There's precedent: the `WebRichPresence (arRPC)` plugin connects out to a local process the same way, which is also useful evidence that Vesktop won't CSP-block the connection.

## Why one sidecar process

The plugin holds the only authenticated view of Discord. Anything that wants that view has to share a connection to it, so the MCP server, the HTTP mirror and the bridge all live in one process rather than coordinating through a file or a second socket.

## Output decisions

**Compact by default, JSON on request.** The point of the project is that a transcript should cost less context than a screenshot and say more. Returning 200 fully-hydrated message objects would lose that argument.

**No per-message ids unless asked.** Snowflake ids are 19 characters each. Paginating only needs the first and last, so those go in the header and the rest are dropped. `ids: true` brings them back when you need to anchor on a specific message.

**Never indent a message body.** Log files and code fences arrive intact and leave intact. Indenting a fenced block to make the transcript look tidy would corrupt the one part of the message the user actually wanted read. Single-line messages get `[time] Name: text`; anything multi-line gets a header line and then the body verbatim.

**Mention resolution skips code spans.** `resolveContent()` splits on ``` fences and inline backticks and only rewrites the parts outside them. A pasted log containing something that looks like `<@1234>` stays exactly as posted.

**Truncation is recoverable.** Long bodies get cut with a note naming the tool and argument that would fetch the rest, rather than silently ending.

## Search

`history` reads a channel in order; `search` asks Discord's index a question. Paging `history` backwards to find an old message is O(the whole channel) and runs out of context long before it arrives, which is why this exists.

Three things about the endpoint were confirmed against a live client rather than inferred, because all three are the kind of thing that looks fine until it isn't:

- **`SEARCH_CHANNEL` is for DMs only.** Point it at a guild text channel and Discord returns 400 `Cannot execute action on this channel type` (code 50024). Scoping a guild search to one channel means passing `channel_id` to `SEARCH_GUILD`. The plugin maps 50024 to a message that says this, because the raw error points nowhere useful.
- **`body.messages` is an array of arrays.** Each group is a hit plus optional context, and the hit carries `hit: true`. Reading `messages[i]` as a message gets you an array.
- **An unfiltered search matches everything.** No `content`/`author_id`/`mentions`/`has` returned ~1.9M results on a mid-sized server. The handler refuses that before spending a round trip, since it is never what the caller meant.

Search payloads carry no `reactions` and no `referenced_message`, so hits render thinner than the same message read through `history` — reactions vanish and replies show as unresolved unless the cache happens to hold the target. That's honest rather than wrong, and the tool description says to re-read a hit with `history around=<id>` when the context matters.

Results are rendered grouped by channel with full dates, unlike a transcript: a transcript is one conversation over minutes, where the header carries the date and every line can be a bare clock time. Search results are scattered across channels and often years, so they carry the date on every line and keep their ids — the only useful next step from a hit is to go read around it.

The scope guard runs per hit rather than once up front, since results span channels and one out-of-scope channel shouldn't void the rest of the page. Hidden hits are counted in a footer rather than silently dropped.

## Paging, and what Discord does with anchors

`GET /channels/:id/messages` caps `limit` at 100 and **400s** above it rather than clamping, so anything larger has to be paged. `fetchMessages` walks forward off each batch's newest id when `after` is set — so "this message and everything after it" can exceed 100 — and backward off the oldest id otherwise.

That makes concatenation non-monotonic: pages are newest-first internally, but forward paging makes successive pages ascend. Hence the result is sorted by snowflake at the end rather than reversed, and deduped, since page boundaries can overlap.

Three behaviours were confirmed against a live client, not inferred:

- **`after` is adjacent, not recent.** It returns the messages immediately following the anchor, so it means "start here and walk forward" rather than "the newest N that happen to be later". Anchoring at 17:44 with `limit=10` returned 17:52 → 18:02 while the channel's newest message was the next day.
- **`before` is silently discarded when `after` is present.** No 400, no intersection of the two bounds — Discord just ignores the upper one and returns messages past it. So `after` + `before` is enforced client-side: the loop drops anything at or beyond the far anchor and stops as soon as it crosses. Without that, "read everything between A and B" quietly returns everything from A to the live edge. Measured: a 14-minute window returned 50 messages spanning nearly a day, 48 of them outside it.
- **`around` isn't paged.** It centres a fixed window, so a second page has no coherent meaning; it takes Discord's cap as-is and returns fewer than asked without complaint.

None of this is reachable from the sidecar's tests — the plugin half needs a live client. The smoke tests only pin that the sidecar delivers both anchors to the plugin, since dropping one on the way through would fail exactly as silently.

## Cache versus REST

`current_view` reads `MessageStore` first because it's instant. But the cache only holds what has actually been rendered, and Discord caps it around 50 per channel — so it refetches over REST whenever the cache came up short of what was asked for, and flags `fromCache: false`.

That threshold used to be "fewer than ~10 messages", which was wrong in a way that only showed up once someone raised `grabCount`: 50 cached messages clears a bar of 10, so a request for 100 was quietly answered with 50 and labelled `last 50`. Anything above the cache ceiling was dead config. Refetching whenever the cache is short costs an extra round trip on channels with less history than the limit, which is the right trade against silently under-delivering.

History always goes to REST, through the client's own `RestAPI`. That's the same request the app makes when you scroll up: same session, same permissions, no bot token.

## Why the token isn't in plugin settings

Vencord's cloud settings sync uploads the settings blob to a remote host. A token parked in a settings field would ride along with it. So the settings field is a one-way inbox — `start()` moves the value into `localStorage` (per-install, never synced) and blanks the field.

This looks like a bug the first time you see it. It isn't.

### `localStorage` has to come from `@utils/localStorage`

Discord deletes `window.localStorage` from the renderer during boot. By the time a plugin's `start()` runs, the bare global is `undefined` and every access throws.

This was the one bug that made it all the way to the first live run, and it's worth understanding why it survived review: `getToken()` wraps its read in a `try/catch` returning `""`, which is the right shape for "storage is disabled" but here turned a hard failure into a silent one. The bridge did exactly what it's supposed to do when there's no token — declined to open a socket and reported `no token set` — so the symptom pointed at the settings field, which was fine, rather than at storage, which was gone. It typechecks, and there's no way to catch it without a live client.

Vencord's own bundle runs before Discord's delete and re-exports the captured `Storage` object from `@utils/localStorage`. Import from there, never the global. Vencord uses it for its own cloud-sync flags for exactly this reason.

The general lesson for this plugin: a `catch` that returns a falsy default will hide a missing browser global, and every store call in `discord.ts` is written in that same defensive style. That's the right call for field renames, but it means "empty result" and "API gone" look identical from the outside. When something comes back empty, check the thing exists at all before assuming the shape changed.

## Why the loopback socket needs auth at all

A websocket server on `127.0.0.1` has no same-origin protection: any web page you happen to visit can open a socket to it. Two independent checks stop that page reading your Discord — it can't read the token, and it can't forge an `Origin` header. Either would be sufficient; both are cheap.

The HTTP mirror takes its token in an `Authorization` header only, never a query parameter, so it can't leak through shell history or proxy logs.

## Read-only

Automating a user account violates Discord's ToS. Reading through the client's stores is very low-risk — that data is already in memory, and history fetches mirror what the app does anyway. Sending is where accounts get flagged, so there is no send path.

If one is ever added it should be draft-into-composer: the model fills the box, the human presses enter.

## What will break first

Everything Discord-facing is version-sensitive. In rough order of likelihood:

| Surface | Where | Symptom |
| --- | --- | --- |
| `contextMenus` / `chatBarButton` plugin keys | `index.tsx` | menu item or button silently absent |
| `GuildChannelStore.getChannels()` shape | `discord.ts` → `listChannels` | `discord_channels` returns nothing |
| `MessageStore.getMessages().toArray()` | `discord.ts` → `cachedMessages` | `current_view` always falls back to REST |
| `Constants.Endpoints.MESSAGES` | `discord.ts` → `fetchMessages` | history throws immediately |
| Message record field names | `discord.ts` normalisers | fields come back null |

All five were checked against a live client on 2026-08-01 (Equicord 1.15.0.2, Vesktop 1.6.5) and all five held. Recorded so the next person knows what "working" looked like:

- `GuildChannelStore.getChannels()` returns `{ "4": [...], SELECTABLE: [...], VOCAL: [...], id, count }`. The non-array `id`/`count` keys are why `listChannels` skips non-arrays. Dropping types 4 and 2 left 22 text + 2 announcement + 3 forum = the 27 the tool reported.
- The context menu item lands as `message-vcb-mark-for-claude`, and the chat-bar button renders as a `div[role=button]` whose `aria-label` interpolates `grabCount` — not a `<button>`, which matters if you go looking for it in the DOM.
- Reply resolution behaves differently by path, by design and visibly: `current_view` reads the cache and resolves reply bodies that the REST path returns as `unresolved`, because Discord doesn't always inline `referenced_message`.

The normalisers are deliberately defensive — every field read is optional-chained with a fallback — so a rename degrades one field rather than throwing. If something comes back empty, start at the store call, not the transcript.

Verify changes by typechecking against a real checkout rather than guessing:

```bash
cp plugin/*.ts plugin/*.tsx <equicord>/src/userplugins/vesktopClaudeBridge/
cd <equicord> && npx tsc --noEmit
```

## Known limitations

- **Marks are pulled, never pushed.** MCP gives a server no way to wake a model up, so marking something doesn't notify anyone — it sits in the queue until a tool call asks. The plugin does emit a `marked` event over the socket, but nothing acts on it yet.
- **`markContext` is a fixed window**, not a range. Marking two ends of a conversation takes two marks.
- **Forum channels** appear in `discord_channels` but their threads don't; `discord_threads` isn't built yet.
- **Search can't see threads.** `SEARCH_GUILD` indexes channel messages; forum posts and thread replies don't reliably come back, which is the same gap `discord_threads` would close.
- **Attachment urls expire.** `discord_fetch_attachment` re-reads the message to mint a fresh signature rather than trusting a url from an earlier tool result. Don't cache them.
- **Unresolved replies aren't retried.** Discord's REST doesn't always inline `referenced_message`, so `discord_history` can render `replying to someone (body not loaded)` for a message that is still perfectly fetchable — confirmed live: a reply target that came back unresolved was readable via `around=<id>` a moment later. `current_view` doesn't show this because the cache has the body. Fixing it means either a second fetch per unresolved reply or resolving against the page already in hand, which only helps when the target is in the same window. Left alone for now because the flag is honest about what happened, but it's the cheapest remaining win in transcript quality.
- **One sidecar per machine.** It binds two loopback ports and exits on `EADDRINUSE`, so a hand-started sidecar and a Claude-Code-spawned one can't coexist. The failure surfaces as `Connection closed`, which doesn't point anywhere near the real cause.
