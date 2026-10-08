# Grounding: native Kaeno

## Overview

The repository has design documents only. The real integration is `@earendil-works/pi-durable`, not the coding-agent SDK. Source checkout: `/tmp/kaeno-pi-source`, commit `6fb2e7815167e6b19006fc526d1a5d0f5f998787`, package 1.1.0. `pi-durable`, `pi-ai`, and `chord` 1.1.0 are published. Full prior traced findings live in `../durable-evaluation/{tasks,contact,config}.md`, with synthesis in `../pi-durable-evaluation.md`.

## Traced paths

1. Input: `Conversation.submit` -> `Submissions.submit` -> Session commit -> `admitSubmission` -> existing per-conversation request lookup OR `pi.inbox`/user entry + generation creation. Receipt is returned before answer. `Submission.wait` separately observes settlement. Same request ID ignores changed same-type content.
2. Delegation: `pi.generation` commits assistant tool calls + `pi.tool` tasks -> ToolTask records intent -> custom execute `api.commit` creates app task/conversation/doc metadata -> built-in tool settlement commits tool result later. Native `api.taskId` is stable identity; provider tool-call IDs are not globally unique. Do not claim those two commits are one transaction.
3. Background: background task owned by root conversation -> task-owned child conversation. Parent normal abort/idle traversal skips this boundary. Work owned directly by the delegate tool would instead keep contact busy. Example 23 uses anchor and reporter tasks for persistent specialists.
4. Worker result: own checkpointed task submits child input with task-derived request ID -> waits -> validates answer -> commit outcome/application result. Reporter submit to root with stable report ID is a later admission. Parent abort may withdraw that report; retrying its old ID finds an aborted record, not a fresh notice.
5. Restart: open recovers running tasks as pending at saved checkpoint; `inspect` does not execute them; `resume`/submit/wait enables scheduling. Unsafe tool effects return interrupted; safe reruns require both persisted and current safe declarations. Definitions/settings/env resolve against current installed code, so registry names alone are not snapshots.
6. Observation: view/watch/events are committed state snapshots/deltas; slow clients receive replacement snapshots. Live events are not delivery receipts. Application docs require their own observation if not mounted in conversation view.

## Ownership and motivation

Durable's Session is already the serialized, transactional authority for entries/tasks/docs/submissions. Its scheduler owns execution/reservation/recovery. Kaeno should own only delegation semantics, profile validation, limits, result/notice UX, and transport. A duplicate ledger/actor does not close cross-store gaps; using one native substrate removes those gaps without erasing between-commit or external-effect uncertainty.

This is greenfield application integration, not a change to an existing implementation. No `why` skill is available in the provided skill set or local skill directory. Existing design motivation is captured in the arena synthesis and Durable evaluation; no undocumented rationale is assumed.

## Constraints that survive evaluation

- Explicit selected extensions/tools; unknown selected names must be rejected by Kaeno because Durable may skip them.
- Shipped tools: read/write/edit/bash only. Use read-only MVP or explicitly implement additional search tools; no pretend grep/find/ls.
- Persistent task results must survive task-document retirement: retain outcome or conversation/session-scoped metadata.
- One process owns storage; host must prevent two live owners before opening. Node SQLite NORMAL promises process-crash recovery, not newest-commit survival after power loss.
- Per-agent/global caps, timeout/queue/fairness are app policy. Prefer capacity rejection for the first version over creating another scheduler.
- Snapshot effective instructions/model/settings/tool/runtime identity. Do not silently reinterpret unfinished tasks on directory edits/restart.
- No exactly-once remote effect or model narration; no sandbox merely from cwd/tools. Keep effectful/writable workers out of the first version.

## Evidence and verification scope

Prior evaluation inspected implementation/spec/tests but did not run them. This pass will independently compare two ownership sketches, screen red flags, typecheck the chosen signature scaffold, and probe real Durable primitives using a faux model in an isolated temporary verification environment. Neither successful primitive probes nor a typecheck will be presented as implementation of Kaeno or exhaustive crash coverage.
