# WORK module boundaries

WORK remains one durable task supervising one conversation, with parent/child communication and a plan frozen at root admission. This decomposition changes code placement, not its protocol or state machine.

## Where changes belong

| Module                  | Owns                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/work/work.ts` | Stable `Work` façade, feature composition, CHAT delegation guidance                                                                     |
| `model.ts`              | Durable document definitions, stored input/checkpoint/result shapes and codecs, consumer-owned runtime/turn/settings contracts          |
| `task.ts`               | All task phases and abort, conversation setup, supervision, final-answer/error interpretation, parent delivery, ordered subtree cleanup |
| `commands.ts`           | Six tool registrations, caller authority, replay-safe admission, steering intents, tool and public cancellation                         |
| `directory.ts`          | Task scans, status/text projections, list/inspect, descendant authorization and direct-child eligibility                                |
| `recovery.ts`           | Saved-plan fit, saved-binding validation, environment reconciliation                                                                    |
| `plan.ts`               | Agent resolution, frozen plans, their storage codec and environment contract (unchanged)                                                |
| `tools.ts`              | Protocol names and ordered tool groups (unchanged)                                                                                      |
| `turns.ts`              | Adapter to generic turn coordination; does not own its ledger                                                                           |
| `index.ts`              | Explicit public feature API (same exports as before)                                                                                    |

The façade creates the task, then passes that task definition to command construction. Task execution never calls commands. Commands and task may use directory queries; directory cannot mutate lifecycle state. Recovery depends only on shared contracts and plan/durable APIs. No internal module imports the façade or the local barrel. Other features still use only the public index.

Text projection in directory is not a completion decision: inspection can show older useful text, whereas supervision must consider the newest assistant response, including errors. Completion interpretation stays beside supervision in task.

## State and ordering

- **Task checkpoints:** written by task only; no parallel in-memory state machine.
- **WorkIndex:** commands writes launch IDs and steering intents; directory reads them.
- **WorkScope tree metadata:** initialized by task from the frozen plan.
- **WorkScope.message:** intentional producer/consumer mailbox. `message_parent` (`kind: "question"`, the default) in commands writes it; supervision atomically clears it while recording the message checkpoint. It is not a correlated question/reply ledger.
- **WorkScope.question / progress:** read-side records, not lifecycle state. A question keeps its text after supervision consumes the mailbox, and `message_work` marks it answered once per steering invocation, so inspection shows it only while it is pending. `kind: "progress"` records the latest note and notifies the parent without a checkpoint change: a CHAT parent gets a read-only activity result keyed by the tool invocation, a WORK parent a follow-up submission with a stable request ID. Listing reports a waiting WORK as `running` while its conversation has a live run, and as `resuming` once its question is answered.
- **Turn ledger:** still owned by turns, reached through the consumer-owned WorkTurns adapter.
- **Environment resources:** owned by the injected environment implementation, not a new WORK resource registry.

Keep lifecycle effects adjacent. Final/abort cleanup stops children, waits for their terminal receipts and aborts the conversation. Final report delivery and terminal outcome (or the aborted outcome) are committed next; only then is the environment released, best-effort, with failures sent to `onReport` and left to reconciliation. Supervision races the conversation watch against the optional `environment.check` health monitor. Cancellation suppresses reports before requesting aborts.

CHAT report admission and the next checkpoint share one transaction. A WORK-parent report is submitted first with its stable request ID, then the checkpoint commits. Replaying that sequence relies on submission deduplication. Briefs, steering and nudges likewise retain their original request IDs. Capacity and origin-fence decisions remain inside admission transactions; environment capacity lookup remains outside them as before.

Application composition still runs saved compatibility checks before environment reconciliation and runtime resume, and owns periodic reconciliation scheduling. Core does not load agent definitions or import concrete environment providers.

## Migration and scope

No database migration or caller migration is needed: task `kaeno.work` stays v3; `kaeno.work-index` and `kaeno.work-node` stay v1; checkpoint fields, document options, tool order/replay contracts, and stored `plan.participants` are unchanged. `message_parent` gained an optional `kind`, and `kaeno.work-node` gained additive `question`/`progress` fields that scopes stored earlier lack and readers treat as absent. The extraction is mechanical; existing code now resides behind the same public Work methods and tool registrations.

Progress does not change question/reply semantics: a question still ends the turn and waits in the same checkpoint, and an omitted `kind` keeps that behavior for existing calls. A committed steering intent is not a promise of reply consumption if completion races it, and the single-snapshot child stopping behavior is unchanged. Changes to those guarantees require separate lifecycle work and tests.

Avoid per-phase modules, a generic effect interpreter, and a shared all-capabilities WorkContext: they scatter the ordering and authority decisions this split is meant to make easier to inspect.
