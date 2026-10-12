# Kaeno

An always-on, durable orchestrator agent on the homelab. You talk to it from **pi** or **Telegram**. Kaeno is a real agent (built on `@earendil-works/pi-durable`): it reasons, delegates work to
sub-agents, checks their reports, and answers. Sub-agents are created from **agent templates** (model per template,
Anthropic or OpenAI) and, when sandboxed, run all their tools in a **dedicated pod** with internet access and git over
SSH to GitHub.

```
pi (extension) ─┐                                 kaeno pod (Deployment, ns kaeno)
Telegram bot ───┘─ HTTP/API · long polling ─▶  pi-durable Harness ── SQLite on PVC (every thread, sub-agent, tool call)
                                                  │ thread conversation (template "kaeno", e.g. Claude)
                                                  │ CHAT → start_work → background WORK (selected template)
                                                  │                        └─ optional delegate → WORKER (e.g. GPT)
                                                  │                             └─ read/write/edit/bash via RemoteExecutionEnv
                                                  ▼
                                        sandbox pod kaeno-sb-… (one per delegation) — envd: files + shell in /workspace
                                        internet + GitHub SSH/API · no cluster/LAN/tailnet access · scoped GitHub credentials only
```

## How it works

- **Durable**: a message is admitted to a thread's conversation before anything runs. If kaeno restarts, every run,
  delegation and Telegram turn resumes where it stopped; paused delegations keep their sandbox. A tool call
  the restart cut off is reported to the model as interrupted, never silently rerun. Clients only watch: closing pi
  or losing the connection never stops work. Retrying the same request ID returns the original CHAT reply; later work
  results have their own durable reply IDs.
- **Conversational work**: CHAT answers ordinary conversation and acknowledges substantial requests immediately.
  Each request gets a fresh background WORK conversation for reasoning, planning, review and retries. WORK may finish
  without workers; shell/files/Git execution uses disposable WORKERs. New workers are execution leaves; WORK owns fanout.
  CHAT stays on `config.agent`; each `start_work` explicitly selects an eligible configured template for a distinct
  WORK conversation. At most 32 active work requests per chat and four sandbox pods globally.
  Durable FIFO admission and confirmed deletion govern capacity; no warm worker fleet or persistent task workspace.
- **Threads**: one durable conversation per channel key: `pi:<pi session id>`, `telegram:<chat id>`.
- **Agents**: `config.json` (ConfigMap `kaeno-config`) defines templates: `model`, `thinkingLevel`, `instructions`,
  `sandbox`, `tools` (`read`, `write`, `edit`, `bash`), `skills`, and `delegates` (templates it may start sub-agents from).
  Idle threads refresh their template at startup/admission; busy threads and sub-agents retain their bound skills.
- **Sandbox** (`src/k8s.ts` → `sandboxPod`): per delegation, a pod running `envd` (`src/envd.ts`), pi-durable's
  `NodeExecutionEnv` behind a small HTTP protocol (`src/remote-env.ts`, passes pi-durable's env conformance suite).
  Own emptyDir workspace, read-only root, non-root, no ServiceAccount token. NetworkPolicy: public internet only.
  Deleted when the delegation ends; a sweeper removes any a crash left behind.

## WORK template selection

CHAT's primary is always `config.agent` (currently `kaeno` in tracked homelab config). `start_work` takes
`{agent, title, brief}`: its dynamically built string enum offers the primary plus its **direct** configured
`delegates`, deduplicated in configuration order, with names/descriptions. Unrelated or transitively reachable
only templates are not selectable WORK roots. There is no implicit/default selection. For example:

```json
{
  "agent": "kaeno",
  "templates": {
    "kaeno": {
      "description": "Conversational front desk and general coordinator",
      "model": "anthropic/your-chat-model",
      "instructions": "Answer the user and coordinate substantial requests.",
      "delegates": ["swe"]
    },
    "swe": {
      "description": "Software engineering profile",
      "model": "openai/your-engineering-model",
      "thinkingLevel": "high",
      "instructions": "Plan engineering tasks and verify concrete results.",
      "sandbox": true,
      "tools": ["read", "write", "edit", "bash"],
      "delegates": ["worker"]
    },
    "worker": {
      "description": "Execution worker",
      "model": "openai/your-worker-model",
      "instructions": "Execute the supplied task and report verified results.",
      "sandbox": true,
      "tools": ["read", "write", "edit", "bash"]
    }
  }
}
```

This is an illustrative config, **not** a homelab change. CHAT can select `kaeno` or `swe`, not `worker`.
Selection freezes the root in `WorkBlueprint.agent`, its template/model/thinking/profile and skill binding,
reachable templates, execution image and skill-cache claim. WORK keeps the selected base instructions/skills
plus WORK lifecycle instructions, but gets **no CHAT controls, coding tools or sandbox**, even when the selected
profile is sandboxed. WORK can reason/draft itself and delegate only its selected root's frozen `delegates`.
WORKERs get their execution profile/tools, but never work controls or delegation, even on legacy replay without
a blueprint. A missing frozen delegate fails rather than using current config.

A selected profile with no delegates is **reasoning-only WORK**. In the currently tracked homelab config,
`swe` has coding tools/skills but no delegates: choosing it as WORK does not let it execute those tools.
Choosing `kaeno` as WORK still allows its configured `swe` WORKER. Supporting execution under a selected `swe`
WORK would require a separate, reviewed configuration change to give it an execution target; this implementation
does not change live/tracked homelab config, secrets or deployment.

### Durable replay and upgrade policy

Admission checks the existing request receipt **before** selecting/capturing against current config. Same
request ID/title/brief returns the same work ID and frozen template; a different explicit template or changed
brief/title conflicts. Each new request must select explicitly. Already queued/active tasks with valid frozen
blueprints retain their choice even when current config removes or changes that template.

The durable SDK validates new tool calls, but does not revalidate stored execute-phase arguments on recovery:
- An old `start_work` execute intent without `agent` returns its already-admitted task only when title/brief
  match and its frozen blueprint root is valid.
- An old call without `agent` that never admitted work fails clearly. It does **not** silently choose `kaeno`.
  Submit a new user request with a new request ID and explicit selection.
- Old tasks missing a blueprint or with an invalid/missing frozen root cannot resume safely. They fail visibly
  in durable task status (`/jobs` / work API) rather than guessing a root. Cancel/inspect and submit a fresh request;
  there is no automatic data migration or fabricated blueprint.

Before upgrading, inspect/drain or cancel incompatible old work and nested workers. Legacy WORKER delegations
are now blocked, rather than preserving nested fanout on replay. Back up SQLite through the existing operations
process; retain frozen execution images and skill-cache trees for valid active tasks. Rollout refreshes idle CHAT
catalogues; busy conversations keep their current durable agent surface until idle. No deployment is performed
by this change. The primary name/config need not change.

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

**GitHub**: sandboxes use the deploy key in Secret `kaeno-github-ssh`; add its public half
(`~/.config/kaeno/github_deploy_key.pub`) to GitHub (account key or per-repo deploy key).

### GitHub CLI for workers

The sandbox image includes `gh`. Worker pods optionally read `GH_TOKEN` from Secret **`kaeno-github-api`**, key
**`token`**, and disable interactive prompts. Missing Secret/key does not prevent workers from starting; authenticated
`gh` commands will require the token. Neither Kaeno nor skill initialization receives it. Keep using SSH remotes for
Git clone/push; `gh` uses the PAT for API operations (PRs, issues, workflow inspection).

Create a fine-grained PAT for selected repositories, with an expiry and only necessary permissions. Typical coding
access: Contents read, Pull requests read/write, Issues read/write, Actions read. Organization approval may be required.
**Every worker receives this token when configured and can read it through shell tools**; skills do not limit its scope.
The existing SSH key independently controls Git write access.

Prepare the encrypted Secret locally (requires `kubectl`, `sops`, `python3`; prompts for the PAT without echo):

```sh
bash scripts/configure-github-token.sh
# Optional: bash scripts/configure-github-token.sh /path/to/homelab
```

This writes `apps/kaeno/github-api.secret.enc.yaml` in the homelab checkout using its SOPS creation rule, and adds the
resource to its kustomization. It does **not** apply, commit or push. No plaintext token file, environment export or
command-line token argument is used. Run it again to rotate the credential without duplicating the resource reference.
Review the encrypted changes before pushing. Build/deploy the new images normally; a Secret-only rotation affects
**new** worker pods, not existing pods' environment. No `gh auth login` or persistent credentials file is needed.

Verify from a new running worker after rollout:

```sh
kubectl -n kaeno exec <worker-pod> -c envd -- gh --version
kubectl -n kaeno exec <worker-pod> -c envd -- gh auth status
kubectl -n kaeno exec <worker-pod> -c envd -- gh repo view OWNER/REPO
```

Never print `GH_TOKEN` or use `gh auth token` with the real credential in logs. Anonymous skill retrieval is unchanged.

**API** (`homelab-kaeno:8080`, bearer token): `POST /v1/threads/:key/turn {text, requestId}` streams NDJSON
(`trace` lines, then `done`/`error` for this CHAT reply); `POST /v1/threads/:key/abort`; `GET /v1/threads`.
`GET /v1/threads/:key/work` lists jobs. `GET /v1/threads/:key/replies?after=0` returns ordered replies, a `next` cursor and
`truncated` flag; save the cursor to retrieve later completions independently of POST/disconnect. The last 500 replies
are retained, with 512 recent admission/job entries plus active entries. Chats admit up to 64 pending replies before
rejecting/deferring new user input. Work-report request IDs are reserved for the application.

## Agent logs

Agent tracing is always enabled in the main Kaeno process; no flag or worker-pod log subscription is needed:

```sh
kubectl -n kaeno logs deployment/kaeno -f --tail=100
```

JSON lines on **stdout** with `type: "agent_trace"` and ISO `time` include conversation/task IDs, role
(`chat`, `work`, `worker`; `legacy` if unknown), template, work ID and sandbox pod where applicable. Events cover model requests/responses, provider-exposed thinking,
assistant text, model-proposed tool calls, and tool starts/results. Background WORK and WORKER traces continue after CHAT acknowledges,
without a connected pi/API observer. Model text/thinking is logged when each response completes, not token by token.
This also covers resumed conversations; recovery can repeat log records. Logs are diagnostic, not a durable event feed.

Content is limited to 8,192 characters per record (`truncated: true` marks clipping). Known credential values,
common API-token formats, bearer tokens and private-key blocks are redacted best-effort; images, opaque thinking
signatures and tool result metadata are omitted. **Conversation and tool content can still contain sensitive data.**
Treat pod logs as private; don't print credentials in agent commands. Kubernetes log rotation limits retained history,
and reasoning the provider does not expose cannot be logged. Worker `envd` logs remain execution-service diagnostics.

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

## Published container images (GHCR)

[Publish GHCR images](.github/workflows/publish-images.yml) builds and pushes two generic **linux/amd64** images
on pushes to `main` and Git tag creation (tag pushes):

| Image | Dockerfile target | Purpose |
| --- | --- | --- |
| `ghcr.io/mjrmyr/kaeno` | `kaeno` | Orchestrator |
| `ghcr.io/mjrmyr/kaeno-sandbox` | `sandbox` | Execution workers and skill initialization |

Both receive `sha-<7-character-commit-SHA>` tags (for example, `sha-f908b9e`). After both main builds succeed,
a separate promotion job updates `main` and `latest`; these are moving main-build aliases, **not** latest-release
aliases. Git tags publish their exact name
(for example, `v1.2.3`, with the `v` preserved), without updating `main`/`latest`. Version tags must be valid Docker
tags (1–128 ASCII letters, digits, underscores, periods or hyphens; no leading period/hyphen). `main`, `latest` and
`sha-*` are reserved; invalid/reserved Git tags fail before publishing rather than being silently renamed.

Sandbox is pushed first; kaeno embeds its GHCR `@sha256:…` digest in `/app/build-info.json`. SHA tags are
commit-specific, not moving aliases, but GHCR does not enforce tag immutability: a rebuild of the same commit can
replace them. Use **digest references** for immutable deployment pins and retain old sandbox digests while durable
tasks depend on them. Pulling kaeno alone does not make its pinned sandbox available to Kubernetes.

Alias promotion is serialized by the repository-wide `ghcr-main-aliases` Actions concurrency group, with
`cancel-in-progress: false`: a new run does not interrupt an active two-image promotion. After acquiring that
slot, the job reads the live `refs/heads/main` through the GitHub API and skips all alias writes unless it matches
the run's full commit SHA; API errors fail closed. Stale/retried builds still publish SHA/version tags, but cannot
promote aliases. Promotion copies the two build output **digests**, not mutable SHA tags, so a concurrent rebuild
cannot substitute a different sandbox/kaeno pair.

This is not a registry transaction: GHCR updates four tags across two images independently. Main can advance
after the HEAD check; an already-admitted promotion finishes its pair before another promotion can start.
Manual cancellation, runner loss or registry errors can still leave partially updated aliases. Actions also keeps
only one pending job per concurrency group (not FIFO); a later pending job can replace an earlier one, and a stale
replacement will skip rather than publish. If the newest build fails or its promotion is displaced, aliases may
remain on an older pair until a successful run/rerun for current main. Rerunning current main reconciles all four
aliases; rerunning an old commit does not. Deployments requiring consistent immutable pins must use digests, not
these moving aliases.

```sh
# After authenticating (see below), pull either main or a specific version/SHA tag:
docker pull ghcr.io/mjrmyr/kaeno:main
docker pull ghcr.io/mjrmyr/kaeno-sandbox:main
# For deployments, use ghcr.io/mjrmyr/kaeno@sha256:<published-digest>.
```

The workflow uses only `GITHUB_TOKEN` with `contents: read` and `packages: write`; no publishing PAT is needed.
It publishes images only: no deployment, homelab pin updates, package visibility changes or PR builds. The source
repository stays private; newly created GHCR packages are private by default. Keep both packages private. If an
existing package denies publication, its administrator must check repository linkage/Actions access; this workflow
does not change those settings. The existing `npm run deploy` local-registry workflow is unchanged.

### Pulling private GHCR images

For local pulls, use a **separate personal access token (classic)** with `read:packages`, belonging to a GitHub user
with read access to both packages. Authorize SSO if required. A worker's fine-grained GitHub API token described
above is not a GHCR pull credential. To avoid putting the token in shell history or process arguments, in Bash:

```bash
read -r -p 'GitHub username: ' GHCR_USER
read -r -s -p 'GHCR read:packages token: ' GHCR_PULL_TOKEN; printf '\n'
printf '%s' "$GHCR_PULL_TOKEN" | docker login ghcr.io --username "$GHCR_USER" --password-stdin
unset GHCR_PULL_TOKEN
```

Docker stores login credentials through its configured credential helper (or Docker config); protect that storage
and use `docker logout ghcr.io` when finished. Never print tokens or commit Docker credentials.

Kubernetes nodes must also authenticate to GHCR for **both** images. Provision a
`kubernetes.io/dockerconfigjson` image-pull Secret in namespace `kaeno` through your existing encrypted-secret
process, then configure **both** of these pull paths:

- **Orchestrator:** attach the Secret via `imagePullSecrets` to the ServiceAccount selected by the kaeno
  Deployment's `spec.template.spec.serviceAccountName` (or to that Deployment's pod template). The Deployment
  lives in the homelab configuration, not this repository; inspect it for the actual account name, including
  `default` if no name is specified.
- **Dynamic workers:** attach the Secret via `imagePullSecrets` to the **`kaeno-sandbox` ServiceAccount** in the
  same namespace. [`sandboxPod` in `src/k8s.ts`](src/k8s.ts) explicitly sets
  `serviceAccountName: "kaeno-sandbox"` and does not set pod-level `imagePullSecrets`, so Kubernetes admission
  inherits that account's pull Secrets for newly created pods. This covers both the `envd` container and the
  optional `skills` init container in the **same worker pod**, including any retained skill-source image pins.
  `automountServiceAccountToken: false` disables the in-pod API token, not node image-pull authentication.

Configuring only the orchestrator's account/template does **not** cover worker pods; pull Secrets are not
inherited from the pod that creates them. Apply account changes before creating replacement pods; existing pods
do not acquire updated ServiceAccount pull Secrets automatically. Do not commit plaintext credentials. Worker
`GH_TOKEN` is for API calls inside an already-running container and cannot authenticate a node's image pull.
Cluster pull-auth setup and switching from the existing local registry are separate deployment work, not performed
by this publishing workflow.

## Local structured logs

Operational `log()` in `src/log.ts` writes one JSON line per event to **stderr**; it does not write to stdout.
[Agent traces](#agent-logs) remain on **stdout**, with their distinct content/redaction policy. Startup/shutdown,
Harness reports and the sweep catch in `src/kaeno.ts` use operational logging. This is an incremental migration:
existing skills, API, Telegram, sandbox-removal and envd raw logs remain unchanged, so process output is still mixed-format and
those older logs do **not** inherit this logger's privacy policy. HTTP traces and envd protocol output are unchanged.
Loki/Grafana could collect these local JSON events in future; no collector or integration is configured here.

```ts
log("info", "kaeno", "app.started", { agentCount: 2, port: 8080, telegram: false });
log("error", "harness", "harness.error", {}, error);
log("info", "kaeno", "app.stopping", { signal: "SIGTERM" });
```

Operational records contain `type: "app_log"`, ISO `time`, `level`, `component`, `event`, optional nested `context`,
and optional `error: { kind }`. Debug is off (fixed info threshold), with no new environment/config setting. Component/event
are constants at call sites. Context must contain only caller-selected safe scalar facts: **no prompts, user bodies,
config/env values, tokens, URLs or error text** (the listening port and boolean feature status are intentional safe
operational facts). Runtime projection omits non-scalars, non-finite numbers and accessors; it never calls `toJSON`.
It is not a content scrubber: a string can still contain secrets, so callers must select safe fields. Errors expose
only a built-in allowlisted kind or `unknown`, never messages, stacks, arbitrary names/codes/causes/properties or
string throws. Empty context and absent errors are omitted. Synchronous logging/output failures are swallowed.

### Design rationale

`log(level, component, event, context?, error?)` keeps operational call sites direct. Both it and `src/agent-logs.ts`
use the tiny dependency-free `writeJsonLog(record, write)` export to serialize JSON and invoke an explicit writer,
swallowing synchronous serialization/output failures. This is shared mechanism only: no global sink, factory or
configuration. Agent logging still owns its fields, correlation, snapshot handling, redaction and clipping;
operational scalar/error policies do not apply to agent content, which remains distinct and sensitive.
Positional context/error preserve the small agreed usage without another options wrapper. We rejected an event catalog (couples the utility to domain
events), a logger factory (unneeded state/indirection), and four severity methods (extra interface for the same work).
**Laziness protocol** keeps this to one module and a few lifecycle/error sites, with no dependencies, sinks or loop
success logs. **Minimize reader load** leaves severity and event visible at each call site. **Boundary discipline**
concentrates defensive scalar projection and unknown-error handling at the output boundary. Nested context cannot
overwrite envelope fields. The accepted tradeoff is privacy over diagnostic detail: coarse error kinds need other
investigation paths, and unconverted raw logs still need a separate migration/review.

## Develop and deploy

**Upgrading from a version with schedules:** remove `schedules` from the live ConfigMap, then restart/roll out
the **old image** with that config (live ConfigMap edits do not reload the running process). Only then let
already-admitted turns, work and Telegram deliveries finish before upgrading. To stop unwanted work, use `POST /v1/threads/:key/abort` for each affected thread (the old default was `schedule:<name>`; custom keys
may differ), then wait for cancellation and delivery to settle. The upgrade stops new firings but still resumes
unfinished durable work, which can message Telegram. Old threads/history and `kaeno.schedules` records remain in
SQLite; the slot records are no longer read. A leftover config key is silently ignored by this version, but rolling
back to an old image with non-empty `schedules` enables cron again; keep it removed on rollback.

```sh
npm test          # conformance, skills/Git/CLI fixtures, durable upgrades/recreation, channels, config
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
