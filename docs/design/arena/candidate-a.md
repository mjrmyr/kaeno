# Kaeno: critical review and replacement minimal architecture

## Critical review of `docs/design/minimal-kaeno.md`

The design identifies the right user-facing roles, but it treats “a persistent Pi session plus a task log” as if that were a durable workflow. Those are different guarantees. The installed SDK documentation (`.../pi-coding-agent/docs/sdk.md`) says Pi persists conversation history and can reopen sessions; it does **not** establish that an interrupted tool execution or subagent run resumes exactly where it stopped. No Pi Durable implementation or contract is available here. The proposed restart step, “resume tasks in queued, running, or waiting,” therefore hides the hardest part of the design.

Concrete failures follow:

- **Delegation may block the contact.** If `delegate` awaits a subagent’s `prompt()`, the contact cannot finish its tool call until the work finishes. Pi’s `prompt()` resolves after a run, not after launch. Delegation must durably enqueue work and return a task ID promptly.
- **Retry can create duplicate tasks.** A process can commit a task and die before Pi records the delegate tool result. A replayed call needs an idempotency key derived from the originating contact session and tool-call ID, not a fresh task ID.
- **Two stores cannot commit atomically.** `tasks.jsonl` and Pi session JSONL can disagree after a crash. “Startup is idempotent” does not resolve missing tool results, lost session pointers, or a completed task whose contact notification was interrupted.
- **“Completion event” has no delivery contract.** A subagent result must remain pending until Kaeno has attempted delivery to the single contact session. Retries must not produce multiple user-visible completion cards or cause the contact to mistake a repeated notice for a second task.
- **The contact has no single-writer policy.** User messages, completion notices, and orchestration follow-ups could all prompt the same session concurrently. The SDK explicitly requires a steering or follow-up choice when a session is already streaming; those choices also have different timing.
- **`AgentSpec.tools` overstates safety.** `tools: [read, bash, grep]` is not read-only: `bash` can write files or reach the network. Pi tools and extensions have the process’s OS permissions. A prompt forbidding writes is not a sandbox.
- **Concurrent “coder” agents could overwrite one another.** Per-agent concurrency limits do not serialize writes to shared files. Cancellation, task deadlines, queue bounds, and crash policy are also unspecified.
- **Configuration can drift mid-task.** Reloading an agent name after a restart might silently change the model, tools, or instructions of an existing task.
- **The API conflates intake with completion.** `sendUserMessage(): Promise<void>` does not say when the user gets an acknowledgment, a streamed contact reply, or a final delegated answer. “Always-present” must be tested end to end, not left to a system prompt.

An extra append-only event log is not needed for this first pass: it creates another replay and consistency question without owning an essential state transition.

## Architectural choice

Two substantially different shapes are plausible.

1. **Pi-session-led orchestration.** Make the contact transcript and extension entries the workflow ledger; reconstruct outstanding delegate calls from session history. This minimizes application storage, but branch changes and compaction distinguish model context from raw history, and contact, worker, and tool-result persistence remain separate. It also makes workflow scheduling depend on an undocumented interrupted-tool recovery contract. Reject this for the MVP.
2. **Application task-led supervisor, with Pi for conversations.** Keep one small transactional task ledger outside Pi. The supervisor owns admission, idempotency, worker scheduling, and completion delivery; Pi owns contact and worker transcripts. This is the choice. It deliberately does **not** claim atomicity between the ledger and Pi sessions.

Pi Durable is the **intended execution substrate**, not a capability this review can assert exists. Define a narrow execution boundary so a verified Pi Durable facility can later own worker attempts or task scheduling. Before claiming “durable autonomous execution,” inspect its actual API and recovery semantics. Do not build a second scheduler beside it if it already provides the required ledger and leases.

### Facts, requirements, assumptions, and blockers

**Documented Pi facts:** SDK sessions can use persistent `SessionManager` files and reopen a specified file; `prompt()` awaits a run; `steer()` and `followUp()` queue at different boundaries; `agent_settled` marks when Pi will not automatically continue. Tool calls have IDs, and custom tools receive a tool-call ID. Pi session files are branching JSONL transcripts, not a cross-store transaction manager.

**Product requirements:** one recognizable `kaeno` contact, prompt acknowledgment of delegation, independently progressing specialists, user conversation during their work, a configurable agent directory, and understandable recovery.

**MVP assumptions:** one host process owns a given state directory; SQLite is available; workers initially perform read-only analysis; the host can reopen its recorded contact session. These are choices to validate, not Pi Durable facts.

**Integration blockers:** verify Pi Durable’s task identity, checkpoint, retry, cancellation, and side-effect contracts. Verify the installed Pi version’s behavior when reopening a session whose assistant tool call has no persisted tool result. Until then, recovery may report an interrupted contact turn and start a new one; it must not promise seamless replay.

## Replacement minimal architecture

### Usage first

The user talks only to `kaeno`. For a separable request, the contact calls `delegate` and receives **“Accepted: task T…”** once task creation commits. The contact can immediately tell the user what was delegated and continue the conversation. A task-status view shows queued, running, completed, failed, cancelled, or **needs review** work without waiting for the contact model. When a worker finishes, a completion notice enters the contact’s inbox; the contact summarizes it on its next available turn. The UI may display task progress directly, but workers never impersonate the contact.

`sendUserMessage` should acknowledge **intake** separately from streamed contact output and task completion. Intake and status remain responsive while workers run. This is not a hard real-time guarantee: a stuck provider or long contact turn can delay a model-authored answer. Put deadlines on contact turns, expose that delay honestly, and let the user inspect tasks or cancel without waiting for the model.

### Ownership and minimal modules

- **App/transport:** accepts user messages and emits intake, contact-output, and task-status events. It owns process startup and shutdown, not model reasoning.
- **Contact actor:** the *only writer* to the one contact Pi session. It serializes user input and inbox delivery; no worker prompts, secondary “contact” clone, or background notifier writes that session. Its model toolset initially contains only `delegate` and task-status tools, plus any specifically justified reading tools.
- **Supervisor:** validates delegation, admits bounded work, runs attempts, handles cancellation and reconciliation. Worker sessions are separate Pi sessions.
- **Directory loader:** validates declarative specialist specs and produces immutable execution snapshots.
- **State store:** one SQLite database with a task table, a completion-inbox table, and a small singleton record holding the contact session reference. Transactions cover admission and task-result/inbox creation. No second app event log; status views derive from these records.
- **Execution adapter:** a small boundary around starting/observing a worker Pi session. Its eventual Pi Durable implementation is conditional on the missing contract. Do not describe an unverified Durable method as though it were an SDK API.

Pi’s session files remain necessary: they are the contact and worker conversation records. The SQLite ledger is necessary because tasks and pending delivery outlive any one conversation turn. The contact-session reference is necessary to avoid accidentally opening “most recent” as a different contact after restart.

### Illustrative application types

These are **Kaeno-owned contracts**, not claimed Pi or Pi Durable APIs:

```ts
type Origin =
  | { kind: "contact-tool"; contactSessionId: string; toolCallId: string }
  | { kind: "client"; clientRequestKey: string };

type TaskState =
  | "queued" | "running" | "succeeded" | "failed"
  | "cancelled" | "needs_review";

type AgentSnapshot = {
  name: string;
  revision: string;          // digest of validated execution config
  instructions: string;
  model?: string;
  thinkingLevel?: string;
  allowedTools: string[];
  workspaceMode: "read-only";
};

type Task = {
  id: string;
  origin: Origin;
  requestHash: string;
  objective: string;
  agent: AgentSnapshot;
  state: TaskState;
  attempt: number;
  workerSessionFile?: string;
  result?: { summary: string; artifactRefs: string[] };
};

type Completion = {
  taskId: string;             // unique inbox key
  outcome: "succeeded" | "failed" | "cancelled" | "needs_review";
  summary: string;
  deliveryState: "pending" | "attempted" | "acknowledged";
};
```

The exact serialized schema needs versioning and bounded field sizes. A tool-origin uniqueness constraint covers `(contactSessionId, toolCallId)`; compare the stored request hash on conflict and fail visibly if arguments differ. Direct client delegation requires a caller-supplied idempotency key. Neither path silently creates a second task.

### Normal runtime flow

1. Validate the chosen agent, objective size, capacity, and policy. Copy its validated config into the task. In one database transaction, insert-or-find by origin and return the same task ID. The `delegate` tool performs **no worker run** before returning.
2. The contact receives the task ID as its tool result and can respond to the user. The supervisor independently picks queued tasks, subject to a small global limit, a per-agent limit, deadlines, and a bounded queue.
3. Start a separate worker session with the captured snapshot and bounded task context. Persist the session reference when known. An SDK run reaching `agent_settled` means automatic continuation stopped; it is not, by itself, proof of a valid result. Validate the worker’s final deliverable or record failure.
4. Atomically commit the terminal task state and one inbox row keyed by task ID. The contact actor reads pending completions and, when safe for its single session, supplies concise notices including task IDs. If already streaming, it uses the documented steer/follow-up behavior rather than an unqualified concurrent `prompt()`. The actor decides whether to summarize now or perform further delegation.
5. The UI deduplicates status and completion displays by task ID. Mark inbox delivery acknowledged only after the chosen contact-consumption checkpoint is observable; retry otherwise.

There is no atomic transaction between SQLite and a Pi session file. A crash after contact notification but before inbox acknowledgment can put a repeated notice into the transcript. Include the stable task ID, consult any observable persisted receipt on restart, and instruct the contact to ignore a repeated completion for an already handled task. Claim **at-least-once attempted notification with deduplication**, not exactly-once model consumption. If Pi exposes no reliable receipt checkpoint, retain the pending record and make this limitation visible.

### Restart, uncertainty, and cancellation

On startup, acquire an exclusive state-directory owner lock, open the recorded contact session, load tasks, and reconcile **before** dispatch. A committed queued task can be scheduled. A task marked running at process death is an interrupted *attempt*, not evidence that its provider call or tools stopped. Reopen its worker transcript for diagnosis. For read-only workers, a fresh attempt may be allowed under a retry and cost budget; label it a new attempt, not a resumed computation. If side effects may have occurred, move to `needs_review` rather than blindly rerun.

Reconcile delegate calls against the persisted contact branch where possible. A call committed in SQLite but lacking its Pi tool result still maps to the existing task by tool-call identity; never make another task for it. A persisted call with no committed task is a harder gap: creation from its validated arguments is possible only if the recovered call’s identity and branch are reliable. Do not fabricate a Pi tool-result entry or assume the SDK will continue an incomplete turn. Surface the task through status/inbox and flag the contact turn for repair if needed. A call that never persisted in either store cannot be reconstructed.

Cancellation prevents a queued start and requests abort of an active worker. It is not rollback: a network request, file write, or provider charge may already have happened. Record cancellation intent and terminal outcome distinctly enough to report uncertainty. Enforce worker time limits, maximum attempts, queue length, context/result sizes, and shutdown grace periods. Avoid unbounded automatic retries or notifications.

### Directory and workspace policy

Use one JSON file per agent in a configured directory for the first implementation; JSON needs no additional parser. Validate unique stable names, supported model references, instructions, tool names, capacity, and workspace mode at startup. A bad spec fails startup with its path. New tasks snapshot the current validated spec and digest; edits affect only future tasks. A deliberate reload must validate the whole directory before replacing the live catalog. Store the snapshot with each task so restart cannot reinterpret an old task using a new `researcher` definition.

Initial workers get only explicit read-oriented tools such as `read`, `grep`, `find`, and `ls`; no `bash`, write tools, or unreviewed extensions. Tool selection reduces accidental actions but is **not a security boundary**: Pi extensions and enabled tools run with the host’s OS privileges. For genuinely untrusted work, a separately permissioned process or sandbox and restricted credentials are required. No concurrent workspace-writing workers in this MVP. A later writing mode needs isolated worktrees or equivalent per-task workspaces, explicit review and merge, and conflict handling—not merely `maxConcurrentTasks`.

### Non-goals and tests

No DAG planner, distributed queue, automatic merges, arbitrary shell-capable specialists, exactly-once external side effects, or transparent continuation of an interrupted model call. No claim of a working Pi Durable integration until its contracts are inspected and exercised.

Test the user-facing contract as well as database transitions:

- A delegate call returns a committed task ID promptly while a slow worker runs; the user can ask another question and inspect status.
- Concurrent user input and multiple completions produce one serialized contact transcript, not overlapping prompts.
- Repeat the same tool-call identity with identical and changed arguments; obtain respectively the same task and an explicit conflict.
- Kill the process before task commit, after commit/before tool result, during a worker, after terminal commit, and after notification/before acknowledgment. Check recovered status and duplicate handling in each case.
- Change or remove an agent spec while its task runs; the recorded snapshot still governs that task.
- Hit per-agent/global capacity, queue and time limits; cancel queued and running work; report uncertain effects rather than claiming rollback.
- Attempt a worker write and an extension-enabled bypass; verify the *actual* isolation policy, not just the prompt. Keep multiple writing workers disabled.
- Restart with an incomplete contact tool turn. Record precisely what the installed Pi version can reopen and what requires user-visible repair.

**Rationale:** a task-led supervisor is a small, inspectable owner for delegation while Pi retains ownership of conversations. It protects the one contact from worker latency without pretending that session persistence equals workflow durability.

**Highest-risk unanswered questions:** What does Pi Durable actually guarantee and expose? Can this Pi version safely recover an incomplete contact tool call? What acknowledgment of contact consumption can be observed after a crash? Which future specialist side effects can be made idempotent—or must require human review?
