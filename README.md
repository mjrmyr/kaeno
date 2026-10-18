# Kaeno

Kaeno is a small, self-hosted durable conversation and work host. Threads, turns, activity reports, cancellation fences and WORK orchestration use one pi-durable runtime. Agent and skill definitions are optional Markdown-based extensions; the durable core does not parse their files or own their catalogs.

The CLI composes the built-in file environment:

- Kaeno's own assistant: `~/.kaeno/AGENT.md`, overridden by `.kaeno/AGENT.md` in the directory Kaeno starts from.
- Kaeno-only skills: `~/.kaeno/skills/<directory>/SKILL.md` and `.kaeno/skills/<directory>/SKILL.md`.
- Worker agents: `~/.agents/agents/<directory>/AGENT.md` and `.agents/agents/<directory>/AGENT.md`.
- Skills assignable to workers: `~/.agents/skills/<directory>/SKILL.md` and `.agents/skills/<directory>/SKILL.md`.

The startup directory is captured once. User-wide and project definitions have distinct source IDs: `global:` for `~/.agents` and `local:` for the startup directory's `.agents` (`kaeno-global:` and `kaeno-local:` for dedicated `.kaeno` skills). Bare skill names work when unique; same-named entries require a qualified ID. The application configuration under `.kaeno` is separate from the reusable agent/skill catalogs under `.agents`. Kaeno automatically uses its dedicated `.kaeno/skills` entries when its `skills` field is omitted; an explicit list, including `[]`, overrides that default. Workers only receive the skills their definitions select.

By default, Kaeno and every spawned worker have `list_skills` and `read_skill`, even with no assigned skills. They discover assigned skill IDs and descriptions with `list_skills`, then load relevant instructions with `read_skill`. An empty list means none are available for automatic use.

## Run

Node.js 24 or newer:

```sh
npm ci
mkdir -p ~/.kaeno
cat > ~/.kaeno/AGENT.md <<'MD'
---
name: kaeno
description: My personal assistant.
model: openrouter/openai/gpt-6.1-sol
---
You are my helpful assistant. Be clear, warm and concise.
MD
export OPENROUTER_API_KEY=...
export KAENO_DB="$PWD/kaeno.sqlite"
npm start
```

Kaeno has WORK orchestration tools by default, independently of its assigned skills or configured workers. With no workers configured, it can explain why it cannot delegate and still manage existing work. Explicit `tools` lists remain authoritative.

To give Kaeno an agent it can delegate to, install a worker definition. For example:

```sh
mkdir -p ~/.agents/agents/coder
cat > ~/.agents/agents/coder/AGENT.md <<'MD'
---
name: coder
description: Implement and verify code changes.
model: openrouter/openai/gpt-6.1-sol
---
Use the available tools to make the requested change, run relevant checks and report evidence.
MD
```

The CLI provisions Docker only when worker agents are discovered. An available worker can start any other available worker, subject to the configured `KAENO_WORK_MAX_DEPTH` and concurrent-work limit. WORK freezes the participant settings when the root work is admitted; later file changes affect only newly admitted work after restart.

Agent frontmatter `name` and `description` are required. Optional fields include `model`, `skills`, and `tools`. The Markdown body is the system prompt. An omitted worker model inherits Kaeno's model (or the explicit `KAENO_DEFAULT_MODEL` fallback); if there is no default, the agent remains discoverable but cannot be started. Omitted tools inherit the host's approved defaults. `tools: []` means no tools. Omitted skills means none. Unknown metadata is inert.

A skill has `name` and `description` frontmatter, an optional supported `disable-model-invocation` flag, a Markdown instruction body, and optional relative assets. Skills provide knowledge only; they do not grant tools or credentials. Skill discovery and reading use each conversation's saved bindings, not a live global catalog. `list_skills` excludes skills marked `disable-model-invocation`; explicitly requesting an assigned skill with `read_skill` remains supported. Binary assets are retained and returned as base64. Scripts and asset bytes are not implicitly mounted or executed in the sandbox. When an explicit tool list omits `read_skill`, visible assigned skill instructions are rendered inline instead of granting a hidden tool.

The CLI's HTTP adapter listens on `PORT` (default `8080`). It supports thread listing, replies, stop and reset. This adapter does not implement transport authentication: run it on a trusted network or behind authenticated ingress. Setting a token environment variable alone does not secure the listener. Disconnecting a client does not cancel an admitted turn.

## Embed and extend

The embedding entry point is `openKaeno` in `src/application/index.ts`. Callers supply resolved native assistant settings and explicitly install pi-durable extensions. WORK participants and their execution environment are separate injected interfaces; either can be replaced without adding agent or skill parsing to core. `loadFileEnvironment` is the CLI's optional file-backed composition, not a required part of `openKaeno`.

Native extensions are trusted process code, fixed before the harness opens. There is no hot loader or plugin marketplace. Agent/skill Markdown is data, not executable extension code. An agent may author a patch or a future native extension, but adopting that code into the running process remains an owner-controlled release decision.

## Private repository work

The optional [GitHub App extension](docs/github.md) gives all agents installation-wide repository discovery, credential-free sandbox checkout, and draft-PR publishing. Configure `KAENO_GITHUB_CONFIG` with an owner-controlled App/installation file; GitHub tools become defaults for Kaeno and workers, while explicit `tools` lists still override defaults; no GitHub credentials are needed when the extension is disabled. GitHub controls repository access and permissions, with no duplicated per-agent policies. Other platforms can supply independent extensions through the same tool/binding/prompt-section composition.

## Durability and scope

Definitions used by admitted work are frozen. On restart, missing saved native definitions or incompatible work plans fail closed rather than silently binding a new tool surface. Take a consistent SQLite backup before opening a changed release; opening the harness writes recovery reconciliation state. External side effects are not transactional with SQLite and may be uncertain after a crash.

This cut intentionally does not migrate the prior WORK/Telegram database or JSON configuration. Move the assistant to `.kaeno/AGENT.md` or `~/.kaeno/AGENT.md`, workers to per-directory `AGENT.md` files, and skills to per-directory `SKILL.md` files. The old `KAENO_CONFIG` and `KAENO_WORK_CONFIG` JSON paths are no longer read. Use a fresh database for this release unless the previous workload has been deliberately drained/migrated and backed up.

See the [core entry point](src/application/index.ts), [WORK implementation](src/work/work.ts) and [extension composition tests](test/integration/extensions.test.ts).

```sh
npm run verify
```
