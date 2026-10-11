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
  `sandbox`, `tools` (`read`, `write`, `edit`, `bash`), `skills`, and `delegates` (templates it may start sub-agents from).
  Idle threads refresh their template at startup/admission; busy threads and sub-agents retain their bound skills.
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

## Agent skills

Declare source repositories in homelab's `apps/kaeno/config.json`, then select skills per template:

```json
{
  "skillRepositories": ["poteto/p-stack:v0.2.4", "mattpocock/skills"],
  "templates": {
    "kaeno": { "skills": ["mattpocock/skills:grill-me"] },
    "worker": { "skills": ["poteto/p-stack:poteto-mode"] }
  }
}
```

Other existing config fields are omitted above. Repository versions are optional Git refs (tag, branch or commit).
Without a ref, **every build fetches the current default-branch HEAD**, not the latest release. Missing refs/skills
fail the build. Repository IDs are case-insensitive; skill names are the `name` in SKILL.md frontmatter.

`npm run deploy` snapshots the config, resolves sources, and runs **`npx skills@1.7.2 add`** on selected local skill
trees. You do not install anything manually. Resolved commits are recorded as provenance, not a lockfile. The CLI
needs npm network access on first use; private sources use your build machine's normal Git authentication, never
sandbox credentials. Unsupported source links, ambiguous names or omitted/changed installer files fail explicitly.

Agents see assigned skill descriptions and use **`read_skill`** to load instructions/references lazily. Kaeno can
use it without a shell. Workers have **only their assigned skill files** at
`/workspace/.agents/skills/<owner>/<repo>/<skill>` (read-only; use the writable workspace for output).
A credential-free init container copies them before envd starts. The full store is absent from every layer of the
worker image. Skills do not automatically install dependencies, grant tools or provide credentials.

A task freezes its skill binding and both source/execution image digests. A recreated pod recovers those skills,
not its lost task workspace. Keep both images available while tasks depend on them. Config-only reassignment works
for already-bundled skills with the same source refs; new skills or changed refs require rebuilding. Omitted skill
configuration remains compatible and produces an empty bundle.

Limits: 64 MiB/4096 files per tree, 256 KiB per text document, 2 MiB text per skill, 8 MiB text per agent binding,
and at most 256 skills per agent. Binary assets stay in the sandbox, not in text tool responses.

See [the architecture](architecture/skills.md) for lifecycle and verification details.

## Develop and deploy

```sh
npm test          # conformance, skills/Git/CLI fixtures, durable upgrades/recreation, channels, config, cron
npm run check     # typecheck (erasableSyntaxOnly: the image runs TypeScript with Node's type stripping)
npm run deploy    # resolve skills, build/push sibling images on the node, pin kaeno in ../homelab
cd ../homelab && git commit -am "kaeno: new image" && git push   # Flux rolls it out
```

Tests use local Git fixtures and faux models; the builder test invokes the actual pinned skills CLI (npm access
may be needed if it is not cached). The optional `scripts/verify-skill-images.sh` checks Docker layers and selected-only
mounting with a prepared fixture context; it never pushes or deploys images.

See [ROADMAP.md](ROADMAP.md) for what comes next.
