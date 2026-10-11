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
                                                  │ CHAT → start_work → background WORK conversation (same model)
                                                  │                        └─ optional delegate → WORKER (e.g. GPT)
                                                  │                             └─ read/write/edit/bash via RemoteExecutionEnv
                                                  ▼
                                        sandbox pod kaeno-sb-… (one per delegation) — envd: files + shell in /workspace
                                        internet + GitHub SSH · no cluster/LAN/tailnet access · no credentials but the deploy key
```

## How it works

- **Durable**: a message is admitted to a thread's conversation before anything runs. If kaeno restarts, every run,
  delegation and Telegram/scheduled turn resumes where it stopped; paused delegations keep their sandbox. A tool call
  the restart cut off is reported to the model as interrupted, never silently rerun. Clients only watch: closing pi
  or losing the connection never stops work. Retrying the same request ID returns the original CHAT reply; later work
  results have their own durable reply IDs.
- **Conversational work**: CHAT answers ordinary conversation and acknowledges substantial requests immediately.
  Each request gets a fresh background WORK conversation for reasoning, planning, review and retries. WORK may finish
  without workers; shell/files/Git execution uses disposable WORKERs. New workers are execution leaves; WORK owns fanout.
  Models/templates remain configured as before. At most 32 active work requests per chat and four sandbox pods globally.
  Durable FIFO admission and confirmed deletion govern capacity; no warm worker fleet or persistent task workspace.
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
thinking; its short CHAT answer is the reply. The token is read from `~/.config/kaeno/token`.
Background completion is **not automatically injected into pi's TUI** in this MVP: ask Kaeno for job status/results or
retrieve the API reply feed. Telegram receives proactive completion messages.

**Telegram**: create a bot with @BotFather, add its token to the `kaeno` Secret as `telegram-bot-token`, message the
bot once (it replies with your chat id), and add that id to `telegram.allowedChatIds` in `config.json`.
`/jobs` lists work; `/cancel <id>` requests cancellation of one job. `/stop` fences queued inputs and cancels this
chat's current response and work. `/new` resets CHAT context but preserves work; later old-context results are labelled.
Cancellation remains `cancelling` until descendant/pod cleanup completes. Replies already claimed for dispatch cannot
be unsent; Telegram delivery is at-least-once (including possible repeated chunks on retry).

**Schedules**: in `config.json`:
`{"name": "morning", "cron": "0 7 * * 1-5", "timezone": "Europe/Berlin", "prompt": "…", "notify": {"telegram": <chat id>}}`.
Each slot fires once (even across restarts); slots missed while kaeno was down are skipped.

**GitHub**: sandboxes use the deploy key in Secret `kaeno-github-ssh`; add its public half
(`~/.config/kaeno/github_deploy_key.pub`) to GitHub (account key or per-repo deploy key).

**API** (`homelab-kaeno:8080`, bearer token): `POST /v1/threads/:key/turn {text, requestId}` streams NDJSON
(`trace` lines, then `done`/`error` for this CHAT reply); `POST /v1/threads/:key/abort`; `GET /v1/threads`.
`GET /v1/threads/:key/work` lists jobs. `GET /v1/threads/:key/replies?after=0` returns ordered replies, a `next` cursor and
`truncated` flag; save the cursor to retrieve later completions independently of POST/disconnect. The last 500 replies
are retained, with 512 recent admission/job entries plus active entries. Chats admit up to 64 pending replies before
rejecting/deferring new user input. Work-report request IDs are reserved for the application.

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
Without a ref, **each kaeno startup fetches the current default-branch HEAD**, not the latest release. Missing refs,
skills or inaccessible sources fail startup before any agent resumes or accepts turns. Repository IDs are
case-insensitive; skill names are the `name` in SKILL.md frontmatter.

To assign every discovered skill from a declared repository, use `"mjrmyr/myriad:*"` in a template's `skills` array.
The wildcard is scoped to that repository, expanded at startup against the resolved commit, and sorted by skill ID.
It can be mixed with explicit selections; overlaps are deduplicated while preserving selector order. Empty wildcard
repositories, ambiguous names and invalid trees fail startup. Limits apply to the expanded binding. Wildcards do
not bypass validation, grant tools or propagate assignments to other templates. Existing tasks retain concrete
skill IDs/hashes; new upstream skills appear only after a refresh for new agents/idle threads.

Kaeno fetches sources and runs **`npx skills@1.7.2 add` at runtime**, with validation before/after installation.
You do not install anything manually. Selected skill trees are published by content hash to the dedicated
`kaeno-skills` PVC; Git checkouts/installer lockfiles are temporary and removed. npm's package cache is persistent,
but never constrains Git refs. Commits/tree hashes are provenance, not a next-startup lock.

**Images are generic: builds neither read your agent config nor contain skill content.** After this application
version is deployed, add/change repositories, refs or assignments in homelab config and push it; Flux's generated
ConfigMap rolls kaeno, which resolves the new configuration. No kaeno image rebuild is needed. There is no periodic
Git polling or in-process config watcher; restart kaeno to refresh unpinned sources without a config change.

**Only public GitHub skill repositories are supported.** Fetching is anonymous: Git does not inherit credentials,
askpass, auth headers or global/system configuration. Private/inaccessible repositories fail startup rather than
prompting for authentication. No extra GitHub Secret is needed; workers' existing SSH deploy keys are unchanged.
Unsupported links, ambiguous names, nested skill/plugin discovery controls or omitted/changed installer assets
fail explicitly.

Agents see assigned skill descriptions and use **`read_skill`** to load instructions/references lazily. Kaeno can
use it without a shell. Workers have **only their assigned skill files** at
`/workspace/.agents/skills/<owner>/<repo>/<skill>` (read-only; use the writable workspace for output).
A credential-free, network-free init container mounts the cache PVC read-only and copies them before envd starts.
**The worker never mounts the cache**—only its dedicated selected-output volume. SQLite is on a separate PVC and is
never mounted by init. Neither image contains skills. Skills do not install dependencies, grant tools or credentials.

A task freezes its skill binding, tree hashes, execution image digest and cache PVC claim. A recreated pod recovers
those exact skills, not its lost task workspace. Busy root threads and existing children retain their selections;
idle roots/new children use the newly resolved catalogue. Keep old execution images and cache trees available while
tasks depend on them. Existing pre-runtime-cache children can replay their old source-image pins, but no new child
uses image-backed skills. Omitted skill configuration remains compatible; old cache trees are still retained.

The cache is 5Gi and currently has no garbage collection: do not prune/delete it while durable tasks may depend on
it. local-path/RWO keeps kaeno and its workers on the same storage node (appropriate for this single-node homelab).

Limits: 64 MiB/4096 files per tree, 256 KiB per text document, 2 MiB text per skill, 8 MiB text per agent binding,
and at most 256 skills per agent. Binary assets stay in the sandbox, not in text tool responses.

See [the architecture](architecture/skills.md) for lifecycle and verification details.

## Develop and deploy

```sh
npm test          # conformance, skills/Git/CLI fixtures, durable upgrades/recreation, channels, config, cron
npm run check     # typecheck (erasableSyntaxOnly: the image runs TypeScript with Node's type stripping)
npm run deploy    # build/push generic sibling images on the node, pin kaeno in ../homelab
# Review/commit the relevant homelab apps/kaeno changes, then push; Flux rolls it out.
```

Tests use local Git fixtures and faux models; runtime preparation tests invoke the actual pinned skills CLI
(npm access may be needed). `sh scripts/verify-runtime-skills.sh` is an opt-in Docker smoke: it builds generic images,
checks every layer of both images, creates runtime Git fixtures in temporary volumes, runs the real installer as
UID10001 with a read-only root, and verifies assigned-only mounting/script execution. It never pushes or deploys.

First activation of runtime skills requires deploying this application version and the new cache PVC/mounts together.
Thereafter, skill changes are config-only: commit/push `apps/kaeno/config.json` in homelab; watch rollout/logs for
`skills: … (runtime)`, then test a fresh task. Image rebuilding is only for application/toolchain changes.

See [ROADMAP.md](ROADMAP.md) for what comes next.
