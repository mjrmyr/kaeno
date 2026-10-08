# Candidate design: job-scoped specialists on Pi Durable

## Usage first

A specialist is a reusable definition in `agentsDir`, not a permanently running agent. Kaeno is one conversational contact. Delegation creates a fresh, background job with its own child conversation; the contact can continue answering while that conversation works.

```ts
import { openKaeno } from "kaeno";

const kaeno = await openKaeno({
  stateFile: ".kaeno/state.sqlite",
  agentsDir: ".kaeno/agents",
  contact: {
    model: { provider: "openai", modelId: "gpt-6-sol" },
    instructions: "Coordinate research. Delegate bounded reading tasks.",
  },
  limits: { activeJobs: 4, activePerAgent: 2, retainedJobs: 10_000 },
});

// HTTP intake: admission is not an answer.
const receipt = await kaeno.send({
  requestId: request.headers["idempotency-key"],
  text: request.body.message,
});
response.status(202).json(receipt);
// A separate endpoint may await kaeno.answer(receipt), or clients can subscribe.
```

```ts
// UI: refresh from state after reconnect; events are not delivery receipts.
const stop = await kaeno.subscribe((event) => render(event));
render({ type: "snapshot", value: await kaeno.snapshot() });

const jobs = await kaeno.listJobs();
const research = jobs.find((j) => j.agent === "researcher");
if (research) renderJob(research); // Includes a result card even if Kaeno never narrated it.
```

```ts
// Operator or user action. Ordinary contact cancellation does not stop background jobs.
await kaeno.cancelContact();
await kaeno.cancelJob(jobId);
const answer = await kaeno.answer(receipt); // May be unanswered after contact cancellation.
await kaeno.close();
```

The contact has **two** application tools: `delegate_job(agent, objective)` and `job_status(jobId?)`. It can delegate autonomously during a turn, respond with the new job ID without waiting, and later read results while talking to the user. A completed job makes **one bounded attempt** to submit a contact follow-up. If that attempt is withdrawn or stranded, the result remains available through `listJobs`/`job_status`; a user can explicitly ask the contact to discuss it. There is no promise of autonomous, repeated narration.

A supported first directory entry is deliberately narrow:

```json
{
  "name": "researcher",
  "description": "Reads supplied project files and returns a concise finding.",
  "model": { "provider": "openai", "modelId": "gpt-6-sol" },
  "thinkingLevel": "medium",
  "instructions": "Answer the assigned objective; cite files you read.",
  "tools": ["read"],
  "extensions": ["kaeno.read-v1"],
  "workspace": "/srv/projects/example",
  "deadlineMs": 120000
}
```

`[]` is also a valid tools selection. Unknown models, tools, extensions, or revisions are errors, not silently omitted selections. Only the installed `read` capability is supported initially: Durable ships `read`, `write`, `edit`, and `bash`, **not** `grep`, `find`, `ls`, skills discovery, or MCP integration. `workspace` sets a working directory, **not a security sandbox**. Deployments must trust the worker and its accessible filesystem until a real isolated execution environment is implemented.

## Module map and ownership

```text
src/kaeno.ts       Public facade: one owner lock, Harness startup, send/answer,
                   snapshots/subscriptions, cancellation, close.
src/directory.ts   Trusted directory parser; immutable effective profiles and
                   runtime-revision validation. No live reload.
src/jobs.ts        Sole owner of Kaeno job policy/document, delegate and
                   job_status tools, and the native Job task definition.
src/native.ts      Harness/SQLite/pi-ai/registry setup and explicit extension
                   installation; no second session or task scheduler.
.kaeno/agents/     Trusted specialist templates.
```

`jobs.ts` owns **one conversation-scoped, latest-only document on the root contact**. It contains `byToolTask` for create-once lookup and `jobs` keyed by public job ID. Each record contains an immutable objective/profile, task and child-conversation references, and an optional durable result card and notice-attempt metadata. This is an application aggregate, not another execution ledger: Durable remains the sole authority for task state, submissions, transcripts, abort marks, and checkpoints. The document survives retirement of task-scoped documents.

Dominant reads are direct `jobs[jobId]` and `byToolTask[api.taskId]`; `listJobs` scans the bounded aggregate. Admission counts records without result cards whose **native job task is still live**, in the transaction, rather than trusting a synchronized counter. `retainedJobs` bounds that scan and document growth. Reaching the retention limit rejects creation even if active capacity is free; export/retirement is a later, explicit feature, not silent deletion of inspectable results.

## Type and signature sketch

These are proposed Kaeno signatures. Native imports below are confined to `jobs.ts`/`native.ts`; public callers do not import Durable or Chord types. Bodies marked `not implemented` are scaffold, not claims of a working bot.

```ts
// kaeno.ts — public domain API
export type ModelChoice = {
  readonly provider: string;
  readonly modelId: string;
};
export type ContactSpec = {
  readonly model: ModelChoice;
  readonly instructions: string;
};
export type Limits = {
  readonly activeJobs: number;
  readonly activePerAgent: number;
  readonly retainedJobs: number;
};
export type OpenOptions = {
  readonly stateFile: string;
  readonly agentsDir: string;
  readonly contact: ContactSpec;
  readonly limits: Limits;
};
export type JobId = string & { readonly __jobId: unique symbol };
export type SendReceipt = {
  readonly requestId: string;
  readonly submissionId: string;
};
export type Answer =
  | { readonly type: "answered"; readonly text: string }
  | { readonly type: "unanswered"; readonly reason: string };

export type Finding = {
  readonly summary: string;
  readonly evidence: readonly { readonly path: string; readonly detail: string }[];
};
export type JobResult =
  | { readonly type: "completed"; readonly finding: Finding }
  | { readonly type: "failed"; readonly reason: string }
  | { readonly type: "cancelled" }
  // Application assessment, not a Pi Durable task outcome.
  | { readonly type: "outcome_unknown"; readonly reason: string };
export type Notice =
  | { readonly type: "pending" }
  | { readonly type: "attempted"; readonly submissionId: string }
  | { readonly type: "deferred"; readonly reason: string };
export type JobView =
  | {
      readonly type: "active";
      readonly id: JobId;
      readonly agent: string;
      readonly objective: string;
    }
  | {
      readonly type: "decided";
      readonly id: JobId;
      readonly agent: string;
      readonly objective: string;
      readonly result: JobResult;
      readonly notice: Notice;
    };
export type KaenoSnapshot = {
  readonly contact: { readonly messages: readonly ContactMessage[] };
  readonly jobs: readonly JobView[];
};
export type ContactMessage = {
  readonly role: "user" | "assistant";
  readonly text: string;
};
export type KaenoEvent =
  | { readonly type: "snapshot"; readonly value: KaenoSnapshot }
  | { readonly type: "contact_changed" }
  | { readonly type: "jobs_changed" };
export interface Kaeno {
  send(input: { readonly requestId: string; readonly text: string }): Promise<SendReceipt>;
  answer(receipt: SendReceipt): Promise<Answer>;
  snapshot(): Promise<KaenoSnapshot>;
  listJobs(): Promise<readonly JobView[]>;
  subscribe(listener: (event: KaenoEvent) => void): Promise<() => Promise<void>>;
  cancelJob(id: JobId): Promise<void>;
  cancelContact(): Promise<void>;
  close(): Promise<void>;
}
export async function openKaeno(options: OpenOptions): Promise<Kaeno> {
  throw new Error("not implemented");
}

// directory.ts — trusted configuration, resolved once per process
export type EffectiveProfile = {
  readonly name: string;
  readonly model: ModelChoice;
  readonly thinkingLevel: "off" | "low" | "medium" | "high";
  readonly instructions: string;
  readonly tools: readonly ("read")[]; // Empty array allowed.
  readonly extensions: readonly ("kaeno.read-v1")[];
  readonly workspace: string;
  readonly deadlineMs: number;
  // Digest of installed tool/task/environment code and selected resources.
  readonly runtimeRevision: string;
  readonly profileRevision: string;
};
export interface Directory {
  get(name: string): EffectiveProfile | undefined;
  all(): readonly EffectiveProfile[];
}
export function loadDirectory(path: string): Promise<Directory> {
  throw new Error("not implemented");
}
export function assertInstalledRevision(profile: EffectiveProfile): void {
  throw new Error("not implemented");
}

// jobs.ts — private, native-facing definitions and aggregate
import {
  configure, defineDoc, defineExtension, defineTask, defineTool,
  type ConversationId, type TaskId, type Tx,
} from "@earendil-works/pi-durable";

type JobRecord = {
  taskId: TaskId;
  childId: ConversationId;
  agent: string;
  objective: string;
  profile: EffectiveProfile;
  result?: JobResult;
  notice?: Notice;
};
type JobsState = {
  byToolTask: Record<string, { digest: string; jobId: JobId }>;
  jobs: Record<string, JobRecord>;
};
const JobsDoc = defineDoc<JobsState>({
  kind: "kaeno.jobs", version: 1, scope: "conversation",
  history: "latest", fork: "initial",
  initial: () => ({ byToolTask: {}, jobs: {} }),
});

type JobInput = {
  readonly objective: string;
  readonly profile: EffectiveProfile;
  readonly deadlineAt: number;
};
type JobCheckpoint =
  | { readonly phase: "start" }
  | { readonly phase: "await_child" }
  | { readonly phase: "report" };
type JobTaskResult = { readonly jobId: JobId };

export const Job = defineTask<JobInput, JobCheckpoint, JobTaskResult>({
  name: "kaeno.job", version: 1,
  initial: () => ({ phase: "start" }),
  phases: {
    start: async (task, runtime, context) => {
      // TODO: obtain childId from JobsDoc[task.id]. Submit objective to that
      // child with requestId `kaeno:work:${task.id}`. The ID and content are
      // immutable. Commit checkpoint await_child; resubmission is safe.
      throw new Error("not implemented");
    },
    await_child: async (task, runtime, context) => {
      // TODO: reacquire the same child submission; wait cooperatively with
      // deadline. Read/validate its assistant answer inside runtime.commit.
      // Atomically write result + pending notice to JobsDoc and advance to
      // report. Failure/timeout paths write a result too; do not lose the card.
      throw new Error("not implemented");
    },
    report: async (task, runtime, context) => {
      // TODO: submit ONE root followUp using `kaeno:report:${task.id}`.
      // Then commit notice attempt and terminal outcome. A crash between
      // submit and commit resubmits the SAME ID; it cannot narrate twice by
      // creating another submission. It also cannot revive a withdrawn one.
      throw new Error("not implemented");
    },
  },
  abort: async (task, runtime, context) => {
    // TODO: after native bottom-up cancellation, preserve any existing card.
    // Otherwise check for child admission: none => cancelled; admitted but
    // no validated answer => outcome_unknown. Commit card + deferred notice
    // with the aborted terminal outcome. Never claim forced termination.
    throw new Error("not implemented");
  },
});

export function countActiveBeforeWrites(
  tx: Tx, state: JobsState, agent: string,
): Promise<{ global: number; agent: number }> {
  // TODO: before task/table writes, inspect tx.task(id) for bounded records
  // without result; completing/terminal tasks do not consume worker slots.
  throw new Error("not implemented");
}
export function jobView(
  record: JobRecord,
  nativeState: "live" | "terminal",
): JobView {
  // TODO: project one card; reconcile terminal missing cards as unknown.
  throw new Error("not implemented");
}
export function installJobExtension(directory: Directory, limits: Limits) {
  // TODO: defineTool({name:"delegate_job", replay:"safe", ...}).
  // execute validates objective/profile, then INSIDE ONE api.commit:
  // 1. read JobsDoc and byToolTask[api.taskId];
  // 2. same key + digest => existing job; changed digest => reject;
  // 3. check retention and native-live active capacity;
  // 4. tx.createTask(Job, immutable input,
  //      {ownership:{kind:"conversation"},background:true});
  // 5. tx.createConversation({ownership:{kind:"task",taskId}});
  // 6. configure(tx, child.id, explicit model/instructions/extensions/tools/cwd);
  // 7. write mapping + job record. Return job receipt; NO wait/send/stop.
  // Also define read-only job_status tool against committed records.
  throw new Error("not implemented");
}

// native.ts — private bootstrap, not a second persistence API
export async function openNative(options: OpenOptions): Promise<unknown> {
  // TODO: acquire OS-backed, process-lifetime exclusive owner lock BEFORE
  // opening one SQLite Harness. Install pinned extensions/model providers;
  // root() and inspect without resume. Validate stored contact and EVERY
  // unfinished job's effective revisions against installed runtime before
  // ANY submit/wait/resume. Reconcile terminal missing cards; then resume.
  throw new Error("not implemented");
}
```

The `unknown` bootstrap return above is intentionally an unfinished **private** scaffold; implementation replaces it with an internal Harness-owning type, never a public escape hatch. The tool’s model arguments require runtime validation even though the directory has trusted types.

## Transaction and ownership boundary

```text
root conversation: contact transcript and JobsDoc
  ├─ pi.tool(delegate_job): native tool-result entry arrives in a LATER commit
  │    └─ api.commit: lookup api.taskId + digest, check caps, create Job,
  │       create child conversation, configure child, write JobsDoc — ONE commit
  └─ Job task [background=true; owned by root conversation]
       └─ child conversation [owned by Job; ordinary/non-background]
            └─ native generation/tool tasks

Job start:       child.submit(stable work ID)             [separate admission]
Job await_child: native child answer → result card +
                 pending notice + report checkpoint       [one job commit]
Job report:      root.submit(stable follow-up ID)          [separate admission]
                 notice attempt + Job terminal outcome     [one job commit]
```

There is **no permanent anchor**. The job task is the background boundary and owns its ephemeral specialist conversation. Its `report` phase keeps that boundary alive until its one attempt finishes. Native bottom-up abort waits for ordinary child work before the job’s abort handler; an abort mark is cooperative, not proof that an in-flight model call stopped. Contact ordinary abort and idle waits skip the background job. Explicit `cancelJob` crosses the boundary by targeting its task; contact cancellation can withdraw a queued report without deleting its result.

The delegation create key is the **Durable tool task ID**, looked up *inside* the same commit that creates the job. The canonical request digest covers selected agent name and objective. Reusing that task ID with changed arguments rejects; provider tool-call IDs are diagnostic only. `replay: "safe"` applies **only** to this creation-only tool. It does not expose send, stop, or arbitrary effects under that replay promise. The built-in tool-result entry is a subsequent commit: after a crash, the model can briefly lack a receipt even though the job exists. Inspection finds the job.

## Recovery, limits, and observable promises

On reopen, hold a real OS-backed exclusive lock for the entire Harness lifetime. A second live owner fails before SQLite opens; a PID file or SQLite transaction lock is insufficient. Install the pinned runtime, open without scheduling, validate all stored effective profiles and the contact revision, reconcile terminal native job receipts missing application cards, **then** resume. A removed directory template does not change an existing job: its full effective profile is stored. If its required historical runtime is unavailable or has a different digest, fail closed **before even `submit` or `wait`**, rather than resolving stored names against new code. Directory changes take effect only at a later controlled opening; there is no hot reload or new model default for old jobs.

Capacity is rejected during delegation; there is no hidden job queue or second scheduler. The transaction counts undecided jobs with live native tasks before creation. A result card releases a worker slot; reporter admission does not consume one. A native task that faults or becomes terminal without the handler’s card is treated as undecided until reconciliation writes an `outcome_unknown` card. Inline admission checks do not count its terminal task as active, even before that repair, so aborts cannot leak slots. `retainedJobs` still caps total records. Deadline handling races cooperative waiting against the recorded deadline and requests child abort; a non-cooperative provider or tool can exceed it.

Job results and reporter metadata are application data in `JobsDoc`; task receipts are native execution records, **not two competing task stores**. A successful card is not rolled back because parent narration failed or job cancellation arrived during `report`. A withdrawn report retried with the same request ID is still withdrawn. A failed contact run can leave an admitted report queued. In both cases the card remains visible, and `job_status` supports an explicit user-requested discussion; MVP does not launch an unbounded retry loop. Native `watchDoc`, contact observation, and replacement snapshots drive subscriptions, but clients must refresh with `snapshot()` after reconnect. Neither watching nor `Submission.wait()` acknowledges user receipt of a narrated result.

Contact `requestId` has Durable’s **per-conversation, same-type deduplication** semantics: reuse can return the previous submission even if text differs. The public API does not promise content-conflict rejection for user input; clients must mint one ID per intended message. `answer()` can wait a long time, and admitting another message does not interrupt a stalled contact provider request. SQLite WAL/NORMAL supports the stated process-crash model, not guaranteed survival of the newest commit after power loss.

## Test-first minimal implementation sequence

1. **Ownership and intake:** a faux-model test proves `send` returns before answer; contact answers another admitted turn while a background child works; ordinary contact abort leaves it running, targeted job abort reaches it. Verify a child directly owned by the delegate tool would fail this test.
2. **Creation transaction:** inject failure before/after `api.commit` and before the built-in tool-result commit. Replay the same `api.taskId`; assert one job/child, unchanged-argument receipt reuse, changed-argument rejection, and caps under concurrent delegate calls. Confirm capacity/retention rejection creates nothing.
3. **Worker and card:** crash around child admission, child answer, and result-card commit. Assert stable child request ID, validated finding, persistent card after task-doc retirement, terminal-fault reconciliation, and slot release across aborts.
4. **One report attempt:** crash between parent submission and notice commit; assert stable ID. Withdraw a queued report with contact abort and fail a run with another queued report; assert no claim of narration, no automatic retry storm, and explicit `job_status` access.
5. **Startup guard:** refuse a second process owner; remove or alter a pinned runtime/profile on reopen and prove no submit/wait schedules work. Restore the revision and prove checkpoint recovery. Test expired deadline and a non-cooperative invocation without claiming hard-stop behavior.
6. **Observation:** overflow a slow watch, reconnect, and verify `snapshot()` converges to the stored card without treating events as receipts.

## Rationale

### Problem

Kaeno needs one conversational contact that delegates independent work and later discusses results. Pi Durable already serializes commits, owns transcripts/tasks/submissions, and recovers checkpoints; its example’s persistent named subagents are not Kaeno’s required product semantics. The hard boundary is between atomic job creation or result recording **inside** a Session commit and separately admitted model work or contact follow-ups.

### Usage (caller’s view)

The three call sites above deliberately separate `send` from `answer`, expose inspectable jobs independently of narration, and distinguish contact cancellation from job cancellation. They specify no caller-side reporter loop, Durable handle, or transcript writer. `subscribe` is a refresh hint plus snapshots, not an acknowledgment protocol.

### Shape

The central structure is a bounded root `JobsDoc` indexed by native tool task identity and public job ID. One background `Job` owns one ephemeral child conversation and its one report attempt. Immutable profile data and runtime revision travel with the job, while native task state remains in Durable. Boundary validation rejects unknown resources and incompatible revisions; pure projection turns native state plus the card into `JobView`. This follows **encode-lessons-in-structure**, **boundary-discipline**, and **single source of truth**: no second scheduler, session files, synchronized quota counter, or writable worker appears in the first release. The public interface is deep relative to its small surface: it hides admission, ownership, recovery, reconciliation, and reporting while leaving only honest receipt/result/cancellation distinctions visible. Its main flow crosses `kaeno.ts` → `jobs.ts` → Durable, not a stack of forwarding adapters.

### Synthesis decision

This is the job-scoped candidate required for parallel comparison, not an arena synthesis. It chooses **one background task per delegated job**, with the reporter folded into that task, rather than copying the persistent named-specialist/anchor example. A later synthesis should compare this boundary against independently produced candidates; no comparison result is asserted here.

### Tradeoffs accepted

- We accept one possibly lost or stranded narration attempt in exchange for a bounded reporter and an independently durable result card.
- We accept capacity rejection and a finite lifetime retention cap in exchange for transactional admission without another scheduler or prematurely designed archival protocol.
- We accept read-only, trusted-local workers and cooperative deadlines in exchange for a shippable native first slice; neither `cwd` nor an allowlist is described as confinement.
- We accept fail-closed recovery when historical code is unavailable in exchange for never silently changing an unfinished job’s effective implementation.

### Alternatives consideres

- **Persistent named specialists with anchors:** hides repeated conversation creation but exposes specialist lifecycle, messaging, and stop semantics to contact callers; old prompts/tools and new messages share mutable history. It is a poorer fit for independent, bounded jobs.
- **Separate reporter task and notification queue:** can retry independently, but duplicates notice ownership and exposes more states before an acknowledgment policy exists. Fold its single attempt into `Job` until reliable delivery is actually required.
- **Host-managed Pi coding-agent sessions plus a job ledger:** makes the host coordinate two persistence authorities and cannot make delegation/task creation one Session transaction. Durable’s deeper native boundary wins.

### Open questions and risks

- Must results survive beyond the finite retained-job cap, and if so, what explicit export/archive contract is acceptable?
- Is process-crash recovery sufficient, or does deployment require stronger newest-commit survival after host power loss?
- When write-capable specialists are introduced, which actual isolated environment and effect-specific idempotency protocol will be required?

### Next implementation step

Write the pinned-build faux-model ownership and creation-transaction tests, then implement the `JobsDoc` and creation-only `delegate_job` commit against those tests.

**Red-flag screen:** No shallow public stage API, wire-type re-export, generic pass-through execution layer, split transcript/task ownership, or alternate delegation path is proposed. The indexed aggregate replaces a later “add a cache” plan; the one deliberate cross-record reconciliation handles native fault/orphan paths rather than hand-syncing two status lists. The only importable native-facing internals should be blocked by package exports so callers cannot bypass `Kaeno`.
