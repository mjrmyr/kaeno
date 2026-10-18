# Architecture

Kaeno is a small durable host built on pi-durable. The core mechanisms are the application host, threads, turns, WORK and the optional HTTP adapter. Agent and skill catalogs and execution environments are composed around those mechanisms; their file formats and implementations are not core dependencies.

## Primitives and ownership

- **pi-durable:** native harness, registry, conversation setup, tool execution, documents, tasks, transactions, scheduling and environment interface.
- **Threads:** maps external thread keys to durable conversations and uses the host-supplied resolved setup for new or idle conversations.
- **Turns:** idempotent user-turn admission, provenance, result turns, stop/reset fences, reply cursors and delivery claims.
- **WORK:** durable task orchestration, parent/child messages, frozen participant plan, request idempotency, nesting/concurrency limits and recovery.
- **Conversation setup:** resolved model, instructions, exact tool selection and versioned extension-owned bindings. Core validates tool/extension owners, stores bindings atomically with setup, and does not interpret binding payloads.
- **Participants:** a consumer-owned in-memory catalog/plan interface. The core cares about participant IDs, descriptions, resolved native setups and the closed root plan, not Markdown or other source formats.
- **Work environment:** a separate consumer-owned provider for idempotent resource ensure/release/reconciliation and the pi-durable execution environment.
- **Agent definition module:** optional Markdown parser/resolver for `agent.md`; no durable definitions and no environment dependency.
- **Skill module:** optional Markdown skill source, binding adapter, assigned-only `read_skill` tool and prompt section.
- **Directory source:** optional filesystem discovery utility shared by agents and skills. Other external-source adapters can satisfy the same source interface.

Standalone `openKaeno` needs only storage, models and a resolved assistant setup. It starts no Docker worker environment and offers no WORK tools unless a WORK participant source is explicitly supplied.

## File composition

The CLI captures its startup cwd and composes these sources:

| Purpose           | Home environment                  | Application context (captured cwd)   |
| ----------------- | --------------------------------- | ------------------------------------ |
| Kaeno assistant   | `~/.kaeno/agent.md`               | `.kaeno/agent.md` (takes precedence) |
| Kaeno-only skills | `~/.kaeno/skills/<dir>/SKILL.md`  | `.kaeno/skills/<dir>/SKILL.md`       |
| Worker agents     | `~/.agents/agents/<dir>/agent.md` | `.agents/agents/<dir>/agent.md`      |
| Worker skills     | `~/.agents/skills/<dir>/SKILL.md` | `.agents/skills/<dir>/SKILL.md`      |

Home and local source aliases are distinct. Same names coexist and need qualified IDs; no catalog is silently overridden. No parent-directory or home scan is implicit beyond these declared roots.

An agent's required frontmatter is `name` and `description`. Optional `model`, `skills`, and `tools` resolve against environment defaults. The Markdown body is the system prompt. Omitted tools inherit an approved default list; `tools: []` is empty. Unknown keys are retained inertly. An agent with no effective model remains discoverable but cannot be activated.

Skills use required `name`/`description` frontmatter, a Markdown instruction body and package-relative files. They teach; they do not authorize. The skill extension reads only skills bound to that conversation. Current bindings preserve text documents in the durable conversation state. Tool selection is separate and explicit.

## Admission and recovery flow

1. Sources are read at startup. Each extension parses its own manifests. Catalogs are immutable for the process lifetime.
2. The application installs fixed native definitions and supplies `ConversationSetup` for CHAT.
3. On a new root WORK request, core prepares a plan in memory from the participant source, outside a durable transaction.
4. The admission transaction rechecks the idempotency key and origin fence, counts host-wide active WORK, checks depth, then persists the durable task and its full reachable plan.
5. Every child resolves only from the parent tree's saved plan. Every participant may delegate to everyone; max depth bounds the tree.
6. A consumer-owned environment is ensured outside the transaction, then the participant conversation is configured from saved native settings.
7. On restart, native task/tool/extension recovery compatibility and saved conversation bindings are checked while scheduling is paused. WORK plans are revalidated against the installed and approved worker surface. Removing a selected tool causes startup failure; no plan is silently filtered or refreshed.
8. Only after preflight does Kaeno refresh eligible idle threads, reconcile optional resources, start extension services and resume scheduling.

Definitions are restart-to-reload for new root requests; they never alter already admitted work. A source outage prevents new activation from that source but does not implicitly substitute another source's same-named definition. Native definitions have to remain installed for saved work that uses them.

## Extension and authority boundary

Kaeno uses pi-durable's native extension format. All native definitions are installed before `Harness.open` and remain fixed until restart. Agent/skill Markdown configures data and conversation settings; it never imports code into the process or defines new native registrations.

The composition supplies one worker-approved tool surface. A participant can select only installed tools on that surface, and each conversation receives exactly its explicit tool selection. Core protocol tools such as `start_work` and `message_parent` are not silently injected when omitted. A selected tool or binding owner selects the native extension that implements it, but installation alone does not offer its tools.

CHAT tool policy wraps selected native tools; every tool is mutating unless explicitly classified read-only. Result turns are read-only. Mutating tools still recheck trusted origin/fences in the transaction admitting their effect. A skill, prompt or tool-name selection is not a credential or authorization grant.

Extensions are trusted process code. Kaeno is not a sandbox for malicious native plugins. The Docker work environment isolates writable workspaces but currently permits network egress; it must not receive host API keys or Github tokens. A passing test suite does not prove process isolation or prevent source exfiltration.

## Encapsulated dependency direction

`src/work/` imports resolved conversation settings and consumer-owned participant/environment ports, but no `src/agents`, `src/skills`, Docker, or definition-source implementation. Agents and skills can be absent or replaced. `src/main.ts` and `src/composition/` are the explicit composition boundary. Feature imports cross only public `index.ts` files, and construction belongs at the application boundary; `scripts/check-architecture.ts` enforces these constraints.

The agents extension owns frontmatter/default resolution. The skills extension owns SKILL parsing, binding format and `read_skill`. The content representation is stored under an owner/version envelope so core can persist/fence it without becoming an agent or skill catalog. These envelopes are ordinary JSON conversation data, not extension installation or authority.

## Deliberate migration

This release removes the previous JSON agent/work config paths, the template/blueprint type in WORK, the hardcoded agent factory and the GitHub-only skill repository loader. `KAENO_CONFIG` and `KAENO_WORK_CONFIG` are rejected with a migration message. This does not silently migrate old work databases or widen their authority. Drain/cancel old work or provide a tested native migration; back up SQLite before opening an incompatible release.
