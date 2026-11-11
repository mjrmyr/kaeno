# WORK module boundaries

WORK is one durable task supervising one conversation, with parent/child communication and a plan frozen at root admission. A root WORK is one **Assignment** of a router ticket ([routing](routing.md)): it runs on the ticket's own conversation, which outlives it, and reports to the router's Engine. Child WORK owns a conversation of its own and reports to its parent.

## Where changes belong

| Module                  | Owns                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/work/work.ts` | Stable `Work` façade, feature composition, Assignment launches for the Engine                                                           |
| `model.ts`              | Durable document definitions, stored input/checkpoint/result shapes and codecs, consumer-owned runtime/turn/settings contracts          |
| `task.ts`               | All task phases and abort, conversation setup, supervision, final-answer/error interpretation, parent delivery, ordered subtree cleanup |
| `commands.ts`           | Seven tool registrations (`report` for ticket roots), caller authority, replay-safe admission and slots, steering intents               |
| `directory.ts`          | Task scans, status/text projections, list/inspect, descendant authorization and direct-child eligibility                                |
| `recovery.ts`           | Saved-plan fit, saved-binding validation, environment reconciliation                                                                    |
| `plan.ts`               | Agent resolution, frozen plans, their storage codec and environment contract (unchanged)                                                |
| `tools.ts`              | Protocol names and ordered tool groups (unchanged)                                                                                      |
| `index.ts`              | Explicit public feature API (same exports as before)                                                                                    |

The façade creates the task, then passes that task definition to command construction. Task execution never calls commands. Commands and task may use directory queries; directory cannot mutate lifecycle state. Recovery depends only on shared contracts and plan/durable APIs. No internal module imports the façade or the local barrel. Other features still use only the public index.

Text projection in directory is not a completion decision: inspection can show older useful text, whereas supervision must consider the newest assistant response, including errors. Completion interpretation stays beside supervision in task.

## State and ordering

- **Task checkpoints:** written by task only; no parallel in-memory state machine.
- **WorkIndex:** commands writes launch IDs and steering intents; directory reads them.
- **WorkScope tree metadata:** initialized by task from the frozen plan.
- **WorkScope.message:** intentional producer/consumer mailbox. `message_parent` (`kind: "question"`, the default) in commands writes it; supervision atomically clears it while recording the message checkpoint. It is not a correlated question/reply ledger.
- **WorkScope.question / progress:** read-side records, not lifecycle state. A question keeps its text after supervision consumes the mailbox, and `message_work` marks it answered once per steering invocation, so inspection shows it only while it is pending. `kind: "progress"` records the latest note and notifies the parent without a checkpoint change: a ticket root's progress goes to the Engine as a `progress` report (a passive note for the router), a child's to its parent WORK as a follow-up submission with a stable request ID. A ticket root's `report` with `state=waiting|blocked` uses the same mailbox as a question; `state=dropped` marks the run so its final answer ends the ticket. Listing reports a waiting WORK as `running` while its conversation has a live run, and as `resuming` once its question is answered.
- **Tickets:** owned by the router's Engine, reached through the consumer-owned `WorkReports` contract (`report`, `ended`, `retainedConversations`).
- **Environment resources:** owned by the injected environment implementation, not a new WORK resource registry.

Keep lifecycle effects adjacent. Final/abort cleanup stops children, waits for their terminal receipts and aborts the conversation, except after a ticket root's successful final answer: the ticket's conversation keeps an owner message that arrived meanwhile for the next Assignment. Final report delivery and terminal outcome (or the aborted outcome) are committed next; only then is the environment released, best-effort, with failures sent to `onReport` and left to reconciliation. A ticket root on an environment with `suspend` retains its workspace while stopping execution (Kubernetes deletes only the pod), and hands off the same way when it asks a question with no live children: the report and terminal outcome commit together with `handedOff`, the Engine ends the Assignment, and the answer starts the next one. A failed stop leaves the sandbox running until the ticket's next Assignment or end. Supervision races the conversation watch against the optional `environment.check` health monitor. An aborted Assignment tells the Engine, which records a failed run unless the ticket was stopped.

A ticket report and the next checkpoint share one transaction. A WORK-parent report is submitted first with its stable request ID, then the checkpoint commits. Replaying that sequence relies on submission deduplication. Briefs, steering and nudges likewise retain their original request IDs. Capacity decisions remain inside admission transactions (`NoWorkSlot` tells the Engine to keep a ticket queued; a wake may use one reserved slot); environment capacity lookup remains outside them.

Application composition still runs saved compatibility checks before environment reconciliation and runtime resume, and owns periodic reconciliation scheduling. Core does not load agent definitions or import concrete environment providers.

## Migration and scope

Task `kaeno.work` is v4: its input names a `ticket` parent, its `conversation` (`owned` by the WORK, or the `ticket`'s that every Assignment continues), and a brief that may hold image blocks. There is no migration from v3 (CHAT parents); recovery fails closed on older unfinished work. `kaeno.work-node` holds an unsent message to the parent as `mailbox` (its text and report state) and records `outcome`.

Progress does not change question/reply semantics: a question still ends the turn and waits in the same checkpoint, and an omitted `kind` keeps that behavior for existing calls. A committed steering intent is not a promise of reply consumption if completion races it, and the single-snapshot child stopping behavior is unchanged. Changes to those guarantees require separate lifecycle work and tests.

Avoid per-phase modules, a generic effect interpreter, and a shared all-capabilities WorkContext: they scatter the ordering and authority decisions this split is meant to make easier to inspect.
