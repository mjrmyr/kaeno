Read both candidates completely and checked installed Pi 1.1.0 `sdk.md`, session documentation, examples, and tool declarations. Scores assess **design quality, not executable proof**.

| Rubric criterion | A | B |
|---|---:|---:|
| Responsive contact | 4 | 4 |
| Durability | 3 | 4 |
| Pi grounding | 5 | 5 |
| Config and isolation | 4 | 4 |
| Minimality and verification | 4 | 4 |
| **Total /25** | **20** | **21** |

### Recommendation

Use **`/tmp/arena-kaeno/candidate-b/design.md`** as the base, narrowly. Its session-binding-before-prompt rule, retained attempt history, conservative `outcome_unknown` recovery, and explicit changed-tool-call-ID ambiguity make reconciliation clearer.

**Blocker:** neither establishes a Pi Durable integration. Both correctly acknowledge this; grounding scores reward that honesty. Obtain the real checkpoint, replay, cancellation, side-effect, and ownership contracts before claiming durable autonomous execution. Do not invent an adapter API or commit to a competing scheduler prematurely.

### Useful grafts from A

From `/tmp/arena-kaeno/candidate-a/design.md`, retain:

- **“At-least-once attempted notification”** rather than B’s stronger delivery claim.
- Explicit incomplete-contact-tool-turn recovery, without fabricated tool results.
- Worker deliverable validation: `agent_settled` does not establish task success.
- JSON-only directory format, atomic catalog reload, and broader crash/isolation tests.

### Remaining problems

- **Delivery and intake:** B’s “deliver at least once” lacks a defined durable acknowledgment and eventual-dispatch assumptions. Client-card deduplication does not deduplicate contact narration. Its durable input queue also needs recovery rules for database acceptance versus Pi persistence.
- **Tool identity:** the SDK verifies `execute(toolCallId, …)` and persisted IDs—not session-wide uniqueness or stable identity across regenerated calls. Both uniqueness keys remain conditional; B correctly acknowledges changed-ID duplicates.
- **Snapshots:** optional model selections, tool names, and resource references/hashes do not freeze effective execution. Pin resolved provider/model, thinking/settings, resource contents, and relevant runtime/tool versions—or block detected drift.
- **Unsafe retry and ownership:** a state-directory lock prevents another supervisor, not lingering external requests or child processes. Specify attempt generations, guarded terminal transitions, cancel/result races, and reconciliation before redispatch. Supervisor retry limits must also account for SDK retries.
- **Responsiveness:** prompt enqueueing and one contact writer are sound, but input acknowledgment is not timely conversation. Define fairness, bounded queues, and stuck-turn handling; user-first scheduling can starve completion narration, and cooperative abort is not a hard deadline.
- **Minimality:** SQLite plus separate Pi transcripts is justified. Durable input processing and a future execution adapter add unresolved surface; keep only explicitly required contracts.

The SDK supports the cited prompting, steering/follow-up, session reopening, abort, and settling semantics. It does **not** supply the cross-store delivery, stable replay identity, or crash-fencing guarantees still needed here.
