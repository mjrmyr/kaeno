# Kaeno UI

A first conversation-centric vertical slice, kept in root `ui/`. The core and
extension implementations remain untouched under `src/`.

## Run locally

Requires **Node.js 24+** (same as the host). Start the Kaeno host using the root
README's configuration/credentials; it listens on port 8080 by default. In another
terminal:

```sh
cd ui
npm ci
npm run dev
# Open http://127.0.0.1:5173
```

Vite proxies `/v1` to `http://127.0.0.1:8080`. To use a different trusted host:

```sh
KAENO_API_URL=http://127.0.0.1:8090 npm run dev
```

`KAENO_API_URL` is a **server-side development setting**, not a browser secret.
The browser only calls same-origin `/v1`. Do not add provider keys or host secrets
to Vite/browser environment variables. Fonts are bundled locally; no CDN, analytics,
external font requests, or client-side storage are used.

**No configured host?** Choose **Explore the demo** in the navigation. This is a
clearly labeled simulation of ongoing work, an input decision, and completion.
Demo interactions do not call the host. Live mode is the default; without a host,
it shows a recoverable connection error, not silently substituted fake replies.

## Check and build

```sh
cd ui
npm run check   # strict TypeScript + component/model/API tests
npm run build   # strict TypeScript + production build into ui/dist/
npm audit
```

From the repository root, `npm run verify` checks the existing host too. UI
commands are independent of the host dependency lockfile. Root formatting covers
UI source and excludes generated `ui/dist/`.

`npm run preview` serves the production assets for inspection, **not a production
API deployment**: the development proxy is not part of the build. To deploy, serve
`ui/dist/` at `/` and route `/v1/*` to Kaeno on the **same authenticated origin**.
The Kaeno API has no built-in authentication. Keep the dev server loopback-only;
put real deployments behind authenticated ingress and a trusted network. This PR
does not change Docker images, expose a server, or deploy anything.

## Real functionality and deliberate limits

- List/filter existing threads, select a thread, or create a UUID-named `web:*`
  thread by sending a message. Merely opening the UI does not create a thread.
- Send `POST /v1/threads/:key/turn` with a unique `requestId`; show sending,
  admission, uncertain delivery, and reply-received states. A retry of uncertain
  admission reuses the exact ID/body rather than duplicating the turn.
- Read `GET /v1/threads/:key/replies?after=0` every 2.5 seconds while selected.
  Reads are serial, aborted/ignored on selection changes, and show sync failures.
  The host retains a bounded reply ledger; its truncation warning is surfaced.
- Show activity-result replies with the host-provided label or activity ID.
- Send `POST /v1/threads/:key/stop`. Acceptance is explicitly **not** proof that
  all work has stopped. Stop remains available on restored threads too.
- The API exposes assistant replies, not historical owner messages. Outgoing
  messages, submission status, and per-thread drafts are **in memory only** and
  lost on reload. They are not a second durable conversation store.
- Live worker lifecycle, project records, structured questions/approval actions,
  tool streaming, and model selection are **not available through this API**.
  Rich work cards and input-needed actions exist only in the labeled demo.
  Live “awaiting reply” is local submission tracking, not inferred WORK status.
- Plain text preserves line breaks and avoids raw HTML/Markdown injection.
  Attachments, rich Markdown, reset/delete controls, and routine/memory editing
  are intentionally outside this first slice.

## Interaction and accessibility

The three-column desktop layout becomes conversation + stacked context on medium
screens, then a disclosure navigation drawer on mobile (700px breakpoint). Inputs
have labels; buttons use real button semantics; errors/statuses have accessible
announcements; keyboard focus is visible; navigation can close with Escape;
reduced motion is respected. Enter sends, Shift+Enter inserts a newline, and IME
composition does not accidentally submit. See `DESIGN.md` for the shape decision.

Component tests cover the actual browser-side contracts with mocked HTTP
responses, not a live model run. Real configured-host end-to-end and visual
viewport/screen-reader QA remain necessary before release. No browser screenshot
or live-agent integration result is claimed by these tests.
