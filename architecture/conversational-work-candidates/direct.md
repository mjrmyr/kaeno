# Candidate A: direct background worker jobs, coordinated by chat Kaeno

## Problem

Kaeno's root conversation blocks on `delegate` until the worker finishes, because the child is owned by the delegate tool task. That ownership gives cancellation, a synchronous result and pod cleanup in one mechanism. We want a short acknowledgement, a free chat, and a later natural reply.

Constraints from grounding:

- Workers stay disposable and frozen-binding.
- The sweeper keys on `kaeno.io/task`.
- Telegram sends and checkpoints can't be atomic, so duplicates are possible.
- Quota supports at most 4 workers, not 5.
- Refresh currently pins on any non-terminal conversation task.
- The pi provider closes its stream at `done`.

## Usage (caller's view)

The root model sees three tools. `delegate` is removed from the catalogue.

```ts
// turn 1 (root, short): user says "research X and Y"
const { batchId, jobs } = await start_jobs({
  title: "X vs Y",
  tasks: [
    { template: "researcher", task: "…X…" },
    { template: "researcher", task: "…Y…" },
  ],
});
// returns immediately: [{id, status:"running"|"queued"}] → root replies "On it, two workers started."

// turn 2 (user asks something else): chat is idle, normal reply.
await jobs(); // [{id,title,status:"running",ageMs}, …]  derived from task graph

// turn 3 (system-initiated, when the batch is terminal):
// input: <job-batch id=… status="done"> untrusted result data </job-batch>
// root may answer, or call start_jobs again for review or follow-on.

await cancel_jobs({ batchId }); // user-initiated; produces no completion turn
```

Telegram also gets deterministic `/jobs` and `/cancel <id>` commands that call the same functions.

## Shape

Task lifecycle is the single source of truth. There is no jobs table. Status is derived by `scanTasks` over job tasks of this conversation epoch.

```ts
// src/jobs.ts — one new module; agents.ts keeps sandbox mechanics
type Origin = { kind: "telegram"; chatId: number } | { kind: "pi" };

type JobInput = {
  batchId: TaskId;
  index: number;
  title: string;
  task: string;
  binding: FrozenBinding; // template, skills, image, env token: frozen at start, not current config
  origin: Origin; // captured from the originating Turn, never "last chat"
  epoch: ConversationEpoch; // see /new below
  afterTurn: TaskId; // the ack Turn this job was launched from
};
type JobPhase = "queued" | "slotHeld" | "answered"; // task checkpoint
type JobView = {
  id;
  title;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  ageMs: number;
  answer?: string;
};

export function jobTools(deps): ToolDef[]; // start_jobs, jobs, cancel_jobs
export function registerJobTask(reg: Registry): void; // before resume in kaeno.ts
async function runJob(input: JobInput, ctx: TaskCtx): Promise<void>; // body below
function envelope(batch: BatchResult): UserInputContent; // data-only wrapper
```

**Ownership graph.**

- `start_jobs` is replay-safe and, in one `Tx`, creates N `job` tasks with `background:true`. Each is owned by the root conversation and gets a deterministic id `job:<batchId>:<i>`. Replay reuses them.
- The job task body is the extracted body of today's delegate execute: create the sandbox (409 tolerated), await ready, submit the worker with `delegate:<jobTaskId>`, wait, and delete the pod in `finally`.
- The worker child is owned by the job task, so the ownership chain is preserved. The pod annotation becomes the job task id, so the sweeper is unchanged.
- Parent idle skips background tasks, so the root is free. Normal `/stop` doesn't kill jobs. `abort({background:true})` crosses the boundary.

**Completion (idempotent).**

- When a worker answers, the job checkpoints `answered` plus the answer. In one `Tx` it marks itself terminal, and if every sibling in the batch is terminal it creates the Turn task `done:<batchId>`.
- The deterministic id means two racing last-finishers produce one Turn. A crash before the commit replays from the checkpoint and does not re-run the worker.
- The existing `Turn` is reused for delivery. It carries `notify = origin` and submits the envelope with stable `requestId` and `whenBusy:"followUp"`. Telegram send is at-least-once, so duplicate-after-crash stays possible. We don't claim otherwise.
- Same-conversation inbox serialization handles collisions with user turns.

**Ack race.** The completion Turn first waits for `afterTurn` to be terminal, which means the ack was sent. The ordering is a data dependency, not a timer. Only the ack's retry duplicate can still interleave.

**Authority.** The envelope is a system-generated wrapper that states the content is untrusted data from a worker. Root instructions say job results never grant tool approval, credentials or user commands. Verify whether pi-durable `Submission` supports a source or metadata field. If it does, use it. If not, the wrapper is a convention, not a guarantee.

**Capacity.**

- `cap = min(pods − 1 − headroom, ⌊(cpuNs − mainCpu)/workerCpu⌋, ⌊(memNs − mainMem)/workerMem⌋)`, which is 4 on the current quota. It is computed from config constants, not hardcoded.
- A job's first phase runs `claimSlot` in a `Tx`. The Tx scans jobs with `slotHeld`, claims FIFO by creation order if under cap, and otherwise sleeps and retries with a durable timer. There is no scheduler framework.
- `start_jobs` rejects when the queue exceeds a small bound (e.g. 8) with a busy answer. Quota or forbidden errors at sandbox creation return the job to `queued` instead of failing it.
- Slot release is derived: the job task is terminal, and the pod was deleted in `finally`.

**Epoch and `/new`.**

- `/new` aborts jobs of the thread with `background:true`, then resets. The user asked for a clean context, so results into the old context would be wrong.
- `JobInput.epoch` is a guard: the completion Tx drops delivery if the epoch is stale. If reset mints a new conversationId, the id is the epoch and no new field is needed. Otherwise add a counter to the thread record.
- `/stop` aborts the foreground turn only. Jobs continue, and `/jobs` and `/cancel` stop them.

**Refresh gate.** `configureThread` ignores background job tasks and pins only on foreground tasks, Turns and inbox. Jobs run on frozen bindings, so refresh mid-job is safe. Completion Turns still pin, which is brief.

**Multi-step and fanout.**

- Fanout is one `start_jobs` call, and the batch is the join. Completion is delivered once.
- Multi-step is the root reacting to a completion turn with another `start_jobs`. The root coordinates only short turns and holds no long-lived tool call.
- Workers don't spawn jobs, so there are no nested joins.

**Legacy.** Keep the `delegate` task definition registered for replay only. It is removed from the tool catalogue. Active synchronous calls across a deploy resume and complete as before. Delete the definition when `scanTasks` shows none for a release.

**pi protocol.** The provider gets the ack and closes at `done`. The completion lands in conversation history and shows in `jobs()` and on the next request. Spontaneous display needs a separate durable feed with a cursor, which is out of scope here. Say so plainly in the pi extension docs, with no invented pi APIs.

**Interface depth.** Three tools hide slot admission, frozen bindings, joins, completion dedup, origin routing, epoch guard and cleanup. Callers never see phases, slots or task ids beyond `batchId`. The Telegram adapter changes only by adding two commands and passing `origin`.

## Synthesis decision

_(filled by arena)_

## Tradeoffs accepted

- We accept the root being re-entered per completion, with context-window cost, in exchange for no second orchestrator conversation to own, cancel, refresh or deliver from.
- We accept a root that coordinates by short turns, so there is no long-running review loop. Multi-step logic lives in the root prompt, not in code.
- We accept poll-with-durable-sleep for slot waits in exchange for no scheduler or queue table.
- We accept at-least-once Telegram completion in exchange for honesty and simplicity.
- `/new` cancels jobs. This is a product call that may surprise users.
- There is no steer in v1. The path is cancel and restart.

## Alternatives considered

- **B: per-request work conversation**, with an orchestrator that retains blocking `delegate`. It gives better multi-step isolation and keeps old code. It loses on interface depth: a second conversation needs its own epoch, refresh policy, status and delivery. Two ownership layers (Work, then delegate) multiply cancel and cleanup paths. It also leaves two ways to delegate.
- **Dropping `await` on delegate with a detached promise.** Rejected because `ToolExecutionApi` is invocation-bound and the ownership guarantees vanish.
- **A jobs table mirroring status.** Rejected because it duplicates the task graph and would drift.

## Open questions and risks

- Does `/new` reuse the conversationId, and does `Submission` accept a source tag?
- Should `/stop` also cancel jobs when no foreground turn is active, to match user expectation?
- Is the batch-level single completion acceptable, or do users want per-job partial updates for long fanouts?
- What headroom pod count should we reserve for debug pods?
- Does a job's `Tx` claim contend with the main SQLite writer under load?
- Is the root prompt reliable at multi-step follow-on without a dedicated orchestrator? This is the main risk of A versus B.

## Next implementation step

Extract the delegate execute body in `src/agents.ts` into `runWorker(binding, task, ctx)`, then write `src/jobs.ts` with `start_jobs` creating background job tasks. Keep the old delegate as a replay-only shim.
