# Conversational Kaeno: architecture

Status: architecture approved and runtime implemented locally; not deployed. The original synthesis/sketch below records design rationale, not exact runtime signatures. See **[conversational-work-implementation.md](conversational-work-implementation.md)** for the implemented contract, policies, ownership and verification. Grounding: conversational-work-grounding.md. Exploration: conversational-work-candidates/.

## Problem

A user-facing turn currently owns and waits for disposable delegated workers. Ownership correctly couples cancellation, result collection and cleanup, but it also ties chat availability to execution. Assume conversational availability and concurrent durable work were day-one requirements: separate the lifetime of a chat turn from the lifetime of a request's work, including planning/review/retry—not merely its shell commands. Preserve configured models, provider secrets in kaeno, disposable assigned-only workers, immutable skill/image bindings, SQLite recovery and stable channel routing.

## Usage (caller's view)

User: “Implement X.”
Kaeno: “I’ll inspect the relevant code, implement X, and run the tests. Started work #42.”
User, while42 runs: “Also investigate Y.”
Kaeno admits43 and acknowledges it;42 continues independently.
Later Kaeno reports verified results for42, associated with the original request—not an arbitrary current chat.

Conceptual call sites (application contracts, not existing SDK APIs):

```ts
// Model tool handler in the CHAT role: admission only, not execution.
const ticket = await work.start(turn, { title: "Implement X", brief: "Goal, constraints, relevant context, proposed plan…" });
return `Accepted work #${ticket.id}; ${ticket.state}`;

// Model/status command in the same chat: scope checked, no raw global task access.
const views = await work.list(turn);
const requested = await work.cancel(turn, ticket.id); // requested/cancelling, not premature “cancelled”

// Trusted reporter, not a worker or user-supplied route.
await turns.report(origin, { kind: "work-result", workId, outcome }, `work-report:${workId}`);
```

## Shape

### A front desk and a work conversation per request

CHAT is the conversational Kaeno role: answer, clarify, admit work, inspect/cancel work. WORK is a fresh Kaeno orchestration conversation per request: reason/draft on its own, and optionally invoke foreground delegate tools, join independent workers, critique results, retry/follow on, and produce a verified report. Worker creation is not mandatory. Both use the configured orchestrator model; this is role/context separation, not another mandatory template/provider/model preference. Workers use their configured models and unchanged isolated environments.

```text
user-facing CHAT conversation
  ordinary run → start_work → admission ticket → short final acknowledgement
  background Work task
    owned WORK conversation (same configured orchestrator, scoped toolset)
      foreground delegate task(s)
        owned disposable worker conversation + sandbox
  background result Turn/delivery task
    short CHAT result turn → original destination
```

No mode flag on a universal delegate tool. CHAT has start_work/list_work/cancel_work, not blocking delegate. WORK has foreground delegate, not start_work. Workers retain only their explicitly configured capabilities. Foreground delegation is an internal execution primitive; only one public way starts user work. Installed legacy delegate definitions remain available to drain/replay existing tasks, not a second new chat path.

### Data structures before callbacks

```ts
// Proposed sketch only. Branded native IDs are used in implementation.
type Role = "chat" | "work" | "worker";
type Destination = { kind: "telegram"; chatId: number } | { kind: "thread-feed"; key: string };
type Origin = {
  threadKey: string;
  conversationId: ConversationId;
  epoch: number;
  receiptId: TurnReceiptId;
  destination: Destination;
};
type WorkRequest = { title: string; brief: string };
type WorkInput = { origin: Origin; request: WorkRequest; frozen: FrozenWorkBlueprint };
type WorkOutcome =
  | { kind: "completed"; report: string; answer: EntryId }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled" };
type WorkCheckpoint =
  | { phase: "start" }
  | { phase: "run"; workConversationId: ConversationId }
  | { phase: "report"; outcome: WorkOutcome };
type TurnReceipt = {
  // Identity/source/route captured at admission. Delivery states have failure handling.
  origin: Origin;
  source: { kind: "user" } | { kind: "work-result"; workId: TaskId };
  acknowledgement: { state: "pending" } | { state: "delivered" } | { state: "failed"; reason: string };
};
interface Work {
  start(turn: TurnContext, request: WorkRequest): Promise<WorkTicket>; // not implemented
  list(turn: TurnContext): Promise<WorkView[]>; // not implemented
  cancel(turn: TurnContext, id: TaskId): Promise<CancelReceipt>; // not implemented
}
```

`FrozenWorkBlueprint` captures the orchestrator configuration and reachable authorized delegate templates/bindings plus image/cache locator at admission. Future delegations within this work resolve through that blueprint, not the current global config. No template/status mirror that multiple modules update: task state/checkpoints own execution lifecycle; a minimal index maps launch-call identity to allocated Work TaskId and lists admitted work. Outcome/delivery state are distinct facts, not another copy of execution status. WorkView derives them. Configuration snapshots and explicit messages are immutable across concurrent jobs; they do not reread evolving CHAT history.

### Module ownership

- `src/work.ts` (new): owns work admission, scope, frozen blueprint, Work task, identity index, status/cancellation. One deep public surface hides lifecycle/replay/ownership; task definitions travel with its extension.
- `src/agents.ts`: owns role-derived model/tool configuration, assigned skills, foreground delegation and remote execution. Worker provisioning uses the frozen blueprint. One sandbox admission owner reserves capacity and releases only after confirmed deletion.
- `src/threads.ts`: owns user/result admission, receipt/source/route, epoch, acknowledgement/delivery ordering. API no longer bypasses this owner. A result is a trusted application envelope with untrusted report content, not fabricated user authority.
- Channel adapters: serialize/validate inputs, capture destination and watch/deliver; they do not orchestrate jobs. kaeno.ts registers definitions before resume.

Call chains remain short: channel → turns; chat tool → work; work task → agent execution; result → turns. No generic broker, fleet manager or workflow DSL.

### Load-bearing contracts

1. **Ownership/replay:** Work is a conversation-owned `background:true` task. It owns WORK; foreground descendants remain beneath it. Tool invocation objects are never retained after return. Admission transaction persists launch-call→Work ID; numeric TaskIds are allocated by SDK, NOT deterministic custom IDs. Worker/result submission request IDs are stable and reporter creation deduplicated transactionally. Legacy live tasks keep their existing versions/owners until completion.
2. **Conversation freedom:** CHAT run ends after admission+ack, not readiness/execution/review. Completion review is a short serialized turn; new user messages may queue briefly behind it, never behind worker execution. Frontdesk template refresh excludes background work and still checks actual foreground runs/inbox/delivery turns; WORK blueprint never refreshes mid-job.
3. **Acknowledgement ordering:** jobs may execute immediately, but result delivery cannot overtake the initiating acknowledgement. Gate on its receipt's delivered state, not merely a terminal task. Pending ack is retryable; failed/aborted ack must not strand execution/results forever. Retain the result and apply an explicit fallback (for example a labelled result after ack failure) rather than wait forever. API acknowledgement means server-published reply, not proof that a disconnected human read it. No unbounded circular wait on parent idleness.
4. **Routing/source:** capture origin per admitted request; never use latest chat or mutable last-route. Completion has its own stable ID and readonly source authority. A completion-only turn must not launch unrelated work/cancel other jobs; enforce capability checks at tool boundary, not just a prose warning. Keep frontdesk follow-ups one-at-a-time so source scopes are not accidentally coalesced.
5. **Capacity:** current total quotas permit FOUR workers (main1Gi/1CPU + workers2Gi/2CPU under10Gi/10CPU), although pod count would permit five. Durable reservations use serialized SQLite commits and crash reconciliation, not process-only locks or status copies. Pending delegates allocate no pod. Queue bounded; transient quota exhaustion may wait, RBAC/config failures must fail visibly. Kubernetes is final authority; no assumption that this module owns all namespace consumption. No quota increase in this design.
6. **Cancellation:** cancel validates the job belongs to this origin/thread, marks its Work task and lets ownership cancel descendants. Return cancellation requested until cleanup finishes. Suppress unsent completion reports of cancelled work; free reservation only after pod gone. /stop policy is a product decision, not inferred from background flags. No steering in MVP: accepting it correctly requires a finalization cutoff and knowing whether a coordinator or active worker receives it; cancel/restart is honest.
7. **Reset:** persist a monotonically increasing chat epoch (/new currently reuses conversationId). Stale results never become fresh user inputs after reset. Proposed default: /new resets conversation, NOT silently cancel work; old results remain retrievable and any automatic delivery is explicitly labelled as pre-reset work. A fresh-context report can use the already-verified WORK summary, without waking the reset CHAT with old context. Cancel-all is explicit. This policy needs agreement and testing of reset/send races.
8. **Durability ≠ network exactly-once:** admission, execution, result creation and logical report submission are deduplicated. Telegram send+SQLite commit are not atomic; duplicate messages remain possible on crash. Execution finishing and delivery failing are separate observable outcomes. Client disconnect never cancels work. Lost pod workspace is still not recovered.
9. **Channels:** Telegram can deliver proactive completions. Existing HTTP/pi provider completes one request and stops watching. Add a durable cursor-based thread event feed for later replies; native API can expose/replay it independently of POST. Pi needs verified extension lifecycle/UI subscription—not an invented provider capability or a permanently open chat request. Telegram-first MVP may offer pi status/reconnect retrieval, but must state that automatic pi completion display is not implemented.

## Synthesis decision

Compared direct-worker jobs (Sonnet5.5 high) and per-request WORK conversation (GPT6.1 Sol high). GPT cross-judge scores: direct11/25, WORK18/25. Parent criterion-by-criterion agrees on WORK base: it has much better multi-step context isolation, reuses sound foreground ownership inside a work scope, and does not make unrelated chat turns carry workflow joins/retries.

Grafted from direct: explicit bounded admission, focused refresh-gate change, small status/cancel surface, no MVP steering and honest pi status/reconnect limitations. Corrected BOTH candidates: no invented deterministic TaskId API; provenance/ack ingress also covers API which bypasses Turn today; acknowledgement failure isn't delivery success; cancellation marked isn't cleanup complete; arbitrary Forbidden isn't retryable quota; reset policy is not automatic cancellation. Rejected direct's root-as-continuation-engine and batch bookkeeping, and WORK candidate's blanket /stop and /new cancellation defaults. Keep per-request work, not persistent workers/anchors.

Initial Opus5.5 xhigh and GPT6.1 Sol xhigh runs timed out at360s without artifacts; reran with compact embedded grounding, Sonnet5.5 high and GPT6.1 Sol high, both completed. Sonnet judge could not run due provider credit limit; GPT judge completed. These are architecture review runs, not changes to user's configured models/thinking. All raw candidates are exploratory and contain the corrected red flags; this document is the synthesis.

## Tradeoffs accepted

- Extra orchestration conversation/model work in exchange for coherent planning/review/retries independent of chat history. No extra coordinator pod.
- Short result-summary turn in exchange for natural chat continuity and existing notification path; deep verification already belongs in WORK, not another long CHAT review.
- Frozen authorized blueprint per job in exchange for stable behavior across config/skill refresh; retention and data size need bounded implementation.
- Explicit job cancellation/no MVP steering in exchange for truthful controls during long-running tools.
- Possible duplicate Telegram messages in exchange for actual supported delivery semantics.

## Alternatives considered

- Direct background worker jobs: smaller for one-shot tasks, but CHAT must manage continuation groups and retries amidst unrelated user turns. The apparent simplification exposes workflow state to the caller.
- Detached delegate promise: loses invocation lifetime, ownership and cleanup. Rejected.
- General persistent-agent fleet: adds lifecycle/workspace retention not required here. Rejected.

## Open questions for discussion

1. Does separate per-request WORK Kaeno match desired behavior, including work capable of planning/reviewing multiple workers?
2. Should /stop preserve existing expectation by cancelling this chat's work, with per-job cancel for precision? Or should it stop only the current reply, with explicit /stopall for work? Recommended baseline to discuss: /stop means stop work, not a silent no-op while CHAT idle.
3. Is /new a context reset with work retained and clearly labelled, or a cancel-everything operation? Proposed context-only policy avoids silently losing useful work.
4. Is Telegram-first proactive delivery with honest pi status/reconnect sufficient initially, or must automatic pi notifications ship in the same change?
5. What queue/result-retention bounds fit personal homelab use? Don't choose arbitrary8-job queue without agreement.

## Verification and next step

Grounded in current complete app/channel files, current resource limits and installed SDK declarations/upstream background example; two independent sketches and cross-review. No implementation/prototype runtime verification yet. The contract test matrix is: ack-before-result (including instant jobs and send failures), input B answered while A runs, fanout4+queued, restart at each admission/checkpoint/report stage, no duplicate worker/report creation, targeted cancellation/confirmed cleanup, config refresh while work frozen, reset/result race, malicious worker instructions cannot gain frontdesk capabilities, disconnected API/pi retrieval, legacy foreground replay and Telegram accepted duplication semantics.

After product agreement, first build the replay-safe Work ownership boundary and a short-turn-vs-long-work integration test, then unify channel receipt admission. If integration repeatedly needs foreign tool contexts, duplicated status or route lookups, scrap the boundary and re-ground rather than patching it.
