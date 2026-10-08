## Scores

Design grades, not runtime verification.

| Rubric criterion, 0–5 | A | B |
|---|---:|---:|
| Actual Durable APIs, ownership and replay | 3 | 3 |
| Small interface, concentrated ownership, red flags | 4 | 3 |
| Contact availability and completion semantics | 4 | 4 |
| Configuration, restart and cancellation | 4 | 3 |
| Minimal implementation path and concrete test plan | 4 | 4 |
| **Total /25** | **19** | **17** |

## Recommendation: base A

Use **`/tmp/arena-kaeno-native/candidate-a/design.md`**, with repairs below. Its bounded-job contract concentrates creation, execution, result preservation and reporting behind one owner, with fewer invariants a partial-context agent could bypass.

This is **not an intrinsic preference for job-scoped agents**. B’s persistent conversations provide meaningful continuity, and its completing/terminal anchor pattern is valid Durable usage. B loses primarily on its insufficiently concrete cross-ownership cancellation protocol and manually maintained reservation index.

## Required repairs and distinctions

1. **Fix A’s quota rule before implementation.** Its statement that “completing/terminal tasks do not consume worker slots” is wrong for `completing`: Durable explicitly holds that state while ordinary owned work remains live. Likewise, a result card alone cannot prove capacity is free. Count undecided nonterminal jobs **including completing jobs**; drain the child before recording the normal slot-releasing result/report checkpoint. Timeout and fault paths must retain capacity while work drains.

2. **B’s lease check does not close its cancellation race.** `Turn` does not own the specialist conversation. A check followed by `conversation.abort()` can become stale; conversely, a Turn can submit after the conversation was aborted but before its owning Job is abort-marked. Keep the lease pinned throughout cancellation, signal/join the Turn before final child cleanup, and prevent release/new admission while cleanup remains outstanding. Reconcile faulted jobs’ reservations too—not merely missing result cards.

3. **Complete result/notice reconciliation.** Both correctly retain application results in conversation-scoped documents, surviving task-document retirement. Preserve an existing result during cancellation. For A, terminal Job + existing card + pending notice needs repair too: recover the stable report submission if admitted, otherwise mark the notice deferred. Do not leave “pending” forever after reporter-phase faults. Same-ID submission replay does **not** revive a withdrawn report.

4. **Make transaction ordering explicit.** Under `src/session/transaction.ts`, table reads—including `tx.task`, `tx.entry`, scans and `submissionByRequest`—must precede the first table write. Document acquisition/mutation is different and remains permitted. A acknowledges this during admission; enforce it in every completion/reconciliation transaction. Creation and the later built-in tool-result commit remain separate.

5. **Make startup and callback fencing structural.** Persist the contact’s effective snapshot as well as workers’: neither sketch supplies its concrete stored schema. Validate pinned code, settings, environment/resources and stored selections before **any** submit/wait/resume; `root(options)` does not update an existing root. Keep callbacks observational, with incarnation/closed guards after awaits. Native watch `stop()` does not join an already-running callback. Cancellation return must acknowledge a request, not claim all work stopped.

## Two grafts from B

- **Client request-ID/content conflict rejection:** persist a same-store admission intent/digest before native submission; identical retries use the same native ID. Keep this policy behind `send()`.
- **Notice disposition projection:** distinguish admission, queued/settled and unanswered/withdrawn status by reading the saved native submission. Retain A’s single attempt; do **not** graft sibling reporters or manual retries yet.

## Red-flag screen

- **Shallow/pass-through wrappers:** neither public facade inherently fails; preserve its policy/adaptation responsibilities.
- **Information leakage:** both public sketches avoid framework/wire types; keep IDs opaque and validated.
- **Temporal decomposition:** durable checkpoint phases are legitimate, not public load/validate/save stages.
- **Split ownership:** startup, cancellation and reconciliation must call the same job-policy owner—not independently mutate its documents.
- **Duplicate paths:** retain one delegation path and one report-admission implementation.
- **Importable internals:** currently promises only. Enforce package exports and import-boundary checks.
- **Hand-synced lists:** derive schemas, allowed names and installations from one verified capability catalog. B’s active-ID set additionally needs explicit fault-path repair.

Both honestly exclude nonexistent shipped `grep`/`find`/`ls`. The resulting MVP is useful for **supplied paths**, not repository discovery. Generate specialist descriptions from the directory for contact selection; add a real environment-backed search capability only if discovery is required.

**Verification gate:** add candidate-specific completing/draining quota, cancellation-race, transaction-ordering, notice-reconciliation, startup-drift and stale-callback tests. I checked Durable implementation sources and the probe script; no candidate-runtime results were inspected or tests run. The supplied primitive-probe results do not establish either candidate runtime. No files edited.
