# Kaeno for Pi

Text-only Pi providers for the Kaeno HTTP API, one per Kaeno server:

| Provider / model | Server                              | Default URL                 | Override          | Commands                                    |
| ---------------- | ----------------------------------- | --------------------------- | ----------------- | ------------------------------------------- |
| `kaeno`          | your homelab                        | `http://homelab-kaeno:8080` | `KAENO_URL`       | `/kaeno-replies`, `/kaeno-stop`             |
| `kaeno-local`    | Kaeno on this machine (`npm start`) | `http://127.0.0.1:8080`     | `KAENO_LOCAL_URL` | `/kaeno-local-replies`, `/kaeno-local-stop` |

Both are always available; the selected model decides which server a session talks to. Kaeno owns model calls,
conversation history, tools, and workers; Pi only sends the latest user message
and displays completed replies, including later worker reports. No Kaeno API key is needed. Model-provider
credentials belong in Kaeno's `.env`, not Pi.

## Install

From the repository root (after `npm ci`):

```sh
ln -s "$PWD/pi-extension/kaeno" ~/.pi/agent/extensions/kaeno
```

Remove any older `kaeno` or `kaeno-local` extension link first: this extension
registers both provider names itself. It resolves its `zod` and `pi-ai` runtime
dependencies from this repository's `node_modules`.

## Use

Homelab, reachable over Tailscale:

```sh
pi --provider kaeno --model kaeno --no-tools
```

Local, after starting Kaeno with `npm start`:

```sh
pi --provider kaeno-local --model kaeno-local --no-tools
```

Or run `/reload` in an existing Pi session and select **kaeno** or **kaeno-local**
with `/model`. Each provider keeps its own thread and delivery state, so switching
models in a session talks to the other server's separate conversation. Prefer a fresh session: previous Pi messages aren't uploaded to Kaeno.
Each Pi session maps to its own durable Kaeno thread. Resume the same Pi session
to continue that thread. Forked/new sessions get a separate thread, not a copy
of the old Kaeno conversation. `/tree` only changes Pi's active branch: it does
not clear or rewind Kaeno's remote conversation. Delivery progress is scoped to
the whole Pi session, so navigating backward does not replay old replies. Use
`/new` for a fresh Kaeno conversation.

- Chat normally to send messages and wait for Kaeno's immediate reply.
- Later replies arrive automatically (polled every second while this model is
  selected and Pi is idle). They are Kaeno's answers after processing worker
  reports, not raw worker output. The TUI labels them **Kaeno (homelab)** or
  **Kaeno (local)**. No extra prompt or Pi-side model call is needed. Only the
  selected provider polls; the other one makes no requests.
- `/kaeno-replies` / `/kaeno-local-replies` check for **unread** replies
  immediately. They don't replay history and don't call a model.
- `/kaeno-stop` / `/kaeno-local-stop` request cancellation of the current turn
  and background work. Pressing Escape only cancels Pi's local wait; Kaeno keeps
  working.

The delivery cursor is saved in the Pi session. Reloading or resuming catches
up on unread replies without replaying already displayed messages. Reads are
serialized; a reply arriving during a Pi turn waits until Pi is idle. Switching
sessions or reloading aborts the old reader. If Kaeno is unavailable, the status
shows a delivery warning and polling retries without advancing the cursor.

**First upgrade of an old Pi session:** the previous extension recorded no reply
IDs or cursor. Its currently retained Kaeno history is marked read once, so old
errors and acknowledgments do not flood the transcript. This also marks any
already-arrived but unseen reports read during that one-time baseline. New replies
then arrive automatically. New sessions do not need this baseline.

This delivers whole completed messages, not token-by-token text or reasoning
(the HTTP API does not expose those). It does not forward Pi tools/files/images
or report model usage/cost. Retry identity is stable for the same session,
message timestamp, and text. Print/JSON one-shot runs still exit after the initial
answer; use interactive Pi or RPC mode to stay connected for later reports.

Override a URL when launching Pi, for example the homelab's full MagicDNS name
or another local port:

```sh
KAENO_URL=http://homelab-kaeno.example.ts.net:8080 pi --model kaeno
KAENO_LOCAL_URL=http://127.0.0.1:8081 pi --model kaeno-local
```

The current Kaeno API is unauthenticated. Do not expose it to untrusted networks;
on the homelab, Tailscale ACLs are the access control.

## Delivery regression check

With `pi` installed on `PATH`, run from the repository root:

```sh
node scripts/pi-delivery-smoke.mjs                          # kaeno-local
KAENO_SMOKE_TARGET=kaeno node scripts/pi-delivery-smoke.mjs  # kaeno
```

This auto-discovers the extension through an installed-style directory symlink
in a temporary Pi config directory, then starts real Pi RPC processes against a
mock HTTP server. It checks initial-reply deduplication, automatic later reports,
manual fetching, tree navigation without replay, delivery after navigation, and
resume catch-up. It uses temporary sessions and makes no model calls. The ordinary
`npm run verify` suite also tests cursor, retry, cancellation, and concurrency
behavior without requiring Pi to be installed.
