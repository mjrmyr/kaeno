# Kaeno

> in one sentence, what is kaeno?
> why did i build kaeno?
> -> should mention dots, grok bot, muse, pi, pi durable (my inspiration for this project)
> how was kaeno build?
> -> should explain the principles, and primitives used
> how to get kaeno up and running?

Kaeno is a small, self-hosted durable conversation and work host. Threads, turns, activity reports, cancellation fences and WORK orchestration use one pi-durable runtime. Agents are a core concept: WORK stores the agent each work runs as and the plan frozen at root admission, and resolves agent names. Where agents and skills come from is not: Markdown and repository definitions, catalogs and skills are extensions, and the durable core never reads their files.

The CLI loads one owner configuration using `KAENO_CONFIG` (default `.kaeno/config.json`). It names public GitHub repositories and explicitly selects Kaeno and the available workers. `workers` takes `source:name` IDs or `source:*`, which selects every agent of that source except the one Kaeno runs as (list it explicitly to make it a worker too); a wildcard fails rather than skip a source with invalid agent records. Every agent, Kaeno included, gets its skills from the `skills` field of its own profile. Repository fetching and the immutable cache are host-side. Local source definitions use the same catalog and loader; the only deployment difference is the persistent storage directory (ordinary disk locally, PVC on Kubernetes).

By default, Kaeno and every spawned worker have `list_skills` and `read_skill`, even with no assigned skills. They discover assigned skill IDs and descriptions with `list_skills`, then load relevant instructions with `read_skill`. An empty list means none are available for automatic use.

## Run

Node.js 24 or newer:

```sh
npm ci
mkdir -p .kaeno
cp kaeno.config.example.json .kaeno/config.json
cp docker.config.example.json .kaeno/docker.json
export OPENAI_API_KEY=...
export KAENO_DATA_DIR="$PWD/.kaeno/data"
npm start
```

Kaeno has WORK orchestration tools by default, independently of its assigned skills or configured workers. With no workers configured, it can explain why it cannot delegate and still manage existing work. Explicit `tools` lists remain authoritative.

Edit `kaeno.config.example.json` to choose repositories, a Kaeno profile and worker profiles. The example pins a Myriad profile commit; update the pin intentionally when selecting a newer revision. Copy the configuration locally and use a persistent source cache. Each repository declaration explicitly selects a definition-reader `provider`: `github` for public repositories, or `github-app-<installationId>` for the host-only App reader configured by `KAENO_GITHUB_CONFIG`. Both are provided by the installed GitHub integration; public definitions require no App key or GitHub agent tools. Older shorthand/provider-less declarations need conversion and one source refresh before offline use; see [definition readers](docs/extensions.md#definition-readers).

The CLI uses Docker for worker environments by default. Select Docker, [microsandbox microVMs](docs/microsandbox.md), or the optional [Kubernetes extension](docs/kubernetes.md) through `execution.provider` and `execution.configFile` in `KAENO_CONFIG`; see [execution backend configuration and safe switching](docs/execution.md). An available worker can start any other available worker, subject to the configured `KAENO_WORK_MAX_DEPTH` and concurrent-work limit. WORK freezes the agent settings when the root work is admitted; later file changes affect only newly admitted work after restart.

Agent frontmatter `name` and `description` are required. Optional fields include `model`, `skills`, and `tools`. The Markdown body is the system prompt. A worker uses its profile model, or the explicit owner `defaultModel` / `KAENO_DEFAULT_MODEL`; it does not inherit Kaeno's model. Omitted tools inherit host-approved defaults. `tools: []` means no tools. Omitted skills means no source-assigned skills. Unknown metadata is inert. A `source:*` skill selector expands deterministically and saves concrete skill snapshots.

A skill has `name` and `description` frontmatter, an optional supported `disable-model-invocation` flag, a Markdown instruction body, and optional relative assets. Skills provide knowledge only; they do not grant tools or credentials. Skill discovery and reading use each conversation's saved bindings, not a live global catalog. `list_skills` excludes skills marked `disable-model-invocation`; explicitly requesting an assigned skill with `read_skill` remains supported. Binary assets are retained and returned as base64. Scripts and asset bytes are not implicitly mounted or executed in the sandbox. When an explicit tool list omits `read_skill`, visible assigned skill instructions are rendered inline instead of granting a hidden tool.

The CLI's HTTP adapter listens on `PORT` (default `8080`). It supports thread listing, replies, stop and reset. This adapter does not implement transport authentication: run it on a trusted network or behind authenticated ingress. Setting a token environment variable alone does not secure the listener. Disconnecting a client does not cancel an admitted turn.

## Model credentials

Provider API keys come from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`). An OpenAI subscription login is stored in a writable host-only file, `KAENO_AUTH_FILE` (default `~/.kaeno/auth.json`), created with `npm run auth -- login openai [--output <file>]`. Kaeno refreshes and rotates those tokens in place, so the file must stay writable and persistent.

To provision a login from a read-only source such as a Kubernetes Secret, set `KAENO_AUTH_SEED_FILE` to that file. At startup Kaeno imports it into `KAENO_AUTH_FILE` once per distinct seed: an unchanged seed is ignored so refreshed tokens survive restarts, and a changed seed (a new login) replaces the live credentials. After the first refresh the seed's own tokens are spent, so it only helps on a fresh `KAENO_AUTH_FILE`. A configured seed that is missing or invalid fails startup.

## Owner memory

Kaeno keeps a durable memory of its owner, shared by every thread and kept across `reset`. **Preferences** (how you want things done) are always in its prompt in full. **Memories** (facts) appear there by title only, and Kaeno reads the ones it needs with `memory_read`. Only your own messages can change memory: work reports are untrusted and cannot. Workers never see memory; Kaeno puts the facts a task needs into its brief. Browse and edit it with `GET /v1/memory`, `GET`/`PUT`/`DELETE /v1/memory/:id`. See [personal continuity](docs/continuity.md) for the design and the proposed persistent workspace.

## Embed and extend

The embedding entry point is `openKaeno` in `src/core/application/index.ts`. Callers supply resolved native assistant settings and explicitly install pi-durable extensions. WORK takes `work.agents`: plain agent profiles (`id`, `description`, resolved `setup`). `openKaeno` checks every agent against the approved worker tools and installed binding owners and throws on a misfit, so an agent that cannot run fails startup instead of being listed as unavailable. `loadEnvironment` in `src/host/composition/index.ts` resolves the same configured sources for local, Docker, and Kubernetes hosts; source acquisition and catalogs do not enter durable core.

Agent-facing extensions expose tools and skills through an [extension contribution boundary](docs/extensions.md), backed by a small native runtime projection. The application installs extensions and separately sets availability and defaults; exact profile lists override defaults. Private binding production and skill snapshots are handled by composition, not extension-specific host wiring.

Native extensions are trusted process code, fixed before the harness opens. There is no hot loader or plugin marketplace. Agent/skill Markdown is data, not executable extension code. An agent may author a patch or a future native extension, but adopting that code into the running process remains an owner-controlled release decision.

## Private repository work

The optional [GitHub App extension](docs/github.md) gives all agents installation-wide repository discovery, credential-free sandbox checkout, and draft-PR publishing. Configure `KAENO_GITHUB_CONFIG` with an owner-controlled App/installation file; GitHub tools become defaults for Kaeno and workers, while explicit `tools` lists still override defaults; no GitHub credentials are needed when the extension is disabled. GitHub controls repository access and permissions, with no duplicated per-agent policies. Other platforms can supply independent extensions through the same tool/binding/prompt-section composition.

## Data directory

`KAENO_DATA_DIR` (default `/data`) holds two SQLite files:

- `durable.sqlite`: pi-durable storage only (conversations, tasks, documents). Its history is append-only.
- `kaeno.sqlite`: Kaeno's own state, such as owner memory, where deleting really deletes.

Back up both together.

## Durability and scope

Definitions used by admitted work are frozen. On restart, missing saved native definitions, incompatible work plans, or a changed execution environment identity fail closed rather than silently changing running work. Finish or cancel work with its original backend before switching. Older unfinished work without an environment identity must be drained with the previous release before upgrading. Take a consistent SQLite backup before opening a changed release; opening the harness writes recovery reconciliation state. External side effects are not transactional with SQLite and may be uncertain after a crash.

This cut intentionally does not migrate the prior WORK/Telegram database or legacy JSON configuration. Define/select a catalog agent in `KAENO_CONFIG`; do not rely on `.kaeno/AGENT.md` as an assistant override. Use a fresh database for this release unless the previous workload has been deliberately drained/migrated and backed up.

See the [core entry point](src/core/application/index.ts), [WORK implementation](src/core/work/work.ts) and [extension composition tests](test/integration/extensions.test.ts).

```sh
npm run verify
```

### WORK browser tools

The official Playwright MCP integration exposes browser tools directly to worker models,
with one isolated stdio session inside each WORK sandbox. Browser tools are included in WORK
defaults; explicit agent tool lists remain authoritative, and host execution is forbidden.
No browser proxy service or opt-in environment variable is required. See
[browser MCP prerequisites and lifecycle](docs/browser-mcp.md) for the existing WORK network
boundary, its limitations, and sandboxed Chromium runtime requirements. No deployment security
settings are relaxed automatically.

## Flat agent records and rollout

Agent sources contain immediate `agents/<name>.md` records, not
`agents/<name>/AGENT.md` packages. The filename stem must exactly match the parsed
frontmatter `name`; IDs stay `<source>:<name>`. Keep README material outside the
agent root. Legacy packages are diagnosed but never loaded. Skills keep their
existing `SKILL.md` directory-package discovery and assets.

For agent repositories, omitted `path` defaults to `agents`; an explicit path
(including `""` for the repository root) is the exact, nonrecursive root. Local
agent directories are already exact roots. Injected agent sources now return
`AgentDocument` records (`manifestPath`, `manifest`, `source`) from `snapshot()`.
New agent origins use the actual file path and SHA-256 of exact file bytes; old
saved origins remain valid audit records with their original directory/tree-hash
meaning. Saved WORK definitions, children and skill bytes are not re-resolved.

This is the strict-reader implementation of [PR36](https://github.com/mjrmyr/kaeno/pull/36).
Roll out only as a coordinated release:

1. Build a compatible runtime and validate Myriad's flattened agent commit.
2. Before either incompatible `main` change can reach a live consumer, verify and
   gate the actual deployment state. Homelab currently follows Myriad `main` in
   both lists; do not rely on its README's suspension claim as a verified gate.
3. In a separately authorized Homelab change, pin **both** `agentRepositories`
   and `skillRepositories` to that same flattened Myriad commit, together with the
   compatible real image digest in both host and sandbox image settings.
4. Refresh successfully before using offline mode. Legacy completed cache loads
   require refresh under the new flat discovery policy; old immutable trees and
   completed records are retained, never silently reinterpreted or purged.
5. Verify selected IDs, concrete skills, file origins, offline reload and saved
   WORK recovery before deployment. Rollback restores the old runtime **and**
   old Myriad pin/config together; no database migration is required.

These changes do not merge, deploy or alter Homelab pins. CI image-build checks
are not a production rollout.

## Owner-configured MCP tools

Set `KAENO_MCP_CONFIG` to an owner-controlled config; Kaeno discovers the allowlisted
tools at startup. [Setup, security boundaries and phase-1 limitations](docs/mcp.md)
cover host Streamable HTTP tools (`none`/header-file authentication) and code-declared WORK MCP
servers that run inside each sandbox, like Browser. OAuth is not implemented. GitHub credentials
and publishing remain native.
