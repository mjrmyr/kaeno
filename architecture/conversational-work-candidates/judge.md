Understood—design review only. I’ll compare lifecycle and delivery guarantees, recommend a base, and flag unresolved product decisions.

## Scores

Scores assess the **written designs**, not verified implementations.

| Criterion | A: direct worker jobs | B: WORK conversation |
|---|---:|---:|
| Ownership, replay, cleanup | 2/5 | 3/5 |
| Multi-step isolation and context coherence | 2/5 | 5/5 |
| Routing, acknowledgement, reset, cancellation | 2/5 | 3/5 |
| Interface depth, one source of truth, minimal surface | 3/5 | 4/5 |
| Installed SDK, channels, quota feasibility | 2/5 | 3/5 |

## Strongest base: **B**

B better matches substantial, multi-step background work. The WORK conversation owns planning, blocking delegation, joins, review, and follow-on actions without using the frontdesk’s evolving conversation as an implicit workflow engine. Its extra conversation is justified isolation—not inherently another hand-maintained lifecycle.

A is attractive for independent, single-stage fanout. However, its later root turns must reconstruct continuation state while unrelated requests change context. Making that reliable would require explicit workflow state, weakening its simplicity argument. Its deterministic task-ID construction is also incompatible with the installed SDK.

B is a **design base, not implementation-ready**: identity allocation, acknowledgement failures, cancellation completion, and ingress adaptation remain underspecified.

## Concrete grafts and required corrections

1. **Make replay identity real.**  
   In `src/work.ts`, persist an invocation-to-Work-task mapping and a Work-to-Report-task mapping transactionally. `Tx.createTask` allocates numeric IDs; neither candidate may invent deterministic task constructors. Stable `requestId` deduplicates submissions, not task creation. Application ticket IDs may reference those persisted mappings.

2. **Keep native ownership, but distinguish abort from completed cancellation.**  
   Work and Report must be conversation-owned background tasks; WORK and delegate descendants remain foreground beneath Work. `Harness.abortTask` marking a task does **not** prove pod cleanup finished. A targeted cancellation must await an explicit cleanup barrier before reporting “cancelled”; reservations remain held until confirmed pod removal. Also suppress pending reports when cancelling. Keep legacy delegate definitions registered before resume and preserve their existing annotation/cleanup behavior.

3. **Graft A’s bounded admission and refresh specificity.**  
   Use one sandbox admission authority in `src/agents.ts`, with durable reservations, bounded waiting, and simple durable retry—not a second jobs-status database. Four workers is the unchanged CPU/memory ceiling, potentially fewer with other consumers. Distinguish transient quota exhaustion from permanent forbidden/configuration errors. In `src/threads.ts`, exclude recognized background work boundaries from refresh gating while still checking foreground run, inbox, and Turns.

4. **Strengthen B’s acknowledgement barrier.**  
   Release after the channel’s defined successful acknowledgement delivery and checkpoint—not merely any terminal Turn. Define retry, failure, cancellation, and missing-route outcomes. Telegram retains accepted duplicate-after-crash behavior. API requests currently bypass Turn, so both designs need an explicit acknowledgement/origin adapter; `afterTurn` is not universally available.

5. **Make reset and provenance application contracts.**  
   `/new` currently retains the conversation ID: persist and atomically advance an epoch before reset/cancellation can race with reporting. Check it at reporting admission and delivery transitions; do not promise atomicity with an external Telegram send. Native `SubmissionDraft` has no `source`; `LiveDoc.run.inputs` contains submission IDs. Use an application-owned validated envelope and origin mapping, plus enforced authorization—not text claiming “system-generated” authority.

6. **Define B’s steering/finalization cutoff.**  
   Awaiting the initial WORK submission is insufficient if steering submissions are accepted concurrently. Accepted steering must either participate before finalization or be explicitly rejected. Freeze the authorized catalogue and permitted context; never include main secrets/cache/SQLite in worker access. Preserve assigned-only skills and separate root/worker settings.

For an MVP, graft A’s honest pi status/reconnect behavior and consider omitting steering. Automatic later pi replies require a verified durable feed and extension lifecycle integration, not merely longer server submission logic.

## Product choices still needed

- Does `/stop` stop foreground activity only, or all work? Do not inherit either candidate’s preference silently.
- Does `/new` cancel, detach, or retain retrievable old work?
- One final report versus partial updates; behavior after acknowledgement failure.
- Whether completions wait quietly behind busy chat, and how cancellations/failures are presented.
- Steering scope, queue bounds, retention, and disconnected retrieval guarantees.
- Preserve existing provider/model preferences; do not silently introduce timed-out `xhigh` defaults. Any necessary selection must use supported settings, such as Sonnet 5.5 high or GPT 6.1 Sol high.
