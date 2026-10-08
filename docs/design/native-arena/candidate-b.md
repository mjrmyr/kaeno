# Candidate B: persistent named specialists

## Usage (caller’s view)

Kaeno has one conversational contact. A specialist name denotes a **persistent conversation**, not a fresh conversation per job. The first delegation to `reader` creates its conversation; later delegations to `reader` reuse its transcript. Jobs for different specialists can run concurrently. Kaeno admits at most one outstanding job per specialist, so two jobs cannot interleave turns in the same transcript.

```ts
const kaeno = await openKaeno({
  stateFile: ".kaeno/state.sqlite",
  agentsDir: "kaeno/agents",
  contact: {
    model: { provider: "openai", modelId: "gpt-6-sol" },
    instructions: "Help the user; delegate bounded research when useful.",
  },
  limits: { activeJobs: 4 },
});

const receipt = await kaeno.send({
  requestId: "web:conversation-17:message-42",
  text: "Compare the two proposals. Ask reader to inspect the first.",
});
// Admission is durable; an answer is not implied.
const answer = await kaeno.answer(receipt.id);
```

A UI can reconnect without waiting for any worker or treating a live event as a delivery receipt:

```ts
const unsubscribe = kaeno.subscribe((snapshot) => render(snapshot));
const { jobs } = await kaeno.listJobs({ limit: 20 });
const reader = jobs.find((job) => job.agent === "reader");
if (reader) renderJobCard(await kaeno.job(reader.id));
```

Cancellation and a deliberately explicit, bounded notification retry are separate actions:

```ts
await kaeno.cancelJob(jobId);       // Does not delete reader's conversation.
await kaeno.cancelContact();        // Does not cancel background jobs.
await kaeno.reportAgain(jobId);     // At most one manual second notice.
await kaeno.close();
```

Directory entry, for example `kaeno/agents/reader.json`:

```json
{
  "name": "reader",
  "model": { "provider": "openai", "modelId": "gpt-6-sol" },
  "thinkingLevel": "off",
  "instructions": "Read the supplied material and cite relevant passages.",
  "tools": ["read"],
  "extensions": ["kaeno-read"],
  "runtimeRevision": "kaeno-read@1:sha256-verified-build"
}
```

`[]` is also valid for `tools`. MVP does not offer `grep`, `find`, `ls`, skills, MCP, `bash`, `write`, or `edit`. An allowlist and `cwd` do **not** sandbox the process.

## Separate design and type sketch

### Ownership and transaction map

```text
root contact conversation
├── background Anchor(reader) task ── owns persistent reader conversation
├── background Job(J1) task ──────── owns Turn(J1) task
├── background Job(J2) task ──────── owns Turn(J2) task (another specialist)
├── background Reporter(J1, attempt 1) task
└── background Reporter(J1, attempt 2) task, only by explicit request
```

An anchor is necessary in this candidate: the named conversation must outlive any individual job, while normal contact abort and idle traversal must not enter it. The job **does not own** that conversation. It owns a `Turn` task that submits exactly one request to the named conversation and waits for its answer. The reporter is a **sibling background task**, not a child of the job: a result decided just before job cancellation can still be reported. Ordinary contact abort skips anchors, jobs, and reporters. Explicit job cancellation reaches its `Turn`, but not the anchor.

The contact’s `delegate` tool is **creation-only**. Inside **one** `api.commit`, it reads the existing delegation keyed by `api.taskId`; identical normalized arguments return its existing job, and changed arguments fail. Otherwise it checks capacity and the specialist’s lease, creates an anchor/conversation only if absent, creates a background `Job` and its task-owned `Turn`, and records the delegation mapping, immutable effective profile, and reservation. It does not submit specialist input, stop work, or send a report. Durable’s subsequent `pi.tool` result is a **different commit**.

The lease serializes turns to a specialist. Different named conversations need no shared transcript lock. Global capacity is the length of a bounded active-ID set, updated on the same Session line as admission and release; it is not a separate scheduler or a counter synchronized with task receipts. A cancellation leaves its lease held until the specialist run is idle and the associated child has settled. Capacity rejection, rather than a pending-job queue, is the MVP policy.

**Sketch, not implementation** — external contexts, models, storage setup, and error conversion are omitted from bodies intentionally. The internal signatures use verified Pi Durable primitives at pinned source commit `6fb2e7815167e6b19006fc526d1a5d0f5f998787`; none appear in Kaeno’s public interface.

```ts
// src/public.ts — domain API; no Durable or transport types
export type ModelChoice = Readonly<{ provider: string; modelId: string }>;
export type SendRequest = Readonly<{ requestId: string; text: string }>;
export type SendReceipt = Readonly<{ id: string; disposition: "admitted" }>;
export type Answer =
  | Readonly<{ status: "answered"; text: string }>
  | Readonly<{ status: "unanswered"; reason: string }>;
export type JobResult =
  | Readonly<{ status: "succeeded"; text: string }>
  | Readonly<{ status: "failed"; reason: string }>
  | Readonly<{ status: "cancelled"; reason: string }>
  | Readonly<{ status: "outcome_unknown"; reason: string }>;
export type JobView =
  | Readonly<{ id: string; agent: string; status: "active"; notice: NoticeView }>
  | Readonly<{ id: string; agent: string; status: "finished";
              result: JobResult; notice: NoticeView }>;
export type NoticeView =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "admitted"; attempt: 1 | 2 }>
  | Readonly<{ status: "withdrawn" | "unanswered"; attempt: 1 | 2 }>
  | Readonly<{ status: "not_requested" }>;
export type KaenoSnapshot = Readonly<{
  contact: readonly { role: "user" | "assistant"; text: string }[];
  jobs: readonly JobView[];
}>;
export interface Kaeno {
  send(request: SendRequest): Promise<SendReceipt>;
  answer(receiptId: string): Promise<Answer>;
  job(id: string): Promise<JobView | undefined>;
  listJobs(query: { limit: number; before?: string }): Promise<{
    jobs: readonly JobView[]; before?: string;
  }>;
  snapshot(): Promise<KaenoSnapshot>;
  subscribe(onChange: (snapshot: KaenoSnapshot) => void): () => void;
  cancelJob(id: string): Promise<void>;
  cancelContact(): Promise<void>;
  reportAgain(id: string): Promise<void>;
  close(): Promise<void>;
}
export type AgentFile = Readonly<{
  name: string; model: ModelChoice; thinkingLevel: "off" | "low" | "medium" | "high";
  instructions: string; tools: readonly ("read")[];
  extensions: readonly ("kaeno-read")[]; runtimeRevision: string;
}>;
export type EffectiveProfile = Readonly<{
  name: string; model: ModelChoice; thinkingLevel: AgentFile["thinkingLevel"];
  instructions: string; tools: readonly ("read")[];
  extensions: readonly ("kaeno-read")[];
  runtimeRevision: string; digest: string;
}>;
export type OpenOptions = Readonly<{
  stateFile: string; agentsDir: string;
  contact: { model: ModelChoice; instructions: string };
  limits: { activeJobs: number };
}>;
export declare function openKaeno(options: OpenOptions): Promise<Kaeno>;

// src/native.ts — private to Kaeno's native integration
import {
  AssistantEntry, configure, defineDoc, defineDocFamily, defineTask,
  defineTool, type ConversationId, type TaskId,
} from "@earendil-works/pi-durable";

type Specialist = {
  anchorId: TaskId; conversationId: ConversationId;
  profile: EffectiveProfile;
  leaseJobId?: string; // present until Turn settled AND conversation idle
};
type ActiveIndex = {
  specialists: Record<string, Specialist>;
  activeJobIds: string[]; // bounded; never a second execution ledger
  delegations: Record<string, { digest: string; jobId: string }>;
};
const Index = defineDoc<ActiveIndex>({
  kind: "kaeno.index", version: 1, scope: "conversation",
  history: "latest", fork: "initial",
  initial: () => ({ specialists: {}, activeJobIds: [], delegations: {} }),
});
type StoredJob = {
  agent: string; profile: EffectiveProfile; objective: string;
  jobTaskId: TaskId; turnTaskId: TaskId;
  result?: JobResult; cancelRequested?: boolean;
  notice: NoticeView; reportAttempts: 0 | 1 | 2;
};
const Jobs = defineDocFamily<StoredJob, StoredJob>({
  kind: "kaeno.job", version: 1, family: true, scope: "conversation",
  history: "latest", fork: "initial", initial: seed => seed,
});
type AnchorState = { phase: "hold" };
const Anchor = defineTask<{ agent: string }, AnchorState, null>({
  name: "kaeno.anchor", version: 1,
  initial: () => ({ phase: "hold" }),
  phases: {
    hold: async (_task, runtime, context) => {
      // TODO: decide completion; owned persistent conversation survives
      // terminal anchor while ordinary work beneath it drains.
      await runtime.commit(
        () => ({ status: "terminal",
                 outcome: { status: "completed", result: null } }), context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});
type JobInput = { id: string };
type JobState = { phase: "join" } | { phase: "finish" };
const Job = defineTask<JobInput, JobState, null>({
  name: "kaeno.job-task", version: 1,
  initial: () => ({ phase: "join" }),
  phases: {
    join: async (task, runtime, context) => {
      await runtime.commit(async tx => {
        const row = await tx.doc(Jobs, runtime.conversationId,
                                 task.input.id, /* persisted seed */ null!);
        return { status: "waiting", checkpoint: { phase: "finish" },
                 on: [row.turnTaskId], policy: "allSettled" };
      }, context);
    },
    finish: async (task, runtime, context) => {
      await runtime.commit(async tx => {
        // TODO: reconcile missing Turn result from native terminal receipt;
        // release lease only after child settled and specialist is idle.
        return { status: "terminal",
                 outcome: { status: "completed", result: null } };
      }, context);
    },
  },
  abort: async (task, runtime, context) => {
    // TODO: reconcile result and guarded lease after child abort;
    // never abort the independent anchor here.
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});
type TurnInput = { id: string; specialistConversationId: ConversationId;
                   objective: string; profileDigest: string };
type TurnState = { phase: "submit" } | { phase: "await" };
const Turn = defineTask<TurnInput, TurnState, null>({
  name: "kaeno.turn", version: 1,
  initial: () => ({ phase: "submit" }),
  phases: {
    submit: async (task, runtime, context) => {
      // TODO: verify stored profile/runtime revision before invoking;
      // submit with requestId `kaeno:turn:${task.input.id}`.
      // Repeating submission must recover the SAME child request.
      throw new Error("not implemented");
    },
    await: async (task, runtime, context) => {
      // TODO: wait for settlement; read answer from child's context at
      // settled.answer; validate and bound text. In ONE runtime.commit,
      // write result + pending notice to Jobs, create root-background
      // Reporter(attempt 1), and decide this Turn's native outcome.
      throw new Error("not implemented");
    },
  },
  abort: async (_task, _runtime, _context) => {
    // TODO: record cancellation result unless already decided; create
    // sibling reporter in same commit where possible.
    throw new Error("not implemented");
  },
});
type ReportInput = { id: string; attempt: 1 | 2 };
type ReportState = { phase: "post" };
const Reporter = defineTask<ReportInput, ReportState, null>({
  name: "kaeno.report", version: 1,
  initial: () => ({ phase: "post" }),
  phases: {
    post: async (_task, _runtime, _context) => {
      // TODO: submit contact followUp using `kaeno:report:${id}:${attempt}`;
      // persist submission identity/status; do not wait for narration.
      throw new Error("not implemented");
    },
  },
  abort: async (_task, _runtime, _context) => {
    throw new Error("not implemented");
  },
});
// defineTool({ name: "delegate", replay: "safe", parameters: ...,
//   execute: async (args, api, ctx) => api.commit(async tx => {
//     const index = await tx.doc(Index, api.conversationId);
//     const old = index.delegations[String(api.taskId)];
//     if (old) return identicalDigest(old, args) ? receipt(old.jobId)
//                                                 : rejectConflict();
//     // Validate catalog and runtime; check bounded active IDs and lease.
//     // Create anchor + task-owned conversation only for a new name;
//     // configure child with explicit selected model/extensions/tools.
//     // Create background Job owned by root; create Turn owned by Job.
//     // Record keyed mapping, immutable profile, job row and reservation.
//   }, ctx)) });
// No stop/send effect belongs in this replay-safe tool.
```

`null!` marks an intentionally unimplemented family-document read in the sketch, **not** a suggested production escape hatch: the implementation must provide the existing persisted seed or a typed read helper and fail if the job row is missing. The definitive `Job`/`Turn` input and checkpoint shapes are above; the `Reporter` input/checkpoint is one attempt, not an unbounded retry loop.

### Module map and read paths

- `src/public.ts`: the only application import surface; converts Durable submissions, task records, and stored jobs to domain views.
- `src/native.ts`: owns delegation, specialist leases, task definitions, result/notice documents, and reconciliation. Keep these coupled invariants together, rather than distributing them across admission, execution, and recovery layers.
- `src/directory.ts`: parses trusted files once at startup into immutable effective profiles; verifies exact selected model, tool, extension, environment/resource revision, and runtime build. No ambient extension or model defaults and no hot reload.
- `src/host.ts`: acquires a process-lifetime owner guard **before** opening the sole Harness SQLite store; installs the pinned registry, validates persisted revisions before *any* resume, submit, or wait, then exposes `Kaeno`. It releases the guard only after successful close.

`job(id)` reads the conversation-scoped `Jobs` family member and the native task receipt. `listJobs` pages native `kaeno.job-task` records with `scanTasks({conversationId, kind, order})` and reads the corresponding retained job documents. Active capacity reads the bounded `activeJobIds`; a specialist lease lives next to that specialist’s conversation ID. The result document is product metadata in the **same Harness SQLite store**, not a second task scheduler or ledger. It outlives task-document retirement; native task records remain the execution receipts. Reconciliation derives missing outcome cards from terminal receipts rather than pretending every abort hook necessarily committed a card.

### Recovery, cancellation, and reporting rules

Open pauses scheduling while checking every retained specialist and live job against its recorded effective profile and installed runtime revision. A changed directory file cannot silently replace a specialist’s instructions or resources: existing conversations retain their profile, and new jobs for a missing or changed name are rejected. If required historical code is unavailable, startup fails closed until that revision is installed or an explicit migration is designed. No API call that schedules work—particularly `send`, `answer`/wait, or report submission—may bypass that check. After reconciliation, call `resume()`.

`cancelJob` records cancellation intent, keeps the specialist lease, aborts its conversation’s current run **only while this job still owns the lease**, then aborts the background job. It must reconcile a crash between those steps before accepting another job for that specialist. Abort is bottom-up and cooperative: a stalled provider call may delay terminal state or `close()`. A result committed before cancellation remains the result; a late abort cannot retract its independent reporter. A faulted/orphaned child, or an ambiguous effect if writable capabilities are ever added, maps to an application `outcome_unknown` card rather than inventing a Durable outcome enum. With read-only tools, this mostly describes an explicit future boundary.

A reporter submits one stable-ID `followUp`, then records **admission**, not delivery or narration. Parent abort can withdraw that queued input; a failed contact run can strand another queued input. Reusing its request ID will find the old submission. Results therefore remain visible through `job`, `listJobs`, and snapshots. No automatic infinite retry runs. `reportAgain` explicitly creates attempt 2 with a new request ID, after showing the first attempt’s disposition; there is no third attempt. Contact cancellation does not cancel root-background reporters already created.

Client `send` uses a persisted request-ID/content digest before calling native `submit`; changed text with the same ID is rejected because native submission deduplication alone does not compare content. An identical retry completes a possibly interrupted admission using the same native request ID. A receipt means admission, `answer` means submission settlement, and neither a watch event nor a model answer proves a human saw a job notice.

## Rationale

### Problem

Kaeno needs a conversational contact while autonomous specialists work, but Durable’s background tasks, submissions, and atomic documents do not themselves define specialist identity, memory, capacity, or notification policy. This candidate makes **named persistent specialist conversations** the product’s central invariant. That buys memory across jobs but introduces a real shared-transcript conflict, addressed by one outstanding job per specialist—not by hoping concurrent submissions will mean independent jobs.

### Usage (caller’s view)

The three call sites above are the contract: admit and separately await a contact answer; inspect durable job cards and subscribe to convergent snapshots; independently cancel a job, cancel contact work, or explicitly request one more report. Callers never handle Durable IDs, task checkpoints, wire entries, or submission records.

### Shape

The named specialist index points directly to its anchor-owned conversation and immutable effective profile. A job’s background root owns its `Turn`, so delegate-tool settlement cannot hold the contact open. The `Turn` borrows, but never owns, the specialist conversation. Transactional leases make that cross-ownership relationship explicit. Result and pending-report metadata are decided with reporter creation where the `Turn` can commit them together; native tool-result and parent `followUp` admission remain later commits.

Validation happens at the file, tool-argument, client-request, and restart boundaries; task phases trust the persisted profile identity but recheck installed runtime compatibility before scheduling. The public interface is deep: a small set of methods hides transcript ownership, replay, leases, report attempts, and recovery, while exposing the genuinely distinct facts of admission, answer, and job result. This follows the runner’s data-first, boundary-discipline, single-source-of-truth, and idempotent-creation principles.

### Synthesis decision

This is the independent **candidate B**, not an arena synthesis. Preserve its persistent-name and lease decisions for comparison with a job-scoped-conversation candidate; do not silently substitute a fresh conversation per job.

### Tradeoffs accepted

- We accept serialized work and capacity rejection **per named specialist** in exchange for coherent persistent memory; different specialists remain concurrent.
- We accept durable anchors and a guarded cross-ownership lease in exchange for conversations that survive both jobs and ordinary contact cancellation.
- We accept inspectable result cards without guaranteed narration in exchange for a bounded, honest reporting policy.
- We accept process-crash-oriented SQLite durability; WAL `synchronous=NORMAL` does not promise the newest commit survives a host power failure.
- We accept read-only, host-permission execution for MVP in exchange for avoiding a false `cwd`-as-sandbox claim.

### Alternatives consideres

A **job-scoped conversation** removes shared-memory conflicts and anchors, and makes job ownership simpler, but loses named conversational continuity; callers must supply prior context or manage memory themselves, making that ostensibly smaller execution shape a shallower product interface. A **single persistent specialist with overlapping jobs** appears to improve utilization but lets their requests, cancellation, and answers interfere in one transcript; callers would need to understand interleaving. A **separate queue/ledger** could promise more scheduling and notification policy but duplicates Durable authority and enlarges failure boundaries.

### Open questions and risks

- Is rejecting a second job for a busy named specialist acceptable, or must a later version add a bounded per-specialist queue with explicit fairness?
- How much specialist history should remain in model context, and who may intentionally reset a named specialist after all its leases drain?
- Does the deployment require newest-commit survival after host power loss rather than the documented SQLite configuration?
- Can the host enforce a process-lifetime owner guard and retain old runtime revisions across deployments?
- Should a client acknowledgment of a result card become a later product requirement? Neither watches nor `followUp` admission provides it.

### Next implementation step

Write failing pinned-Durable tests for keyed creation, persistent reuse, same-specialist conflict, and crash/restart revision rejection before implementing `src/native.ts`.

### Red-flag screen and test-first sequence

The screen finds one deliberate complexity—the anchor and lease—but no pass-through execution layer, parallel store, or second way to delegate. Keep `native.ts` the sole writer of leases and job-result policy; expose only `public.ts`. Derive the supported tool selection from the installed, verified profile, not a hand-maintained second list. Do not export the native documents or task definitions.

1. **Admission tests:** same `api.taskId` and same args creates one job/anchor/turn; changed args reject; crash after creation but before `pi.tool` result returns the existing receipt; capacity and same-name conflicts reject atomically.
2. **Conversation tests:** sequential `reader` jobs reuse one conversation and prior context; two different specialists progress concurrently; canceling contact leaves background work; canceling a job cannot abort a newer specialist turn.
3. **Outcome tests:** crash at child submission, answer settlement, and result/reporter commit; stable IDs prevent duplicate child admission; result survives task-document retirement; bottom-up abort and fault/orphan receipts reconcile without releasing a busy lease.
4. **Notice tests:** parent abort withdraws a queued report; failed contact run strands input; status remains queryable; explicit second attempt has a new ID and no automatic third; watch overflow triggers snapshot convergence, never a claimed delivery.
5. **Host tests:** changed/missing profile or runtime blocks scheduling on restart; unknown selected tools reject; a second process owner cannot open; stalled effects demonstrate cooperative, not hard, deadlines and shutdown. Only after these tests build the thin public adapter and UI subscription mapping.
