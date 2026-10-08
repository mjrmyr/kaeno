# Arena synthesis: minimal Kaeno

## Outcome

Two independent candidates challenged the initial design. Both rejected session-led orchestration and independently converged on a task-led supervisor with a single-writer contact actor. Base: **candidate B**, revised by hand into `../minimal-kaeno.md`.

## Runners and isolation

Candidates A and B: separate concurrent `pi --print` processes using `openai-codex/gpt-6-sol`, xhigh, readonly tools, no session persistence or discovered extensions/skills. Each received the same prompt and grounding and wrote its final response to a separate temporary output path; archived here afterward.

Cross-judge: a separate readonly `openai-codex/gpt-6.1-sol` process, xhigh, launched after candidates finished. The preferred Claude family was not available in the installed Pi model listing. No exposed subagent/background tool was available, so independent CLI processes provided fan-out. Judge shares the available OpenAI family; do not imply cross-family agreement. No dropouts.

## Rubric and pick

Scores are design judgments, not test results. Parent read both artifacts end-to-end. Cross-judge and parent agree on the narrow B lead:

| Criterion (0–5) | A | B |
| --- | ---: | ---: |
| Responsive contact | 4 | 4 |
| Durability/reconciliation | 3 | 4 |
| Verified Pi grounding | 5 | 5 |
| Config/isolation | 4 | 4 |
| Minimality/verifiability | 4 | 4 |
| Total | 20 | 21 |

B makes binding-before-execution, conservative unknown outcomes, and changed-tool-ID ambiguity clearer. Both have a cleaner boundary than the original: contact decides what work to launch; supervisor owns mechanics. See `judge.md` for the independent verdict.

## Grafts and corrections

From A:

- Explicit intake versus answer contract and incomplete contact-turn repair without fabricated Pi tool results.
- Validate final deliverables; `agent_settled` is not proof of success.
- JSON directory to avoid parser dependencies.
- At-least-once *attempted* notification language and broader crash/isolation scenarios.

From B:

- Separate durable input and completion inboxes, transactional admission/outcome updates.
- Session binding before execution, immutable task definitions, explicit uncertain outcome recovery.

From judge/parent verification:

- Bounded fairness between user input and completions, not indefinite user-first starvation.
- Limits include SDK retries; cooperative abort is not a hard deadline or effect rollback.
- Guard terminal transitions by attempt; do not claim a supervisor lock fences external effects.
- Resolve defaults and pin runtime/tool execution identity; resource path hashes alone are not reproducible snapshots.
- Pi Durable integration gate comes first. Required logical ownership does not prescribe duplicating its task store/scheduler.

## Rejections

- Original JSONL task store plus extra event log: creates unowned consistency/replay work. Prefer substrate transactions; SQLite only if required.
- Automatic restart of every running/waiting task: conflates saved history with resumable execution and can repeat effects.
- Session-led task reconstruction: transcript branching/compaction and incomplete-call recovery make it unsuitable without stronger substrate contracts.
- Remote workers/DAGs/nested delegation/hot reload: unnecessary for this first scope.
- Prompts as tool security, bash-enabled “read-only” researchers, concurrent writers in one workspace: unsafe claims, not minimal implementations.
- Unverified Pi Durable adapter methods: no source contract available; no fictional API was introduced.

## Verification

Design-level trace completed for: nonblocking admission, single contact writer, duplicate origin conflict, result-plus-inbox transaction, task/session crash gaps, notification redelivery, config drift, cancellation/result races, capacity/fairness, workspace isolation, and shutdown/second ownership.

Grounding checked against installed SDK docs and tool examples/declarations: prompt completion semantics, streaming steer/follow-up rules, `agent_settled`, persistent session ownership, explicit tool selection and custom tool-call ID. Replay stability and cross-store transactions are not verified Pi guarantees.

**No runtime implementation or crash tests were executed.** The acceptance suite is specified in the synthesized design; it is not marked passed. Pi Durable source/version and recovery contract remain a blocking discovery item before implementation can claim durable autonomous execution.
