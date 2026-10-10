# Kaeno — isolated-assignment prototype

**Prototype, not the finished [Kaeno next architecture](docs/design/kaeno-next.html).** A long-lived local HTTP service owns a SQLite assignment ledger, authenticated API, versioned agent roster and browser client. Each assignment starts a **separate macOS Seatbelt process**, Pi Durable Harness, SQLite store, and writable workspace. The UI and API never open the agent's store. Two clients can observe the same saved state; leaving the page does not stop work.

## Run (macOS, Node 24+)

```sh
npm install
npm start
```

Open `http://127.0.0.1:4318/` and enter the bearer token from `.kaeno-next/token` (mode 0600). A separate terminal client uses `npm run client -- agents`, `npm run client -- assign researcher "Investigate …"`, `npm run client -- list`, `npm run client -- watch ID`, or `npm run client -- steer ID "New guidance"`. It uses the same API and detaches without stopping work. Remote CLI connections require `KAENO_URL` and `KAENO_TOKEN`, with HTTPS provided by a trusted reverse proxy. `/api/agents`, `/api/assignments`, `/api/assignments/:id`, `/api/assignments/:id/steer`, and `/api/events?after=N` expose the same functionality to other clients. POST requires a unique `requestId`; retries with the same assignment text and agent return its saved ID. Poll events with their increasing `seq` cursor. Do **not** expose this HTTP port directly on the internet: it binds to loopback, has no TLS or per-user identity, and the static browser page is not itself authenticated. An authenticated HTTPS reverse proxy / remote enrollment is still needed for access from everywhere.

By default, an **offline scripted provider** exercises Pi Durable and the architecture without making real model calls. It returns visibly labeled prototype responses; it is not a useful intelligent assistant. To test live OpenAI, start with `KAENO_OPENAI_API_KEY=... npm start` (the key is delivered to the worker process as an environment variable, not stored by the application). This live path has **not been verified** against OpenAI; the prototype's live Seatbelt profile currently permits outbound network traffic, not only OpenAI. Never use an untrusted profile or sensitive secrets in this mode.

The reviewed roster is created at `.kaeno-next/agents.json` on first startup. Stop the service before editing. Each entry specifies name, instructions, text skill/knowledge labels, and `[]` or `["read"]` tools. The service validates at startup and pins a SHA-256 revision and complete profile into each assignment. Editing the file changes **future** assignments after restart; it does not mutate running jobs. Workspaces start empty at `.kaeno-next/cells/ID/workspace`. The optional read tool can read only this workspace. There is no agent-controlled environment/key grant interface yet.

## What is proved and what is not

- Node SQLite commits assignments and events together; retries of a request ID converge to one assignment. Commands are saved before IPC delivery and replayed on worker startup with stable Pi request IDs.
- Each worker has its own Pi Durable store and separate process. Seatbelt restricts access to other files in the user's home directory, except approved application code/runtime and its own cell; it restricts writes in the home directory to that cell. Offline workers cannot use the network. **This is a prototype guard, not a hardened microVM/container sandbox:** paths outside home can remain accessible; live mode has outbound network; runtime/host administrators are trusted.
- On service restart, jobs formerly marked running become **blocked**, not automatically duplicated. An uncertain lost worker requires operator recovery; there is no migration/fencing proof, checkpoint restore, automatic resumption, or sandbox replacement yet. User data in the old `.kaeno/` is untouched and not imported.
- The persistent Pi Durable supervisor, bounded automatic reviews, skill bundles, brokered secrets, per-job grants, placement across cloud/self-hosted hardware, real remote authentication, and TLS are **next milestones**, not implemented here. The `/steer` endpoint is currently a human control-plane command, not autonomous supervision.

`npm run check` typechecks; `npm test` runs scripted-provider integration and OS-boundary checks on macOS. See [synthesis and gates](docs/design/kaeno-next-decision.md) for why the implementation is intentionally staged. Earlier design documents under `docs/design/` are historical evidence, not alternate live implementations.
