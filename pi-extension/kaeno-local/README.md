# kaeno-local for Pi

A text-only Pi provider for the local Kaeno HTTP API. Kaeno owns model calls,
conversation history, tools, and workers; Pi only sends the latest user message
and displays completed replies, including later worker reports. No Kaeno API key is needed. Model-provider
credentials belong in Kaeno's `.env`, not Pi.

## Install

From the repository root (after `npm ci`):

```sh
ln -s "$PWD/pi-extension/kaeno-local" ~/.pi/agent/extensions/kaeno-local
```

Keep the old `kaeno` extension if you still use the homelab server; this one has
its own provider name, model ID, and commands. The extension resolves its `zod`
and `pi-ai` runtime dependencies from this repository's `node_modules`.

## Use

Start Kaeno separately with `npm start`. Then:

```sh
pi --provider kaeno-local --model kaeno-local --no-tools
```

Or run `/reload` in an existing Pi session and select **kaeno-local** with
`/model`. Prefer a fresh session: previous Pi messages aren't uploaded to Kaeno.
Each Pi session maps to its own durable Kaeno thread. Resume the same Pi session
to continue that thread. Forked/new sessions get a separate thread, not a copy
of the old Kaeno conversation.

- Chat normally to send messages and wait for Kaeno's immediate reply.
- Later replies arrive automatically (polled every second while this model is
  selected and Pi is idle). No extra prompt or model call is needed.
- `/kaeno-local-replies` checks for **unread** replies immediately. It no longer
  replays history and does not call a model.
- `/kaeno-local-stop` requests cancellation of the current turn and background
  work. Pressing Escape only cancels Pi's local wait; Kaeno keeps working.

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

The default URL is `http://127.0.0.1:8080`. Override it when launching Pi:

```sh
KAENO_LOCAL_URL=http://127.0.0.1:8081 pi --model kaeno-local
```

The current Kaeno API is unauthenticated. Do not expose it to untrusted networks.

## Delivery regression check

With `pi` installed on `PATH`, run from the repository root:

```sh
node scripts/pi-delivery-smoke.mjs
```

This auto-discovers the extension through an installed-style directory symlink
in a temporary Pi config directory, then starts real Pi RPC processes against a
mock HTTP server. It checks initial-reply deduplication, automatic later reports,
manual fetching, and resume catch-up. It uses temporary sessions and makes no
model calls. The ordinary
`npm run verify` suite also tests cursor, retry, cancellation, and concurrency
behavior without requiring Pi to be installed.
