**Phases:** Ground complete; Sketch below; Agree pending synthesis; Implement excluded; Scrap conditional.

## Usage (caller’s view)

Kaeno acknowledges immediately: “I’ll investigate, make the changes, and report back.” The chat then accepts another request. A separate **WORK conversation** performs orchestration, including synchronous delegation to disposable workers.

```ts
// Frontdesk tool: returns a ticket, not the eventual answer.
const ticket = await work.start(turnContext, {
  goal: "Investigate the failing tests and propose a fix."
});
// Frontdesk produces its short acknowledgement.

// A later user request:
const progress = await work.status(turnContext, ticket.id);
await work.steer(turnContext, ticket.id, "Prioritize the Linux failure.");
// Steering is queued; it does not promise interruption of a running tool.

// User explicitly cancels this work:
await work.cancel(turnContext, ticket.id);
```

Completion eventually becomes a provenance-marked input to the frontdesk. Kaeno writes the natural final reply; delivery uses the originating request’s route, never the latest chat.

## Problem

Existing delegation intentionally keeps its parent busy until disposable workers finish. Preserve that lifecycle **inside a separate conversation**, rather than detaching an invocation-bound tool context. The difficult boundaries are acknowledgement ordering, frozen authorization, cancellation, scarce sandbox capacity, and delivery after the initiating turn has ended.

This candidate preserves existing provider/model choices and disposable workers. It introduces no persistent worker fleet.

## Shape

### Core types and signatures

These are proposed application interfaces, not asserted framework APIs.

```ts
// Public domain API in src/work.ts
type WorkId = Opaque<string, "WorkId">;
type WorkRequest = { goal: string };
type WorkTicket = { id: WorkId };

type WorkView = {
  id: WorkId;
  state: "queued" | "running" | "waiting" |
         "completed" | "failed" | "cancelled";
  summary: string;
};

interface Work {
  start(turn: TurnContext, request: WorkRequest): Promise<WorkTicket>;
  status(turn: TurnContext, id: WorkId): Promise<WorkView>;
  steer(turn: TurnContext, id: WorkId, text: string): Promise<void>;
  cancel(turn: TurnContext, id: WorkId): Promise<void>;
  // Bodies: not implemented.
}

// Private durable input/checkpoints
type WorkInput = {
  origin: DeliveryOrigin;
  epoch: ConversationEpoch;
  acknowledgement: AckId;
  goal: string;
  context: FrozenContext;
  binding: FrozenWorkBinding;
};

type WorkCheckpoint =
  | { phase: "orchestrating"; conversationId: ConversationId }
  | { phase: "result"; result: WorkOutcome };

type Completion = {
  source: "work";
  workId: WorkId;
  epoch: ConversationEpoch;
  outcome: WorkOutcome;
};
```

`FrozenWorkBinding` captures the orchestrator configuration and its entire authorized delegate/skill catalogue at admission. It preserves separate root/worker model settings. Workers still receive only their assigned frozen skills.

### Ownership and data flow

```text
frontdesk conversation
├─ ordinary Turn: acknowledge → deliver → release ack barrier
├─ background Work task
│  └─ WORK conversation
│     └─ foreground delegate tasks
│        └─ disposable worker conversations + pods
└─ background Report task → frontdesk inbox → ordinary Turn delivery
```

1. `start` validates authority and captures permitted context, immutable bindings, origin, epoch, and acknowledgement identity. Stable invocation-derived identity makes replay return the same ticket.
2. The background Work task creates/reuses its owned WORK conversation and waits for its submission. It uses its own durable runtime, never retained `ToolExecutionApi` objects.
3. WORK uses the selected Kaeno orchestrator template/model with a scoped work role. It retains blocking delegation, parallel joins, review, and multi-step orchestration.
4. Work checkpoints its result and durably ensures one keyed Report task exists. Report submission and delivery are replay-safe through stable request IDs and checkpoints.
5. Report waits for acknowledgement release, validates the epoch, then submits completion using `followUp`. Existing inbox serialization resolves races with new user turns.

Frontdesk has one dispatch path: substantial work goes through `work.start`; it does not retain a competing synchronous delegate path. WORK cannot launch another background WORK job.

### Module map

- **`src/work.ts`** owns admission, immutable job inputs, Work/Report task definitions, queries, and commands. Private implementation types stay unexported.
- **`src/agents.ts`** retains worker execution and cleanup. Delegate resolution consumes the frozen work binding rather than current global configuration; sandbox admission occurs here.
- **`src/threads.ts`** owns acknowledgement barriers and completion delivery. Refresh checks consider foreground activity, excluding background subtrees.
- **`src/api.ts`**, **`src/telegram.ts`**, **`src/schedule.ts`** capture origin and expose channel behavior; task definitions register before resume in **`src/kaeno.ts`**.

### Load-bearing invariants

**Native task ownership is authoritative.** Status derives from task state and phase checkpoints; there is no mirrored jobs-status database. Cancelling Work crosses its background boundary and aborts its foreground subtree. Existing delegate annotations and sweeper rules remain intact.

**Capacity belongs to sandbox admission.** Before pod creation, delegates acquire durable resource reservations through one serialized allocator. Waiting delegates consume no sandbox. Reservations survive crashes and release only after confirmed pod removal. Admission accounts for pods, CPU, memory, and other namespace consumers: unchanged limits permit at most four workers, not five. Kubernetes remains the final quota authority.

**Completion is data, not a user command.** A private, validated envelope carries provenance through frontdesk ingress. Worker text cannot impersonate a user, authorize tools, or introduce credentials. This requires an explicit ingress adaptation; plain user-text interpolation is insufficient.

**Acknowledgement precedes reporting.** Fast results remain held behind the originating acknowledgement barrier. Telegram releases it after successful send and checkpoint; external duplicates remain possible after a send/crash.

**Contexts do not drift.** WORK reads its captured context, plus explicit steering submissions—not mutable frontdesk history. Each actor owns its conversation state; results merge at the inbox boundary.

The public interface hides task ownership, replay, bindings, routing, admission, and delivery. Callers see only a ticket and intentional controls: a deep module, not staged orchestration exposed as options.

## Synthesis decision

For Arena to fill. This candidate’s base is per-request WORK orchestration.

## Tradeoffs accepted

- We accept a second conversation in exchange for preserving existing delegation semantics and natural multi-step work.
- We accept queued steering in exchange for avoiding unsafe mid-tool mutation.
- We accept at-least-once Telegram delivery in exchange for compatibility with its non-idempotent send API.
- We accept retained task/result metadata in exchange for durable recovery and disconnected retrieval.

## Alternatives considered

- **Frontdesk-owned worker jobs:** fewer conversations, but exposes joins, follow-on scheduling, and intermediate-result coordination to short chat turns.
- **Detached delegate promises:** apparently small interface, but leaks invocation lifetime and loses durable ownership/cancellation; rejected.

## Open questions and risks

- Should `/stop` cancel foreground activity plus all Work jobs? Recommended: yes; explicit per-job cancellation remains available.
- Should `/new` atomically advance the epoch and cancel old Work jobs? Recommended: yes; stale reports are suppressed.
- Is pi status/reconnect retrieval acceptable initially? Automatic later replies require a durable feed and verified extension lifecycle integration; the current one-request provider cannot provide them.
- What retention period should preserve results and deduplication records?

Legacy synchronous tasks should drain through their existing implementation; deployment must retain their task definitions and cleanup behavior.

## Next implementation step

After approval, establish the replay-safe Work ownership boundary and frozen binding contract before changing frontdesk dispatch or channel delivery.
