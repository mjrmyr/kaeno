# Durable WORK

WORK is the core's durable parent/child work protocol. It owns admission, launch idempotency, the participant plan frozen for a root tree, parent/child messages, reports, origin fences, nesting depth and concurrent-work limits. It does not parse `agent.md`, own skill catalogs, construct Docker, or decide how a host discovers participants.

An application can omit WORK entirely, inject an in-memory `Participants` source, or use the optional file composition. `start_work` is offered only if explicitly present in the CHAT assistant's `tools`. Agent discovery does not grant tool access.

## File-backed composition

The CLI discovers each agent under one of these roots:

```text
~/.agents/agents/<directory>/agent.md
<startup-directory>/.agents/agents/<directory>/agent.md
```

Each file has YAML frontmatter with required `name` and `description`; `model`, `skills` and `tools` are optional. The markdown body is the worker system prompt. Agent IDs are source-qualified, for example `home:coder` and `local:coder`. Use the qualified ID with `start_work` when names collide. Every available agent is a root choice, and every available worker may start any available agent. There is no `delegates` field in this initial shape. Core `maxDepth` still bounds nesting.

`KAENO_WORK_MAX_DEPTH` (default 2) and `KAENO_WORK_MAX_CONCURRENT` (default 4) configure core policy. The concurrent count is enforced within the same transaction that admits work. The environment provider may still be unavailable; in that case WORK reports an environment failure rather than interpreting provider capacity as policy.

For example:

```md
---
name: coder
description: Implements and verifies code changes.
model: openrouter/openai/gpt-6.1-sol
skills:
  - local:kaeno-architecture
tools:
  - read
  - bash
  - edit
  - write
  - read_skill
  - start_work
  - message_parent
  - list_work
  - inspect_work
  - message_work
  - cancel_work
---

Work carefully in your isolated environment. Verify changes and report evidence.
```

An omitted `tools` field inherits the host's explicit worker defaults. An explicit empty list grants no tools. WORK does not inject coding or messaging tools behind the file's back. Skill instructions fall back to inline guidance if the selected tool list does not include the lazy `read_skill` reader. If a worker lacks `start_work`, it cannot delegate. The available participant list in the system prompt contains qualified IDs and descriptions.

## Freezing and restart

Before root admission, the participant source produces an in-memory plan from its startup snapshot. No file, network or environment operation occurs inside the admission transaction. The transaction rechecks the request idempotency key, origin fence, depth and global capacity, then stores the root plan with the durable task. The plan contains resolved model, prompt, tool names and extension-owned binding data for every available participant. Children use this saved plan; they do not re-read `~/.agents` or the project directory.

Definitions reload on process restart for **new** root work. Existing saved work must still match installed tool and extension definitions. Removing a tool selected by saved work fails paused-startup preflight; Kaeno does not silently filter the saved plan. Restore the required definition or drain/cancel the old work deliberately.

## Environment

`WorkEnvironment` is separate from `Participants`. The CLI supplies the Docker implementation when agents are configured. Custom hosts may supply an in-memory environment, another provider, or no environment at all. Environment provisioning/reconciliation is idempotent and runs outside admission transactions. Depth and concurrent-work admission remain core policy.

The HTTP API and Pi extension use the same durable work tasks; see `src/work/work.ts` and `src/application/kaeno.ts`.
