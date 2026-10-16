# Reasoning plans (issue #14)

This is a bounded policy supervisor on the existing pi-durable harness, not a
second task engine. It launches ordinary native `kaeno.work` v2 tasks with an
attenuated profile. Existing coding WORK, tool admission and old checkpoints
retain their behavior.

## HTTP contract

All endpoints require the existing bearer token. Plan admission is **only** an
explicit structured HTTP request; there is no plan tool and no inferred user
permission from model text, reports or tool calls.

```http
POST /v1/threads/example/plans
Authorization: Bearer …
Content-Type: application/json

{
  "requestId": "analysis-0001",
  "scope": "reasoning",
  "phases": [
    {"agent": "worker", "title": "Compare", "brief": "Compare the two supplied arguments: …"},
    {"agent": "worker", "title": "Check", "brief": "Independently check this supplied conclusion: …"}
  ],
  "limits": {
    "deadlineMs": 600000,
    "maxRequests": 4,
    "maxPhases": 4,
    "maxDepth": 1,
    "fanout": 1
  }
}
```

Returns 202 and a plan view. Repeat the same request ID and normalized content to
retrieve the existing admission, even after cancellation, completion or reopen.
A changed payload with the same ID is rejected. No key eviction/resurrection:
128 lifetime admissions per thread, then a new thread is required. At most one
plan that is running or cleaning up is admitted per thread. Terminal status is
published atomically with native supervisor settlement only after all children
are joined. `completing`, `pausing`, and `cancelling` expose persisted cleanup in
progress and block replacement admission, including after a restart.

- `GET /v1/threads/example/plans`: frozen request, origin epoch, absolute deadline,
  status/reason (including cleanup-in-progress states), cursor (completed phase count), consumed request admissions,
  launch keys/WORK IDs, completed reports as data.
- `POST /v1/threads/example/plans/analysis-0001/cancel`: durably fences further
  launches, aborts the native supervisor and joins its child cleanup.
- Existing stop/reset cancel plans. Reset still preserves **ordinary** coding WORK.

Unknown fields are errors, including `maxTokens`, `maxCost`, actions, commands
and mutable scopes. Only configured templates eligible for root WORK are admitted.
Request IDs: 8–128 characters; agent names ≤128; titles 1–160 trimmed characters;
briefs 1–8,000 trimmed characters; 1–4 phases; deadline 1–600,000 ms; total native
request admissions 1–4. The other limits must match the constants above.

## Safety and persistence

The native `kaeno.plan` v1 task input freezes ordered phases, complete existing
WORK blueprints (including template/model/instructions), scope, limits, origin
and absolute deadline at admission. Its conversation-scoped ledger holds only
progress/status and a copy for inspection. Policy reads precede task-table
writes. `${planId}:${cursor}` and the native WORK child are persisted in one
transaction. No subsequent template lookup influences replay or later phases.

Each phase is depth one, has **zero tools**, only the WORK policy extension,
no skill section/read_skill, no sandbox record and no execution environment.
This is permission attenuation in AgentFactory, not prompt-only enforcement.
An attempted tool call pauses the plan before native tool dispatch. `message_work`
cannot alter a plan phase, even from an admitted user turn. Cancel and admit a
new plan to change scope. Plan phases are inspected through `/plans`; they do not
pollute the existing tool-call-keyed WORK visibility index or reserve sandbox slots.

Only a trusted native WORK terminal receipt with both outer outcome `completed`
and inner result status `completed` advances the cursor. Empty reports, faulted/
aborted work, provider errors, truncated answers, unsupported actions, deadline
or request exhaustion pause/cancel with a reason. Natural-language report content
is never interpreted for policy. Reports are not forwarded to CHAT or subsequent
phases. This slice therefore supports independent predeclared reasoning phases,
not model-driven chaining of outputs into new instructions.

The supervisor checks the origin epoch and deadline in the launch transaction.
Stop/reset fences are committed before cleanup; explicit cancel marks the ledger
before abort. Pauses and completion also persist their cleanup state before
joining; hooks reject all non-running states. No successor can launch after that linearization point. Cleanup
joins child aborts. Deadline cancellation is cooperative on the running host;
offline time still counts and expired plans cannot start new requests on reopen.

## Exact budget limitations / deferred work

`maxRequests` counts **native generation request-hook admissions** durably before
they run, including interrupted/replayed attempts. A crash after charging but
before sending conservatively consumes a slot. Compaction is declined for plan
phases; error/tool/truncated responses pause rather than request another turn.
A provider's internal transport retries/polling are not separate native request
admissions. This is **not** an aggregate billed-token, output-token, provider-call
or monetary cap. SDK 1.1.0 does not expose per-conversation `maxTokens` through
`configure`/`beforeRequest`; such promises are explicitly rejected. Stronger
provider-aware budgets remain deferred.

Mutating plans (coding, filesystem, shell, network and orchestration), phase
output chaining, resume/edit APIs and report-driven decisions are intentionally
unsupported. No shell action-capability enforcement currently exists, so none
is claimed. General WORK remains the existing separately authorized capability.

Design alternatives: advancing directly in `WORK.report` was smaller but could
not independently fence/clean up a hung or faulted generation. The chosen native
supervisor owns only finite policy/progress; WORK still owns all agent lifecycle.
