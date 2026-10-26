# Standing responsibilities and autonomous follow-through

**Status: implementation proposal; no runtime behavior changes in this PR.**

## Problem

Kaeno can continue delegated WORK without an open client, but it cannot start work
from time or external events. Its CHAT assistant cannot start, steer or cancel
WORK while processing an activity result. This is deliberate authority discipline,
not a missing timer: external text and worker output must not become user authority.

Add owner-authorized **standing responsibilities**. A responsibility describes a
fixed objective, permitted activation sources, selected agents/tools and bounded
execution. An activation creates a durable **run**. CHAT can advance that run across
worker results until it completes, blocks, is cancelled, expires or exhausts its
limits. Neither an event nor a model can create or broaden that authority.

This proposal covers scheduling, authenticated event admission and result-driven
follow-through. It does not implement general action approvals, personal memory,
persistent workspaces, payment flows, or a new messaging client.

## Usage (caller's view)

Everything in this section is proposed syntax, not supported configuration today.
An owner installs an opt-in responsibilities extension through host composition:

```json
{
  "responsibilities": [
    {
      "id": "ci-watch",
      "thread": "ci-watch",
      "objective": "Investigate failing CI in the configured projects. Prepare findings and proposed fixes. Do not publish changes.",
      "triggers": [
        { "kind": "interval", "everyMs": 900000 },
        { "kind": "event", "source": "ci-events" }
      ],
      "agents": ["myriad:investigator"],
      "workerTools": [
        "read",
        "bash",
        "list_skills",
        "read_skill",
        "message_parent",
        "github_list_repositories",
        "github_checkout",
        "github_get_pull_request",
        "github_list_check_runs"
      ],
      "assistantTools": [
        "list_skills",
        "read_skill",
        "start_work",
        "list_work",
        "inspect_work",
        "message_work",
        "cancel_work",
        "block_run",
        "finish_run"
      ],
      "limits": {
        "maxAssistantTurns": 12,
        "maxWorkStarts": 6,
        "maxRunMs": 1800000,
        "maxPendingEvents": 32
      }
    }
  ]
}
```

The names above are illustrative: startup must resolve real selected tools and
agents. `workerTools` is a ceiling intersected with each agent's exact selected
tools, not a grant of unselected tools. Required protocol tools must remain usable;
a profile incompatible with the ceiling fails configuration instead of silently
losing orchestration. Agents and skills are resolved by existing composition.

**The example is not a repository-scoped security policy.** Native GitHub access
remains installation-wide, and `bash` permits arbitrary code/network access inside
the sandbox. Excluding `github_publish` blocks that native tool, not every possible
external write. Use narrowly permissioned accounts, an appropriate network boundary
and trusted worker profiles. Owner approval of a responsibility authorizes bounded
execution, not a guarantee that its objective is mechanically enforced.

For trusted host integrations, the public domain API is small:

```ts
// Illustrative proposed API; tx/storage types remain private.
await core.responsibilities.activate({
  responsibility: "ci-watch",
  activation: { kind: "manual", requestId: "owner-run-0001" },
});

// Called only after an adapter authenticates and normalizes an event.
await core.responsibilities.publish({
  source: "ci-events",
  eventId: "delivery-1234",
  data: { repository: 123, pullRequest: 47, conclusion: "failure" },
});

await core.responsibilities.pause("ci-watch");
await core.responsibilities.resume("ci-watch");
const runs = await core.responsibilities.list("ci-watch");
```

`publish` cannot choose a thread, agent, prompt, grant or notification destination.
The configured source-to-responsibility binding decides routing. Manual activation
requires an owner-controlled caller; it is not an unauthenticated HTTP operation.

In a user-admitted turn, a proposed `run_responsibility { id }` tool can activate an
already configured responsibility. `resume_responsibility { id }` similarly requires
a user turn, not an activity-result or autonomous turn. These tools cannot create
or edit definitions. An ordinary user-started WORK remains unchanged unless it was
started in a bound responsibility run; there is no implicit grant for old work.

### Example flow

1. The timer observes a due slot, or a verified CI delivery arrives.
2. Admission resolves the configured responsibility, deduplicates the activation,
   snapshots its setup, reserves its run and creates the first CHAT turn atomically.
3. CHAT starts an investigator and answers without waiting.
4. The investigator reports a failure. CHAT may start a second investigation under
   the same run, without a new human message.
5. A worker asks a question. CHAT may answer from the run's context using permitted
   tools. If user judgment is needed, CHAT calls `block_run` with the question.
6. The owner answers through a user turn with `reply_run { runId, text }`. That
   steers the run's pending worker, or wakes its CHAT coordinator, with existing
   authority only. A plain unrelated chat message does not implicitly resume it.
7. CHAT calls `finish_run { outcome, summary }` when the objective is settled. A
   run cannot finish while it has live descendants. Subsequent activations can
   start new runs; completing a run does not delete the responsibility.

The first release uses explicit run controls rather than guessing from prose
whether the objective is complete. Run state and a worker's question state are
separate: `block_run` freezes autonomous continuation but does not abort its workers.
Their reports remain durable and are held until the owner resumes or cancels.

## Grounding: existing flow and constraints

- `src/core/threads/threads.ts` maps a channel/thread key to a durable conversation.
  It refreshes assistant setup only while the conversation is idle.
- `src/core/turns/coordinator.ts` admits user turns and activity results through one
  ledger owner. `Origin` carries conversation, request, epoch and notification route.
- `src/core/turns/turns.ts` deduplicates admissions, serializes submission against
  stop/reset, delivers causal replies and suppresses cancelled activity reports.
  It currently equates every non-user source with an activity result.
- `src/core/authority/index.ts` gates CHAT mutations on a live user-originated turn.
  This wrapper does not wrap delegated WORK tools.
- `src/core/work/commands.ts` separately checks root authority and rechecks the
  epoch/control fence inside mutations. Children currently inherit the frozen
  root plan and communicate on parent–child edges.
- `src/core/work/task.ts` supervises WORK, delivers progress/questions/final reports,
  commits the outcome before cleanup, and releases task-scoped environments.
- `src/core/application/kaeno.ts` checks saved definitions and bindings before resume.
  Native extensions can start listeners after preflight and before harness resume.
- `src/extensions/api/api.ts` currently admits only user text and control requests;
  it has no authentication. Do not expose it publicly as part of this feature.

Preserve these owners, causal delivery, request deduplication, frozen plans,
subtree cancellation and fail-closed recovery. No second conversation engine,
generic workflow DSL or model-driven permissions registry is required.

## Alternatives and synthesis decision

Two structurally different candidates were compared directly. No independent
subagent or judge was available for this design pass.

| Candidate                    | Shape                                                                                                                           | What callers must understand                                                                                                     | Decision                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A: synthetic user turns      | Timers and webhooks submit ordinary user turns; result turns receive a boolean mutation override                                | Every caller must independently get origin, limits, cancellation and payload trust right; a boolean hides no authority lifecycle | Reject: user impersonation and ambient authority; a worker result can become an unbounded loop |
| B: responsibility-owned runs | One domain owner admits activations, stores authority, accounts limits and coordinates cancellation; turns carry run references | Callers configure a responsibility and activate/publish/pause/resume it; enforcement stays behind that interface                 | Select: explicit authority, bounded continuation and one place to reconcile retries            |

Use B as the base. Retain A's reuse of the existing CHAT/WORK pipeline, but not its
user impersonation. Do not build a separate forever-worker supervisor as a third
runtime: it duplicates turn delivery/recovery and would still need an authority
model for the shared CHAT assistant.

The selected interface hides routing, admission, deduplication, snapshots, limits
and lifecycle reconciliation. Its exposed concepts are actual domain decisions:
which responsibility, which activation, and whether the owner wants it paused.

**Principles influencing the shape:** foundational thinking separates definitions,
runs and authority before adding triggers; boundary discipline puts event
verification in adapters and authority decisions in core; idempotent operations
require activation identities and transactional admission rather than best-effort
cron callbacks. These choices preserve the existing guards instead of deleting them.

## Shape: domain types and signatures

These are design sketches, not declarations to copy without their invariants.
Production storage uses existing pi-durable documents/tasks and private codecs.

```ts
type Activation =
  | { kind: "manual"; requestId: string }
  | { kind: "interval"; trigger: string; scheduledAt: number }
  | { kind: "event"; source: string; eventId: string };

interface RunRef {
  id: string;
  revision: string; // immutable definition snapshot identity
  generation: number; // revocation generation, not the chat epoch
}

interface RunLimits {
  maxAssistantTurns: number;
  maxWorkStarts: number; // all root and nested starts, not merely concurrent work
  maxRunMs: number; // deadline enforced even while blocked or idle
  maxPendingEvents: number;
}

interface ResponsibilityRun {
  ref: RunRef;
  responsibility: string;
  causes: readonly [Activation, ...Activation[]];
  conversationId: ConversationId;
  epoch: number;
  deadline: number;
  state: "active" | "blocked" | "completed" | "cancelled" | "exhausted";
  assistantTurns: number;
  workStarts: number;
  // Frozen resolved setups/bindings, grant ceilings, objective and route.
  // Stable accepted request/work IDs for replay-safe accounting.
  // Pending result references, last blocker and terminal summary.
}

// Origin retains all existing fields and adds:
interface OriginRunBinding {
  run?: RunRef;
}

// Source provenance and execution authority are separate concepts.
// An activity result remains an activity result even when bound to a run.
type Source =
  | { kind: "user" }
  | {
      kind: "responsibility";
      run: RunRef;
      causes: readonly [Activation, ...Activation[]];
    }
  | {
      kind: "activity-result";
      activityId: TaskId;
      requestId: string;
      epoch: number;
      label?: string;
    };

interface Responsibilities {
  activate(input: {
    responsibility: string;
    activation: Extract<Activation, { kind: "manual" }>;
  }): Promise<{
    runId: string;
    disposition: "started" | "pending" | "duplicate";
  }>;
  publish(input: {
    source: string;
    eventId: string;
    data: JsonValue;
  }): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  list(id?: string): Promise<readonly RunView[]>;
}
```

`run` is stored in admitted turn receipts/task input and returned by `activeTurn`;
it is never parsed from message text or supplied by an HTTP turn caller. Activity
results inherit it only from the originating work's saved root binding. For nested
WORK, that binding must be propagated explicitly, not recovered from a mutable
"current run" on the thread.

The persisted receipt identity comparison must include the run binding. Reusing
an existing request ID with a different run, revision, generation, activation list
or content is rejected. Do not infer it from the current responsibility definition.

Run records store a nonempty cause list so one activation and a coalesced pending
batch use the same representation. Each individual activation keeps its own
identity; ordered batch identity is derived by the ledger, not supplied by callers.

The existing `ResultSource = Exclude<Source, { kind: "user" }>` must become an
explicit activity-result extraction, and `isResultSource` must test that exact
kind. Audit every non-user predicate in admission, delivery, stale-result handling
and cancellation. A responsibility turn is not an activity result waiting for a
parent reply. Use exhaustive switches so adding provenance cannot silently grant
rights or change causal delivery.

### Ownership and module map

| Location                                    | Proposed responsibility                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/responsibilities/`                | Run/activation records, pure authority decisions, durable limits, lifecycle and public domain API; one owner for this state          |
| `src/core/turns/`                           | Turn provenance, immutable run binding, causal delivery and existing epoch/control fencing                                           |
| `src/core/authority/`                       | One shared CHAT authorization path: user authority or a currently valid run/tool grant                                               |
| `src/core/work/`                            | Propagate run binding; apply worker ceiling; charge all work starts transactionally; keep existing frozen plan and subtree lifecycle |
| `src/extensions/responsibilities/`          | Owner config schema and interval/event adapters; no event parsing or schedule config in durable core                                 |
| `src/host/composition/`                     | Resolve configured profiles, intersect tool ceilings, validate setup/limits and compose the extension                                |
| `src/core/application/kaeno.ts`             | Wire the optional feature, preflight compatibility, expose domain API, then start adapters and resume                                |
| `test/integration/responsibilities.test.ts` | Real durable runtime/SQLite, controlled clock and fake external delivery; no external account required                               |

Use one transaction-aware internal authority port for both CHAT's invocation gate
and WORK's effect-admission checks, rather than independently implementing a new
user-or-run rule in both places. The responsibilities owner checks and updates its
records using the caller's transaction. Turns accepts an application-wired control
participant so pausing responsibilities and installing the existing stop/reset
fence commit atomically; it does not import responsibility storage internals. Run
supervision owns deferred subtree abortion and retryable cleanup after that commit.
A scheduler adapter must not reproduce this transaction choreography.

Avoid separate modules for every lifecycle phase and avoid leaking private
persistent documents to adapters. Core's responsibility API accepts normalized
domain events, not raw HTTP, cron syntax or executable plugin declarations.

## Authority and limits

### Invocation and effect admission

Keep the existing user path. For a non-user CHAT mutation:

1. Resolve the active turn's immutable run binding from its receipt.
2. Require an active, nonexpired run, matching revision/generation and thread epoch.
3. Require the selected CHAT tool to be in that run's assistant ceiling.
4. For start/message/cancel, check ownership: the target must belong to this run.
5. Recheck generation, epoch, state, deadline and relevant counters in the same
   transaction that admits the durable effect. Invocation checks alone are racy.

Unbound activity results stay read-only. A result from another run, a fabricated
run ID in text, stale revision, or cancelled descendant grants no rights. Read
access also obeys the selected run tool surface: it must not expose tools from a
later owner configuration simply because the live assistant profile changed.

The public `run_responsibility`, `resume_responsibility` and `reply_run` controls
are user-only. Run lifecycle tools (`finish_run`, `block_run`) operate only on the
caller's bound run; they cannot activate another responsibility or mint authority.

Workers need their own enforcement because `assistantToolPolicy` is CHAT-only.
At admission, derive and freeze every participant setup from the selected agent
and worker ceiling. Each worker invocation checks its run's revocation/deadline;
all nested starts reserve the same run's work-start budget. Child grants cannot
exceed the root. `list_work`/`inspect_work` results in autonomous turns are filtered
to the bound run; sibling runs and unrelated user work are not steering targets.

A grant is a **tool ceiling**, not a general argument-level or network policy.
Native tool checks still apply. A shell cannot be made read-only through prompt
instructions; this feature makes no such claim and is not a substitute for a
future independent action-approval/network enforcement boundary.

### Accounting and terminal behavior

Reserve one assistant-turn unit per new autonomous or result-driven CHAT
admission, and one work-start unit per new WORK admission, including children.
Replays reuse reservations. Duplicated notifications, progress and final reports
must not create fresh reservations for the same request ID.

Limits bound coordinator turns, total launches and elapsed run time, not exact
tokens, tool calls or money. Deadline/revocation checks apply before invocation and
before core effect admission. A durable deadline task also aborts the run subtree,
so a blocked worker or a quiet tool loop cannot hold it forever. External effects
already in flight may finish; cancellation is not rollback.

On exhaustion/expiry: record the terminal reason, fence new actions, abort and join
run-owned descendants, suppress their autonomous continuations, and deliver one
stable diagnostic without requiring another model call. Preserve existing final
reports for inspection. Completing or blocking cannot replenish counters. Resuming
a blocked run keeps its original counters/deadline. Pausing/revoking cancels the
run; a later resume permits only new activations under a new generation.

Terminalization and accounting are durable transitions, not model conventions.
`finish_run` requires no live WORK; it cannot orphan a subtree. `block_run` records
a blocker and holds subsequent result turns without losing their payloads.

## Scheduling and external events

### Interval adapter

V1 supports fixed UTC instants (`at`) and fixed intervals; no cron parser, local
civil-time scheduling or DST policy. Persist an interval anchor and next slot.
A wakeup is just a hint to inspect durable due state; it is not the source of truth.

Use the scheduled slot as the activation identity. Admission and cursor advancement
commit together. After downtime, coalesce missed interval slots to the latest due
slot, not a burst of historical runs. A duplicate callback or restart cannot admit
that slot twice. Bound each scan and use the durable runtime's clock/sleep support
for repeatable tests rather than a new in-memory scheduler ledger.

### Event adapter

Provide a separately configured, authenticated event listener, not an expansion of
the unauthenticated user-turn endpoint. Each source binds to owner-configured
responsibilities and a host-only token file. Use HTTPS at authenticated ingress
(or loopback transport behind it); compare bearer secrets safely, bound bodies to
64 KiB, validate source/event identity and normalize before calling `publish`.
Return success only after durable acceptance; overload returns a retriable error.
Secrets, arbitrary headers and raw HTTP objects never enter prompts or storage.

This is a generic trusted-producer ingress, not a claim of GitHub webhook
compatibility. A GitHub-specific adapter must verify its provider signature and
translate the payload before publishing. V1 producers supply stable event IDs.
The authentication boundary rejects unknown sources before any activation exists.

Event data is untrusted evidence. Render the configured objective separately from
the bounded event payload. An event cannot change the objective, grant, route or
agent selection. Disabling an adapter does not allow a model to recreate it.

### Overlap and deduplication

Allow at most one nonterminal run per responsibility. While it runs, hold at most
`maxPendingEvents` unique accepted events; reject overflow before acknowledging it.
Coalesce repeated timer ticks separately. When the run terminates, create one next
run with the bounded pending batch and its explicit activation IDs, if still enabled.
Blocking counts as nonterminal: events cannot bypass a human blocker.

Event deduplication uses a separate bounded durable inbox, not the turn ledger's
prunable receipts. Retain accepted IDs for a documented seven-day retry window;
never evict pending IDs, and reject new events if the configured inbox capacity is
full. After the window a producer must not retry the same ID expecting deduplication.
Use a content digest to reject the same source/event ID with different data while
retained. Batch storage retains each activation identity in the run's nonempty
cause list.

## Stop, reset, pause and delivery

- Existing stop/reset first pauses responsibilities bound to the controlled thread,
  bumps their generations, clears pending activations and fences their runs in the
  control-admission transaction; it then performs existing epoch/subtree control.
- An already queued timer or event cannot immediately undo a user's stop. While
  paused, authenticated events receive an explicit inactive response and are not
  accepted as pending work. A resume or owner config enable action is explicit.
- Cancellation of one WORK remains local to that work. Its cancelled result cannot
  authorize a replacement launch. Pausing a responsibility cancels the whole run.
- An individual stop/reset does not globally stop unrelated responsibilities.
- Notifications use the saved route and existing turn ledger. V1 emits summaries,
  blockers and terminal diagnostics; it does not implement attention ranking.
- A stale result follows current stale-report/suppression semantics for display,
  but never starts another autonomous turn or gains fresh epoch authority.
- Generation updates do not retroactively retract an external send already claimed;
  preserve the existing at-least-once delivery contract, not an exactly-once promise.

## Recovery, configuration changes and compatibility

Persist definition revisions, run snapshots, source bindings, counters, inbox IDs,
activation cursors and deadlines. Resolve new owner config before resume. Existing
runs keep their frozen participant setup and objective; they cannot inherit broader
rights from a later config. A changed definition revokes its old generation and
requires terminalization of its old run before any replacement activation.

Missing native definitions/binding owners or incompatible environment identities
still fail preflight before resource reconciliation. An overdue run is fenced and
cancelled before adapters can admit a replacement. Crash recovery adopts an admitted
run and its reservations, never recharges replayed effects or invents new authority.
The run supervisor reconciles orphaned/terminal child records after restart.

The feature is off by default. Existing user turns and unbound WORK retain current
behavior. Do not add a new task/source schema under the old version and assume it
is compatible. The implementation must specify version changes for turn inputs,
receipts and saved WORK origin bindings, and extend native recovery definitions.
Legacy records without a run binding mean **no standing authority**. Document the
supported upgrade path; if native compatibility requires draining unfinished work,
require that explicitly rather than hand-waving an automatic migration. Back up
SQLite before opening the changed release; rollback must account for new records.

## Acceptance tests

The draft is not complete implementation evidence. The implementing PR must prove:

1. A timer starts work without any user turn; duplicate callbacks and SQLite reopen
   preserve one activation, one run and one budget reservation.
2. Downtime coalesces missed slots; controlled-clock expiry stops idle and blocked
   runs; no wall-clock sleeps are needed for schedule tests.
3. Authenticated events start the configured responsibility. Missing/wrong tokens,
   unknown sources, oversized payloads and invalid IDs do not admit anything.
4. Duplicate events are no-ops; changed payload under the same ID is rejected;
   overflow is not acknowledged; accepted IDs survive turn receipt pruning.
5. While a run is active, the top-level CHAT processes a WORK final report and
   starts follow-on WORK without human input, within the same run and budget.
6. Ordinary unbound results remain read-only. A forged run ID, event prompt
   injection or another run's report cannot mint a grant or change routing.
7. Worker tool ceilings hold for roots and nested workers; child starts consume
   the shared launch budget; unavailable required tools fail configuration.
8. CHAT cannot steer/cancel/inspect another run's work. Nonselected read tools
   cannot leak into a resumed run from a newer assistant configuration.
9. Budget exhaustion and deadlines terminate without model cooperation and deliver
   one diagnostic; replayed starts, progress and reports do not charge twice.
10. Stop/reset/pause racing an activation, effect admission or report fences it;
    the next tick/event does not restart work until explicit resume.
11. Blocking holds reports and queued triggers; explicit owner reply resumes the
    same run without refreshing limits. Unrelated user messages do not resume it.
12. Failures at each admission boundary preserve the run, trigger cursor and
    counters atomically; recovery does not duplicate follow-on work or reports.
13. Definition revocation, missing binding owners and backend changes behave as
    specified; incompatible saved work fails before any autonomous action runs.
14. Existing user delegation, cancellation, causal report delivery and Pi polling
    tests remain unchanged and pass.

Run the full `npm run verify` suite. Integration tests must use the real harness
and SQLite for recovery; fake model responses are appropriate for deterministic
authority tests. A mocked scheduler alone is not evidence of durable admission.

## Tradeoffs accepted

- We accept owner-configured responsibilities rather than conversational creation
  in exchange for explicit, reviewable authority before unattended execution.
- We accept fixed-interval scheduling and a generic trusted-producer ingress in
  exchange for shipping one reliable activation path before cron/provider adapters.
- We accept tool-level grants and trusted worker profiles in exchange for a bounded
  first implementation; this is not per-action approval or a sandbox egress policy.
- We accept a dedicated thread per responsibility as the recommended initial setup
  in exchange for simpler context and stop semantics. If multiple responsibilities
  deliberately share a thread, stop/reset pauses all of them.
- We accept bounded deduplication retention and at-least-once external delivery in
  exchange for explicit operational contracts rather than an exactly-once claim.

## Open questions and risks

- Should conversational creation of a responsibility follow later as a structured
  owner approval flow, rather than permitting the model to edit configuration?
- Which first real responsibility and worker tool ceiling should be used to verify
  usefulness without expanding to email, payments or general account access?
- Are twelve CHAT turns, six work starts, thirty minutes and seven-day event-ID
  retention appropriate defaults, or should limits be mandatory owner choices?
- Does the owner want thread stop to pause its standing responsibilities as proposed,
  or a separate clearly visible "stop this run only" control? The default must not
  permit the next timer to silently reverse an explicit stop.

## Next implementation step

Implement the run/activation ledger and authority propagation with the real SQLite
recovery and result-to-follow-on tests before attaching either external adapter.

Suggested implementation slices, each retaining a coherent executable boundary:

1. Domain records, optional run bindings, pure grant decisions and user-only manual
   activation; prove bounded report-driven continuation and unchanged legacy denial.
2. Run controls, deadlines, transactional limits, pause/revoke/stop integration and
   recovery; prove cancellation races before any scheduled activation is enabled.
3. Owner configuration and durable interval adapter with coalescing tests.
4. Authenticated event adapter, bounded inbox and retry-window documentation.
5. End-to-end owner example, operating instructions and deployment verification.

No slice should ship a boolean bypass of `assistantToolPolicy` as an intermediate
"working" state. This PR contains only the proposed contract and rationale.
