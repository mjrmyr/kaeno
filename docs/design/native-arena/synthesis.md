# Native Kaeno arena synthesis

> **Historical design evidence.** The one-Harness, fresh task-owned child design is now implemented in `src/jobs.ts` and [documented here](../minimal-kaeno.md). The sketch and verification claims below describe the *pre-implementation* arena, not current release testing. The stock-Pi-frontend/k3s arena is withdrawn.

## Pick

**Base A: job-scoped conversations.** Two structurally distinct artifacts were required and produced: A creates one private child per job; B reuses named conversations under anchors/leases. This is not two wordings of the same design. Both received the same grounding, architect runner prompt and product contract, plus their explicit lifetime hypothesis.

Source grounding: Durable commit `6fb2e7815167e6b19006fc526d1a5d0f5f998787`. Runners: concurrent readonly `openai-codex/gpt-6-sol:xhigh` CLI sessions; judge: readonly `gpt-6.1-sol:xhigh`, launched after both completed. Claude was unavailable in the local catalog; no exposed subagent tool. Same available model family is a limitation, not cross-family confirmation. No dropouts. Archived artifacts: `candidate-a.md`, `candidate-b.md`, `judge.md`.

## Scoring and comparison

| Criterion (0–5) | Parent A | Parent B | Judge A | Judge B |
| --- | ---: | ---: | ---: | ---: |
| Native Durable correctness | 3 | 3 | 3 | 3 |
| Interface/ownership/red flags | 4 | 2 | 4 | 3 |
| Contact availability/reporting | 4 | 4 | 4 | 4 |
| Configuration/recovery/cancel | 4 | 3 | 4 | 3 |
| Minimal implementation/tests | 4 | 3 | 4 | 4 |
| Total | 19 | 15 | 19 | 17 |

Parent read both candidates completely. Agreement on A confirms the base; the parent penalizes B's extra input/lease/reporting state more heavily. Both rationales recognize persistent memory as a real product capability, but it is not required for this minimal contact-plus-directory contract. Independent worker context is a simpler default that a partial-context contributor can extend safely.

## Grafts

From B: **notice disposition projection** from the saved native submission, instead of treating admission as narration. Keep A's one report phase and single automatic attempt; do not import B's anchor, Turn or sibling reporter hierarchy.

From judge and verification:

- Count **all nonterminal jobs**, not only undecided jobs or phases presumed not to have active children. Include `completing`, abort-marked tasks and reporter phase until native terminal receipt. The completing/draining primitive probe confirms the risk.
- Add persisted effective contact identity alongside canonical job profiles in native task input; validate both before auto-scheduling calls.
- Reconcile terminal/pending notices as well as terminal/missing results.
- Make native table reads-before-writes a transaction invariant; primitive probe confirms rejection and rollback.
- Add incarnation/close fencing and adapter-owned callback draining to observation lifecycle.
- Collapse A's `native.ts` forwarding setup into the facade's lifetime owner. Three modules, not four.
- Keep canonical effective profile in native task input rather than another mutable application-document copy.

## Rejections

- B's persistent specialist lease and Turn cancellation protocol: a job does not own its borrowed conversation, so check-then-abort can become stale and a turn can submit after cancellation starts. Repair would add protocol state that fresh job-owned children do not need.
- B's manually maintained active-ID set: native records are already the authority, and fault/abort paths would need extra synchronized release logic.
- Candidate B's `null!` document seed and A's `Promise<unknown>` private bootstrap: escape hatches removed from the scaffold, not copied as implementation guidance.
- Judge-suggested stronger client input digest/admission journal: native semantics are adequate when a client uses one request ID per intended input. A second input-intent protocol is unnecessary for this scope; the public contract explicitly does not promise changed-content rejection. Strict delegation origin conflict rejection remains.
- Public manual `reportAgain` and independent reporter retries: user can ask about a stored job through normal input. No second reporting/delegation path.
- Claims of realtime prioritization, hard deadlines, safe arbitrary effects, sandboxing by cwd or exactly-once narration: removed rather than patched with more wrappers.

## Red-flag screen

- **Shallow module/pass-through:** removed native execution adapter; facade hides lifecycle/projection policy, jobs module hides coupled transaction/ownership logic.
- **Information leakage:** public declaration emission was checked for framework types and contains none. Production export boundaries still need wiring when implementation starts.
- **Temporal decomposition:** work/report are durable private checkpoints, not public lifecycle stages callers coordinate.
- **Split ownership:** jobs module owns creation, decisions, notices and reconciliation. Native records own execution. No synchronized app execution-status fields or quota counters.
- **Two ways:** one creation-only delegation tool; one automatic report implementation; manual discussion uses ordinary contact input.
- **Importable internals:** sketch definitions are unexported. Production package should expose only the facade; enforced import/export tests remain required.
- **Hand-synced lists:** generate validation/selection from one approved capability map; no configurable arbitrary extension registry in the first version.

## Verification and deliverables

Synthesized artifact: `../minimal-kaeno.md` and `../kaeno.sketch.ts`; rationale: `../kaeno-rationale.md`. Five native primitive probes passed; strict scaffold typecheck and public-declaration leakage check passed. Details and reproduction: `verification.md`.

**At the time of this arena: design/signature scaffold only.** Runtime was implemented later in `src/jobs.ts`. No human checkpoint was requested. No scrap was required after incorporating quota/transaction corrections; if implementation produces repeated ownership/scheduler workarounds, return to Ground/Sketch rather than add layers.
