# Conversation UI

A new, independent browser client in `src/ui/`. It talks to the existing Kaeno
HTTP adapter: real thread listing, text turn admission, retained assistant replies
and thread-wide stop. It is not an activity dashboard. No prior UI branches are
required.

## Fresh clone: one root install, one root command

Requires Node.js **24+** and npm. All commands run at the repository root.
For a minimal chat-only assistant (no Docker daemon or GitHub source fetch needed):

```sh
npm ci
mkdir -p .kaeno/agents
cat > .kaeno/agents/assistant.md <<'AGENT'
---
name: assistant
description: Personal assistant
model: openai/gpt-4.1
tools: []
---
Be helpful, direct, and honest.
AGENT
cat > .kaeno/config.json <<'CONFIG'
{
  "sourceDirectory": "./sources",
  "localDefinitions": {
    "agents": [{ "alias": "local", "directory": "./agents" }]
  },
  "kaeno": "local:assistant",
  "workers": []
}
CONFIG
printf '{}\n' > .kaeno/docker.json
export OPENAI_API_KEY='your-provider-key'
npm run ui
```

Open **http://127.0.0.1:5173**. There is no nested install and no second backend
command. The launcher starts the normal host on loopback port 8080, waits for
`/healthz`, then starts Vite and its same-origin API proxy. Data defaults to
`.kaeno/data` (rather than the host's `/data`). Ctrl-C terminates both processes.
The empty Docker configuration satisfies host initialization; this profile has
no tools or workers, so it does not launch containers. For the full assistant,
use the root README's agent/worker and execution setup instead. Don't overwrite
an existing configuration or data directory. Existing model subscription login
and `KAENO_AUTH_FILE` work unchanged, entirely on the host.

No key? You can load and inspect threads but turns need a configured model and
credentials; server failure replies are displayed verbatim. The tests use an
explicit faux model, not a real provider account.

### Existing configured backend

```sh
KAENO_UI_API_URL=http://127.0.0.1:8080 npm run ui
```

This mode **does not start a backend**. Use it when `npm start` or a separately
managed Kaeno instance is already running. The UI shows connection failures and
retries polling automatically. `KAENO_UI_API_URL` is a host-side HTTP(S) origin
only (no path, credentials or query); it is never embedded in browser code.
Authenticated ingress requiring browser login/extra headers is not supported by
this development proxy. Do not put tokens in the URL or `VITE_` variables.

Settings (environment or the root `.env`, which is ignored by Git):

| Variable           | Default              | Purpose                                                    |
| ------------------ | -------------------- | ---------------------------------------------------------- |
| `KAENO_UI_PORT`    | `5173`               | Loopback UI port; fails rather than selecting another port |
| `PORT`             | `8080`               | Managed backend port; must be free and differ from UI port |
| `KAENO_UI_API_URL` | unset                | Proxy to an existing backend instead of spawning one       |
| `KAENO_CONFIG`     | `.kaeno/config.json` | Normal host configuration                                  |
| `KAENO_DATA_DIR`   | `.kaeno/data`        | Managed host's persistent databases                        |

Other model, auth, source and execution settings are the normal host settings.
Startup errors stay visible in the terminal and exit nonzero. Source refresh
startup has a 60-second health timeout; for a slow first source refresh, start
`npm start` with a writable data directory and use existing-backend mode once it
is ready.

## What the API can and cannot show

- Threads are server-backed. New conversation allocates a random thread key;
  it becomes persistent on first API access/submission, not a fake list entry.
- User messages are shown in this tab only and are lost on reload. The current
  API exposes **retained assistant replies**, not a complete conversation log.
  Replies from other clients are visible too. Server retention gaps are labeled.
- Replies are polled every second, not token-streamed. Turn acceptance does not
  mean completion; there is no fabricated busy/idle/task state. A server-side
  model failure is displayed as the server's reply.
- Stop calls `/v1/threads/:key/stop`. It is thread-wide and asynchronous, including
  work fenced by the server; navigating away or disconnecting does not stop work.
  The UI reports admission, not proven completion of cancellation.
- Failed submissions keep the draft; retrying unchanged text on the same thread
  reuses the request ID, even if the first response was lost. Editing the text
  starts a new request. Stop is available on selected threads, including after
  reload. No resets, tool controls, images, memory/routine editor or fake metrics.

## Security and checks

This is a **local development experience**, not a production public deployment.
The existing backend has **no transport authentication**; a token environment
variable does not secure it. Managed UI and backend bind to 127.0.0.1. Do not expose
them publicly; a remote backend needs a trusted network/authenticated ingress.
Vite's filesystem allowlist is restricted to UI sources and installed dependencies,
not host configuration/data. Provider keys and auth files stay server-side; never
prefix secrets with `VITE_` (Vite intentionally exposes such variables).
Messages render as plain text, not executable HTML or untrusted Markdown.

```sh
npm run verify       # root backend + UI typecheck/lint/format, all behavior tests
npm run ui:check     # DOM-only typecheck and production asset compilation
npm exec vitest -- run src/ui/chat.test.ts test/integration/ui.test.ts
```

Browser code has a separate DOM-only tsconfig and does not run through backend
layer rules; it still runs through root lint, format, typecheck and Vitest. The
production build is a compile check, not a standalone backend or deployment.
Integration tests exercise the actual root command, Vite-served assets and
proxy against real SQLite-backed Kaeno + ApiServer with an explicitly faux model;
a second case starts the actual configured host and verifies shutdown. DOM tests
exercise send/reply/stop, HTML safety, failed drafts and idempotent retry. These
are not screenshots or a claim of visual/browser verification.
