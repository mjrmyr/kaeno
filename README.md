# Kaeno

An always-on, durable orchestrator agent on the homelab. You talk to it from **pi**, **Telegram**, or let it run
**scheduled tasks**. Kaeno is a real agent (built on `@earendil-works/pi-durable`): it reasons, delegates work to
sub-agents, checks their reports, and answers. Sub-agents are created from **agent templates** (model per template,
Anthropic or OpenAI) and, when sandboxed, run all their tools in a **dedicated pod** with internet access and git over
SSH to GitHub.

```
pi (extension) ─┐                                 kaeno pod (Deployment, ns kaeno)
Telegram bot ───┼─ HTTP/API · long polling ─▶  pi-durable Harness ── SQLite on PVC (every thread, sub-agent, tool call)
schedules ──────┘                                 │ thread conversation (template "kaeno", e.g. Claude)
                                                  │   └─ delegate tool → child conversation (template "worker", e.g. GPT)
                                                  │         └─ its read/write/edit/bash run via RemoteExecutionEnv
                                                  ▼
                                        sandbox pod kaeno-sb-… (one per delegation) — envd: files + shell in /workspace
                                        internet + GitHub SSH · no cluster/LAN/tailnet access · no credentials but the deploy key
```

## How it works

- **Durable**: a message is admitted to a thread's conversation before anything runs. If kaeno restarts, every run,
  delegation and Telegram/scheduled turn resumes where it stopped; paused delegations keep their sandbox. A tool call
  the restart cut off is reported to the model as interrupted, never silently rerun. Clients only watch: closing pi
  or losing the connection never stops work, and re-asking with the same request ID returns the result.
- **Threads**: one durable conversation per channel key: `pi:<pi session id>`, `telegram:<chat id>`, `schedule:<name>`.
- **Agents**: `config.json` (ConfigMap `kaeno-config`) defines templates: `model`, `thinkingLevel`, `instructions`,
  `sandbox`, `tools` (`read`, `write`, `edit`, `bash`), and `delegates` (templates it may start sub-agents from).
  Threads re-read their template on every start; sub-agents use the current template when created.
- **Sandbox** (`src/k8s.ts` → `sandboxPod`): per delegation, a pod running `envd` (`src/envd.ts`), pi-durable's
  `NodeExecutionEnv` behind a small HTTP protocol (`src/remote-env.ts`, passes pi-durable's env conformance suite).
  Own emptyDir workspace, read-only root, non-root, no ServiceAccount token. NetworkPolicy: public internet only.
  Deleted when the delegation ends; a sweeper removes any a crash left behind.

## Use it

**pi**: the extension in `pi-extension/kaeno` (symlinked into `~/.pi/agent/extensions/kaeno`) registers the model
`kaeno/kaeno`. Run `pi --model kaeno/kaeno`. Kaeno's live trace, including the sub-agents' commands, appears as
thinking; its answer is the reply. The token is read from `~/.config/kaeno/token`.

**Telegram**: create a bot with @BotFather, add its token to the `kaeno` Secret as `telegram-bot-token`, message the
bot once (it replies with your chat id), and add that id to `telegram.allowedChatIds` in `config.json`.
`/stop` aborts the current work, `/new` starts a fresh context.

**Schedules**: in `config.json`:
`{"name": "morning", "cron": "0 7 * * 1-5", "timezone": "Europe/Berlin", "prompt": "…", "notify": {"telegram": <chat id>}}`.
Each slot fires once (even across restarts); slots missed while kaeno was down are skipped.

**GitHub**: sandboxes use the deploy key in Secret `kaeno-github-ssh`; add its public half
(`~/.config/kaeno/github_deploy_key.pub`) to GitHub (account key or per-repo deploy key).

**API** (`homelab-kaeno:8080`, bearer token): `POST /v1/threads/:key/turn {text, requestId}` streams NDJSON
(`trace` lines, then `done`/`error`); `POST /v1/threads/:key/abort`; `GET /v1/threads`.

## Develop and deploy

```sh
npm test          # env conformance (24 cases), durable delegation with a restart mid-command, channels, config, cron
npm run check     # typecheck (erasableSyntaxOnly: the image runs TypeScript with Node's type stripping)
npm run deploy    # build on the node, push to localhost:5000, pin the digest in ../homelab/apps/kaeno
cd ../homelab && git commit -am "kaeno: new image" && git push   # Flux rolls it out
```

See [ROADMAP.md](ROADMAP.md) for what comes next.
