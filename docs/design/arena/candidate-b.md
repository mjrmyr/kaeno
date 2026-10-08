# Kaeno: critical review and replacement minimal architecture

## Critical review

`docs/design/minimal-kaeno.md` has the right instinct to make delegation explicit, but it treats persistent conversations as if they were durable work. The installed Pi SDK documents persistent session history and APIs for creating, opening, prompting, aborting, and observing sessions. It does **not** establish that an interrupted tool call or agent run can be resumed exactly where it stopped. No Pi Durable source or contract is available here. “Resume tasks in `queued`, `running`, or `waiting`” therefore risks repeating work whose outcome is unknown.

Several concrete failures follow:

- The sketch calls `await app.delegate(...)` inside the contact run, then says contact remains available. If the tool waits for the specialist, it blocks the contact. Even if it returns promptly, Pi’s `prompt()` resolves only when its run finishes; steering during a run waits until the current assistant turn and tool calls finish. Neither a persistent session nor a prompt instruction guarantees conversational availability.
- A completion event has no defined durable destination or acknowledgment. A result could be saved while contact is busy, missed on restart, or narrated twice. `tasks.jsonl`, Pi session files, and an optional event log also create multiple stores without a rule for crash gaps between them.
- “Idempotent startup” is not idempotent delegation. A tool call could create a task, crash before its Pi tool result is recorded, and be executed again. A restarted runner could similarly repeat a file edit or external request.
- The design does not say who may write the contact session. Letting runner callbacks inject messages while a user prompt runs risks ordering errors. Concurrent coder agents also cannot safely edit one workspace merely because their task records are separate.
- Directory `tools` are not an operating-system permission boundary. A prompt saying “do not modify files,” or a purportedly read-only agent with `bash`, does not enforce read-only operation. Loaded resources and extensions may add capabilities.
- Cancellation, resource limits, config changes during a task, and the meaning of `waiting` are undefined. The sample model name and skills should not be assumed valid for a particular installation.

**Facts versus requirements.** The SDK supports separate Pi sessions, configurable tools/resources, a custom tool whose execution receives a tool-call ID, persistent `SessionManager` storage, session events, and `abort()`. Its documentation says `agent_settled` is the boundary after automatic continuation, not `agent_end`. The *design requirement* is durable autonomous delegation with an available main contact. My *assumption* for the first implementation is one local process and one application owner at a time. The *integration blocker* is Pi Durable: until its execution, recovery, cancellation, and storage contracts are known, Kaeno must not advertise crash-safe continuation of an in-flight specialist run. Session persistence alone does not close that gap.

## Architectural choice

Two genuinely different shapes are plausible:

1. **Pi-native, session-led orchestration.** Make contact-session entries and extension events the task ledger; reconstruct delegation by replaying its active branch and let contact manage workers. This minimizes application storage, but workflow identity becomes entangled with branching, compaction, and the timing of tool results. Tasks must survive independently of which conversational branch is active. It also leaves contact responsible for scheduling while it is busy or offline. Reject for the MVP.
2. **Application task-led supervisor.** A small host owns task identity, queueing, limits, results, and delivery. Pi owns each conversation’s model context; contact and specialists have separate sessions. Contact decides *what* to delegate, not *how to recover it*. Choose this shape.

A remote queue and separate worker service would provide stronger isolation but add deployment and failure boundaries before the local semantics are settled. Do not start there. When Pi Durable becomes available, it should replace or back the **runner execution boundary**, not create a second competing task ledger by accident. Revisit ownership if its actual contract offers transactional workflow state.

## Usage and observable contract

A client starts Kaeno, subscribes to contact/task events, and submits a user message. Submission durably accepts the message and promptly returns a message ID; it does **not** await a model answer. The contact subsequently answers or delegates. A `delegate` tool call validates the request, commits a queued task, and promptly returns `{taskId, status: "queued"}`. It never waits for specialist completion. The user can ask another question, inspect tasks, or cancel one while specialists run.

“Always available” means the process can **accept and acknowledge input**, expose task status and its completion inbox, and queue another contact turn while workers operate. It does not promise an instantaneous model answer: the single contact session may still be generating, a provider may be slow, or its current tool call may be finishing. The client must display accepted/pending state rather than spin on `prompt()`. When Kaeno itself is stopped, this single-process MVP is unavailable; Pi session files do not change that.

A contact actor alone writes the contact Pi session. It serializes user turns and completion notifications, favors user input over unsolicited result summaries, and never lets worker callbacks call `prompt()` on contact. A completion can be shown immediately as application task status even before contact has narrated it. Keep contact tools short-running; cap turn duration and expose a clear busy/error state rather than claim a latency guarantee the SDK cannot provide.

## Ownership, storage, and interfaces

Keep four modules, not the proposed separate event log:

- **`contact/`**: one session owner and input arbiter; registers `delegate`, `list_tasks`, and `get_task`; streams responses to the client.
- **`tasks/`**: one SQLite database for accepted inputs, unique delegation intents, task attempts, statuses, results, and a completion inbox. Transactions make task creation and result-plus-inbox insertion atomic. SQLite is justified by those uniqueness and atomicity needs, not query volume.
- **`directory/`**: validates trusted local agent definitions and produces immutable per-task snapshots.
- **`runner/`**: bounded local Pi specialist sessions behind a narrow execution interface. Later, a verified Pi Durable adapter can implement that interface.

Pi session files remain a necessary **second store**, authoritative for conversation context, not for task status. No derived `events/event-log.jsonl` in the MVP; the client reads database records and live process events, and can reconnect using stable IDs. Keep database and session paths under a protected state directory.

These are Kaeno-owned conceptual types, **not claimed Pi Durable APIs**:

```ts
type DelegationKey = {
  contactSessionId: string;
  toolCallId: string;
};

type AgentSnapshot = {
  name: string;
  configHash: string;
  prompt: string;
  modelSelection?: string;
  toolAllowlist: string[];
  resolvedResourceRefs: string[];
};

type Task = {
  id: string;
  origin: DelegationKey;
  requestHash: string;
  objective: string;
  agent: AgentSnapshot;
  status: "queued" | "running" | "succeeded" |
          "failed" | "cancelled" | "outcome_unknown";
  attempt: number;
  sessionPath?: string;
  resultId?: string;
};

type Completion = {
  id: string;
  taskId: string;
  outcome: "succeeded" | "failed" | "cancelled" | "outcome_unknown";
  summary: string;
};

interface TaskRepository {
  createOnce(origin: DelegationKey, requestHash: string,
             snapshot: AgentSnapshot, objective: string): Promise<Task>;
  finishWithCompletion(taskId: string, completion: Completion): Promise<void>;
  pendingCompletions(): Promise<Completion[]>;
}

interface TaskExecutor {
  start(task: Task): Promise<void>;
  requestCancel(taskId: string): Promise<void>;
}
```

`createOnce` enforces a unique `(contactSessionId, toolCallId)`. An identical repeat returns the original task ID; the same key with different arguments is an error, not silent reuse. The SDK extension example shows a tool-call ID passed to a custom tool’s `execute`; Kaeno must verify the exact identity and persistence behavior in the installed declarations during implementation. A *new* model-generated tool-call ID after a crash can still represent the same human intent: this key prevents replay of one call, not magical semantic deduplication. Surface ambiguous cases for reconciliation.

## Runtime flow and restart semantics

On startup, acquire exclusive ownership of the local state directory/database before opening sessions or scheduling work. Load and validate the directory; open the **specific** recorded contact session, not “most recent” for the workspace. Rebuild pending user inputs, tasks, and inbox items from SQLite. Session references are explicit paths/IDs recorded by Kaeno. Failure to open the recorded contact session is a recovery error, not permission to create a fresh one silently.

For delegation, the contact tool transactionally stores a queued task with its origin key and full snapshot, then returns its ID. A scheduler respects global and per-agent limits and creates a specialist session. Persist the session binding **before its first prompt**. A crash after session creation but before binding may leave an unused session file; since no specialist prompt has begun, it must not have produced task effects. A crash after binding but during a run is different: reopening conversation history does not prove whether a command, network call, or model turn completed. Mark that attempt `outcome_unknown` on recovery unless an inspected, finalized result and the eventual Pi Durable contract justify a more precise transition. Do not blindly “resume running” or automatically retry effectful work. An authorized retry is a new numbered attempt, retaining the earlier record.

A runner writes a terminal result and its completion-inbox row in one database transaction. It never writes contact history. When contact is idle, its actor selects pending completions, includes stable completion IDs in a contact turn, and asks contact to report verified outcomes without claiming uncertain work succeeded. `agent_settled`, rather than an intermediate `agent_end`, is the point to consider the Pi turn finished. Even then, the Pi session file and SQLite cannot be committed atomically: a crash after contact records or emits an answer but before an inbox acknowledgment can cause redelivery. Keep the inbox authoritative, deliver **at least once**, use stable IDs for client deduplication, and make duplicate summaries tolerable. Acknowledgment is a delivery cursor, not deletion of the task result. Do not assert exactly-once model context or exactly-once streamed text. On reconnect, clients can fetch completed tasks independently of what contact managed to say.

Likewise, committing a task before Pi persists the delegate tool result leaves a real cross-store gap. The origin key makes re-execution of that *same* call safe when its ID is preserved; it does not repair every changed-ID replay. Recovery should present the task and its origin for inspection instead of guessing. External effects are harder still: neither a session transcript nor a local transaction proves whether an email, API mutation, or edit took effect before a crash. Require an effect-specific idempotency key/receipt or human reconciliation before enabling such work.

Cancellation marks the request in SQLite, stops queue admission, and asks an active session to abort. The SDK says `abort()` waits for idle, but cancellation is not rollback and may not stop an already-issued external effect. Bound global concurrency, per-agent concurrency, queued count, runtime, context size, and retries; report timeouts or indeterminate outcomes explicitly. Stop scheduling when the owner shuts down. Treat a second live Kaeno process as an error, not another worker.

## Directory policy and first-pass limits

Use one file per agent, with a stable name, description, prompt, optional configured model, explicit allowed tools/resources, and concurrency limit. Validate the whole directory at startup and validate the selected spec again at task creation. Snapshot the effective prompt, tool allowlist, model selection, and resolved resource identities/hash into the task; editing YAML changes **future** tasks only. A missing historical model or resource on restart becomes an actionable blocked/unknown attempt, not an implicit substitution. Start with a read-oriented specialist using only explicitly selected read/search tools; do not ship the sample `bash`-equipped “read-only” researcher as proof of a restriction.

Tool selection limits what Pi advertises to the model; it is **not sandboxing**. Pi extensions execute with process permissions, discovered resources can change behavior, and filesystem reads need not be confined to `cwd`. Restrict resource loading and trusted configuration, and use OS/container isolation before calling a worker untrusted. For this MVP, specialists do not write the shared workspace. Future writable agents need isolated worktrees plus an explicit serialized application/merge step; a task concurrency cap alone does not prevent lost edits.

Non-goals: autonomous external mutations, shared-workspace editing, multi-process scheduling, automatic retries of uncertain attempts, a DAG planner, and uninterrupted service while the host is down.

## Tests that should decide whether this works

1. Delay a specialist: delegation returns its ID promptly; a new user input is accepted, and contact eventually answers without waiting for that specialist.
2. Issue the same contact-session/tool-call key twice, including after restart: exactly one task; changed arguments under that key fail.
3. Crash after task commit but before tool-result persistence; after session creation but before binding; during an active run; and between result commit, contact narration, and inbox acknowledgment. Verify no silent lost completion or automatic repeat of uncertain effects.
4. Deliver two completions during a user turn, restart, and reconnect a client. Verify one contact-session writer, stable result IDs, fetchable task status, and tolerable redelivery.
5. Edit an agent definition while a task runs; verify its snapshot remains unchanged. Reject invalid tools/resources and attempts to start a second owner.
6. Fill queue/concurrency limits, cancel queued and active tasks, and verify timeout and unknown-outcome reporting without calling cancellation a rollback.

**Rationale.** One task database supplies the atomicity Pi conversations cannot; separate Pi sessions supply conversation context without masquerading as a workflow engine. The highest-risk unanswered questions are Pi Durable’s actual checkpoint/replay and fencing contract, the stability of Pi tool-call identity across recovery, and what isolation and idempotency policy will be required before specialists may perform real side effects.
