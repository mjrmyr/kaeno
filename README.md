# Kaeno

> in one sentence, what is kaeno?
> why did i build kaeno?
> -> should mention dots, grok bot, muse, pi, pi durable (my inspiration for this project)
> how was kaeno build?
> -> should explain the principles, and primitives used
> how to get kaeno up and running?

Kaeno is a small, self-hosted durable conversation and work host. Threads, turns, activity reports, cancellation fences and WORK orchestration use one pi-durable runtime. Agent and skill definitions are optional Markdown-based extensions; the durable core does not parse their files or own their catalogs.

The CLI loads one owner configuration using `KAENO_CONFIG` (default `.kaeno/config.json`). It names public GitHub repositories and explicitly selects Kaeno, its skills, and available workers. Repository fetching and the immutable cache are host-side. Local source definitions use the same catalog and loader; the only deployment difference is the persistent storage directory (ordinary disk locally, PVC on Kubernetes).

By default, Kaeno and every spawned worker have `list_skills` and `read_skill`, even with no assigned skills. They discover assigned skill IDs and descriptions with `list_skills`, then load relevant instructions with `read_skill`. An empty list means none are available for automatic use.

## Run

Node.js 24 or newer:

```sh
npm ci
mkdir -p .kaeno
cp kaeno.config.example.json .kaeno/config.json
export OPENAI_API_KEY=...
export KAENO_DB="$PWD/kaeno.sqlite"
npm start
```

Kaeno has WORK orchestration tools by default, independently of its assigned skills or configured workers. With no workers configured, it can explain why it cannot delegate and still manage existing work. Explicit `tools` lists remain authoritative.

Edit `kaeno.config.example.json` to choose repositories, a Kaeno profile and worker profiles. The example pins a Myriad profile commit; update the pin intentionally when selecting a newer revision. Copy the configuration locally and use a persistent source cache. Private repositories may use the host-only GitHub App reader configured by `KAENO_GITHUB_CONFIG`; public repositories require no App key.

The CLI uses Docker for worker environments by default; the optional [Kubernetes extension](docs/kubernetes.md) selects cluster-backed workers via `KAENO_KUBERNETES_CONFIG`. An available worker can start any other available worker, subject to the configured `KAENO_WORK_MAX_DEPTH` and concurrent-work limit. WORK freezes the agent settings when the root work is admitted; later file changes affect only newly admitted work after restart.

Agent frontmatter `name` and `description` are required. Optional fields include `model`, `skills`, and `tools`. The Markdown body is the system prompt. A worker uses its profile model, or the explicit owner `defaultModel` / `KAENO_DEFAULT_MODEL`; it does not inherit Kaeno's model. Omitted tools inherit host-approved defaults. `tools: []` means no tools. Omitted skills means no source-assigned skills. Unknown metadata is inert. A `source:*` skill selector expands deterministically and saves concrete skill snapshots.

A skill has `name` and `description` frontmatter, an optional supported `disable-model-invocation` flag, a Markdown instruction body, and optional relative assets. Skills provide knowledge only; they do not grant tools or credentials. Skill discovery and reading use each conversation's saved bindings, not a live global catalog. `list_skills` excludes skills marked `disable-model-invocation`; explicitly requesting an assigned skill with `read_skill` remains supported. Binary assets are retained and returned as base64. Scripts and asset bytes are not implicitly mounted or executed in the sandbox. When an explicit tool list omits `read_skill`, visible assigned skill instructions are rendered inline instead of granting a hidden tool.

The CLI's HTTP adapter listens on `PORT` (default `8080`). It supports thread listing, replies, stop and reset. This adapter does not implement transport authentication: run it on a trusted network or behind authenticated ingress. Setting a token environment variable alone does not secure the listener. Disconnecting a client does not cancel an admitted turn.

## Embed and extend

The embedding entry point is `openKaeno` in `src/core/application/index.ts`. Callers supply resolved native assistant settings and explicitly install pi-durable extensions. WORK takes `work.agents`: plain agent profiles (`id`, `description`, resolved `setup`). `openKaeno` checks every agent against the approved worker tools and installed binding owners and throws on a misfit, so an agent that cannot run fails startup instead of being listed as unavailable. `loadEnvironment` in `src/host/composition/index.ts` resolves the same configured sources for local, Docker, and Kubernetes hosts; source acquisition and catalogs do not enter durable core.

Native extensions are trusted process code, fixed before the harness opens. There is no hot loader or plugin marketplace. Agent/skill Markdown is data, not executable extension code. An agent may author a patch or a future native extension, but adopting that code into the running process remains an owner-controlled release decision.

## Private repository work

The optional [GitHub App extension](docs/github.md) gives all agents installation-wide repository discovery, credential-free sandbox checkout, and draft-PR publishing. Configure `KAENO_GITHUB_CONFIG` with an owner-controlled App/installation file; GitHub tools become defaults for Kaeno and workers, while explicit `tools` lists still override defaults; no GitHub credentials are needed when the extension is disabled. GitHub controls repository access and permissions, with no duplicated per-agent policies. Other platforms can supply independent extensions through the same tool/binding/prompt-section composition.

## Durability and scope

Definitions used by admitted work are frozen. On restart, missing saved native definitions or incompatible work plans fail closed rather than silently binding a new tool surface. Take a consistent SQLite backup before opening a changed release; opening the harness writes recovery reconciliation state. External side effects are not transactional with SQLite and may be uncertain after a crash.

This cut intentionally does not migrate the prior WORK/Telegram database or legacy JSON configuration. Define/select a catalog agent in `KAENO_CONFIG`; do not rely on `.kaeno/AGENT.md` as an assistant override. Use a fresh database for this release unless the previous workload has been deliberately drained/migrated and backed up.

See the [core entry point](src/core/application/index.ts), [WORK implementation](src/core/work/work.ts) and [extension composition tests](test/integration/extensions.test.ts).

```sh
npm run verify
```
