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

## Cache versus REST

`current_view` reads `MessageStore` first because it's instant. But the cache only holds what has actually been rendered, so a channel the user just opened can come back nearly empty — if fewer than ~10 messages come back, it refetches over REST and flags `fromCache: false`.

History always goes to REST, through the client's own `RestAPI`. That's the same request the app makes when you scroll up: same session, same permissions, no bot token.

## Why the token isn't in plugin settings

Vencord's cloud settings sync uploads the settings blob to `api.vencord.dev`. A token parked in a settings field would ride along with it. So the settings field is a one-way inbox — `start()` moves the value into `localStorage` (per-install, never synced) and blanks the field.

This looks like a bug the first time you see it. It isn't.

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
- **No search.** Discord's search endpoint is the obvious next addition and the highest-value one — scrolling back through months of history via `before` is the wrong tool for "find where someone mentioned this".
- **Attachment urls expire.** `discord_fetch_attachment` re-reads the message to mint a fresh signature rather than trusting a url from an earlier tool result. Don't cache them.
