# Candidate B: a coordinator with isolated job workers

**Proposed architecture only.** No commands, runtime, frontend adaptation, or deployment described below are implemented. The repository currently contains an architecture scaffold. No files were edited.

## Usage first

Run from the Kaeno repository on the MacBook:

```sh
# Proposed convenience command: start a persistent local owner and attach Pi chat.
./bin/kaeno local --workspace . --state .kaeno

# Equivalent explicit launches, in separate terminals.
./bin/kaeno serve --workers local --workspace . --state .kaeno
./bin/kaeno chat --endpoint unix:.kaeno/control.sock

# Explicit owner shutdown; quitting chat only detaches.
./bin/kaeno stop --endpoint unix:.kaeno/control.sock --mode drain
```

Later, on a self-managed Linux host:

```sh
# Proposed service launch, after separately provisioning its configuration/storage.
./bin/kaeno serve --workers k3s --config kaeno/server.json \
  --state /var/lib/kaeno

# Each device attaches to that same owner.
./bin/kaeno chat --endpoint https://kaeno.example.net

# Explicitly cancel admitted work before stopping the owner.
./bin/kaeno stop --endpoint https://kaeno.example.net --mode cancel
```

`local` starts an owner process independently of the terminal client. Reopening chat attaches to it. The future server configuration selects a registered immutable workspace, cluster, and pinned worker image; it does not contain a Mac workspace path.

Three intended API call sites:

```ts
import { startService, connectClient } from "kaeno";

// 1. Local owner bootstrap.
const owner = await startService({
  stateDir: ".kaeno",
  configFile: "kaeno/local.json",
  placement: { kind: "local", workspacePath: process.cwd() },
});

// 2. A device client; it never opens Durable storage.
const client = await connectClient({
  endpoint: owner.endpoint,
  clientId: "macbook",
});
const unwatch = await client.watch(snapshot => piChat.present(snapshot));
const receipt = await client.send({
  requestId: "message-42",
  text: "Ask reviewer to assess src/auth.ts.",
});
const answer = await client.answer(receipt.id);

// 3. Targeted cancellation and distinct lifetimes.
const job = (await client.snapshot()).jobs.find(j => j.result === null);
if (job) await client.cancel({ kind: "job", id: job.id });
await unwatch();
await client.detach();       // Work continues.
await owner.stop("drain");   // Waits for admitted work and closes storage.
```

`piChat` is the adapted existing Pi frontend described below. Admission, answering, worker completion, and human receipt remain separate events.

## Grounded constraints

The installed Pi coding-agent is **1.1.0**. Its `InteractiveMode` constructor (installed `@earendil-works/pi-coding-agent` 1.1.0 `dist/modes/interactive/interactive-mode.d.ts`) requires `AgentSessionRuntime`; its implementation directly accesses the session, agent, settings, and `SessionManager`. Its footer and compaction rendering also depend on session context. Therefore this proposal requires frontend source adaptation. Stock `InteractiveMode` cannot accept a Durable backend.

Durable was inspected at commit `6fb2e7815167e6b19006fc526d1a5d0f5f998787`. [`HarnessOptions`](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/durable/src/harness/types.ts) has no remote task executor. Generation calls `runtime.models.streamSimple` inside its Harness process. `ExecutionEnv` supplies filesystem and shell capabilities. Native ownership, abort traversal, and `completing` cover that Harness’s records and invocations.

Durable storage requires one process owner. Its SQLite WAL/NORMAL configuration supports process-crash recovery, with possible newest-commit loss after host or power failure. These constraints apply separately to every proposed store.

## Ownership and modules

The coordinator owns the continuing contact conversation, delegation intent, capacity, accepted results, and notice policy. Each specialist assignment owns a separate worker Harness and store. **Native parent-child ownership stops at the process boundary.**

```text
Native ownership                         Application relationship

Coordinator Harness / coordinator.sqlite
└─ contact conversation
   ├─ contact generation → delegate tool
   └─ background Job task ─────────────── execution protocol ─────┐
                                                               │
Worker Harness / job-specific worker.sqlite ◀───────────────────┘
└─ fresh worker root conversation
   └─ worker generations and read tools
```

```text
Local                                      Future server

MacBook                                    Fixed service host
├─ Pi chat client                          ├─ coordinator + local persistent disk
├─ persistent coordinator                  ├─ authenticated client endpoint
└─ fresh subprocess per assignment         └─ k3s API → fresh Pod per assignment
   ├─ private workspace                       ├─ entire worker Harness/runtime
   └─ private worker store                    ├─ materialized workspace
                                              └─ private persistent worker volume

Multiple device clients ───────────────────────→ same coordinator
```

```text
src/host.ts       owner guard, admission, client endpoint, snapshots, shutdown
src/jobs.ts       profiles, immutable intent, capacity, reconciliation, notices
src/placement.ts  process/k3s identity, adoption, launch and termination evidence
src/worker.ts     private Harness/store, recovery, cancellation, sealed results
src/chat.ts       domain-to-Pi presentation adaptation
vendor/pi-chat/  pinned actual Pi interactive frontend and retained dependencies
```

Package exports expose the domain client and owner handles. Durable, Kubernetes, transport, and storage types stay private. `placement.ts` earns its boundary by interpreting resource identity and termination evidence; it is not a generic executor framework.

## Type and signature sketch

These are proposed contracts, not a complete compilable package.

```ts
type Id<K extends string> = string & { readonly identity: K };
type JobId = Id<"job">;
type ExecutionId = Id<"execution">;
type ReceiptId = Id<"receipt">;
type Digest = Id<"digest">;
type ResourceId = Id<"resource">;
type BootId = Id<"boot">;
type ArtifactId = Id<"artifact">;

type WorkspaceRef = Readonly<{
  digest: Digest;
  subdirectory: string;
}>;

type Artifact = Readonly<{
  id: ArtifactId;
  name: string;
  digest: Digest;
  bytes: number;
}>;

type Result =
  | { kind: "succeeded"; summary: string; artifacts: readonly Artifact[] }
  | { kind: "failed"; reason: string; artifacts: readonly Artifact[] }
  | { kind: "cancelled"; artifacts: readonly Artifact[] }
  | { kind: "outcome_unknown"; reason: string; artifacts: readonly Artifact[] };

type Notice =
  | { kind: "pending" }
  | {
      kind: "admitted";
      receipt: ReceiptId;
      disposition: "queued" | "processing" | "answered" | "unanswered";
    }
  | { kind: "deferred"; reason: string };

type ChatPart =
  | { kind: "text" | "thinking"; text: string }
  | { kind: "tool_call"; callId: string; name: string; argumentsText: string }
  | { kind: "compaction"; summary: string };

type ChatMessage = Readonly<{
  id: string;
  role: "user" | "assistant" | "tool";
  parts: readonly ChatPart[];
  state: "streaming" | "complete" | "interrupted";
}>;

type ToolView = Readonly<{
  callId: string;
  name: string;
  argumentsText: string;
  state: "running" | "succeeded" | "failed" | "cancelled";
  output: string;
  omittedCharacters: number;
}>;

type Receipt = Readonly<{ id: ReceiptId; order: number }>;
type Answer =
  | { kind: "answered"; text: string }
  | { kind: "unanswered"; reason: string };

type JobView = Readonly<{
  id: JobId;
  specialist: string;
  objective: string;
  execution: "starting" | "running" | "uncertain" | "cancelling" | "settled";
  result: Result | null;
  notice: Notice | null;
}>;

type Snapshot = Readonly<{
  revision: { incarnation: string; sequence: number };
  messages: readonly ChatMessage[];
  tools: readonly ToolView[];
  queue: readonly { receipt: Receipt; text: string }[];
  jobs: readonly JobView[];
  specialists: readonly { name: string; description: string }[];
  contact: {
    state: "idle" | "working" | "retrying" | "compacting";
    activeInput: ReceiptId | null;
    modelLabel: string;
    workspaceLabel: string;
    inputTokens: number;
    outputTokens: number;
    contextTokens: number | null;
  };
}>;

type CancelTarget =
  | { kind: "input"; id: ReceiptId }
  | { kind: "job"; id: JobId };

interface Client {
  send(input: { requestId: string; text: string }): Promise<Receipt>;
  answer(id: ReceiptId): Promise<Answer>;
  snapshot(): Promise<Snapshot>;
  watch(listener: (view: Snapshot) => void | Promise<void>):
    Promise<() => Promise<void>>;
  cancel(target: CancelTarget):
    Promise<{ kind: "requested" | "already_settled" }>;
  detach(): Promise<void>;
}

type ServiceOptions = Readonly<{
  stateDir: string;
  configFile: string;
}> & (
  | { placement: { kind: "local"; workspacePath: string } }
  | {
      placement: {
        kind: "k3s";
        cluster: string;
        imageDigest: string;
        workspace: WorkspaceRef;
      };
    }
);

interface ServiceOwner {
  readonly endpoint: string;
  stop(mode: "drain" | "cancel"): Promise<void>;
}

export async function startService(
  _options: ServiceOptions,
): Promise<ServiceOwner> {
  // TODO: guard → open paused → validate → reconcile → resume → serve.
  throw new Error("not implemented");
}

export async function connectClient(
  _options: { endpoint: string; clientId: string },
): Promise<Client> {
  throw new Error("not implemented");
}
```

The following contracts are private to coordinator/worker integration:

```ts
type WorkerSpec = Readonly<{
  job: JobId;
  execution: ExecutionId;
  specDigest: Digest;
  workspace: WorkspaceRef;
  profile: {
    model: { provider: string; modelId: string };
    thinking: "off" | "low" | "medium" | "high";
    instructions: string;
    tools: readonly "read"[];
    runtimeDigest: Digest;
  };
  deadlineAt: number;
}>;

type Bootstrap = Readonly<{
  spec: WorkerSpec;
  resource: ResourceId;
  boot: BootId;
}>;

// Opaque values minted only after boundary verification.
type WorkerAuthority = Id<"worker-authority">;
type QuiescenceProof = Id<"quiescence-proof">;

type Obligation =
  | {
      kind: "held";
      claimGate: "open" | "closed";
      binding: ResourceId | null;
      authorizedBoot: BootId | null;
      cancelRevision: number;
    }
  | { kind: "quiescent"; proof: QuiescenceProof };

type Seal = Readonly<{
  execution: ExecutionId;
  resource: ResourceId;
  specDigest: Digest;
  digest: Digest;
  observedCancelRevision: number;
  result: Result;
}>;

interface WorkerLink {
  claim(boot: Bootstrap): Promise<
    | { kind: "granted"; authority: WorkerAuthority }
    | { kind: "denied"; reason: string }
  >;
  control(execution: ExecutionId): Promise<{ cancelRevision: number }>;
  stage(seal: Seal): Promise<"staged" | "accepted">;
}

async function runWorker(
  _boot: Bootstrap,
  _link: WorkerLink,
): Promise<void> {
  // TODO: guard private store; claim; inspect sealed state before scheduling;
  // recover permitted read-only work; seal; transfer; exit.
  throw new Error("not implemented");
}
```

An indexed coordinator record binds the delegation origin, native Job ID, execution identity, obligation, and result/notice decision. Immutable assignment configuration lives in native Job input; worker storage receives its verified bootstrap copy.

## Execution, restart, and cancellation protocol

**1. Creation is one coordinator transaction.** The `delegate` tool normalizes objective/brief and looks up its native tool-task origin before consulting the current catalog. Same origin and request hash returns the existing job; conflicting arguments reject.

For new intent, read capacity and retention records before table writes, freeze the effective profile/workspace/runtime identities, create a root-owned background Job, and record its execution binding. There is no subprocess launch, network call, inference, or worker submission inside this tool. Safe replay therefore recovers an existing assignment after a crash before the tool result commits.

**2. Persist intent before launching.** One execution ID denotes that assignment’s worker lifecycle. Its spec digest covers all effective inputs, runtime/image identity, workspace provenance, capabilities, and recovery policy.

Local identity combines a persisted execution nonce, worker registration, process birth identity, and process-group identity. A PID alone is insufficient. Future placement uses deterministic Pod/PVC names plus their actual UIDs. Existing objects must match the protected manifest, not merely an annotation containing its hash.

A lost launch response means “may exist.” Restart probes and adopts before creating. Same name with another UID, missing previously bound storage, or incompatible manifest stops automatic execution and requires reconciliation. Pod names can be reused with different UIDs, so names are discovery keys rather than execution proof. [Kubernetes Pod lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)

**3. Startup requires a durable claim.** Bootstrap workers acquire their private store’s process-lifetime guard, then register execution/resource/boot identity. The coordinator verifies placement and commits authorization before returning runnable configuration and provider access. Workers have no ambient provider credentials.

Cancellation closes the claim gate permanently. A delayed launch arriving afterward cannot start the agent, even if an earlier create request remained in flight. Conversely, a committed grant whose response was lost is treated as potentially running.

A newer coordinator incarnation fences stale callbacks and connections; it does not revoke an already running worker by assertion.

**4. The worker owns execution context.** It opens its own Harness paused, validates immutable identity and executable compatibility, and creates or reacquires its fresh root conversation. Objective/brief submission uses a stable execution-derived request ID. All specialist generation, model access, read tools, transcript, and checkpoints run in that subprocess or Pod.

Existing sealed state is retransferred without inference. Otherwise confirmed-dead worker recovery may resume **read-only** execution from the same store. Native generation recovery can resend a provider request: repeated inference and billing are accepted limits.

For k3s, the proposed bare Pod uses `OnFailure` container recovery with retained storage. A new boot is authorized only after verifying the preceding boot has terminated and the store guard is available. Missing or replaced Pods are not automatically recreated to rerun the assignment. Writable tools, recursive delegation, and unsafe-effect recovery remain gated.

**5. Result handoff is deliberately non-atomic.** After worker settlement and ordinary idle, the worker commits an immutable terminal seal/outbox record. Artifact files are finalized and hashed before inclusion.

Transfer uploads bounded immutable artifacts and a digest-addressed manifest. The coordinator acknowledges staging only after files are durably finalized and verified. Its native Job then commits the accepted result card, pending notice, and report checkpoint together.

Crash after upload but before that commit leaves recoverable staged files. Crash after acceptance but before acknowledgment converges on the same digest. Conflicting seals are rejected. Worker state is not deleted on a staging acknowledgment.

A terminal/faulted native Job cannot prevent exceptional reconciliation: `jobs.ts` remains responsible for importing retained evidence or recording an unknown result, resolving notice disposition, and stopping remote work.

**6. Cancellation acknowledges intent.** Job cancellation commits the closed gate and monotonic cancel revision, then marks the coordinator Job for abort. Its abort handler runs the explicit remote stop protocol; native bottom-up abort cannot reach the worker.

The worker observes cancellation, aborts its own ordinary scope, drains, seals evidence, and exits. Existing success evidence survives cancellation. Abrupt termination without trustworthy settlement can produce `outcome_unknown`.

Graceful stop can escalate to local process-group termination or Pod termination. Termination acknowledgment, heartbeat expiry, coordinator task completion, and Pod disappearance are insufficient proof of remote drainage. Force deletion can leave processes running. [Kubernetes delete semantics](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_delete/)

A partitioned node retains the obligation until trusted termination evidence or explicit node fencing establishes quiescence. No replacement overlaps an uncertain authorized worker.

**7. Capacity follows both owners.** Admission scans the bounded index transactionally. A job consumes global/per-specialist capacity while its native Job is nonterminal **or** its external obligation remains held. Thus reporting, aborting, completing, uncertain launches, and coordinator faults remain charged.

For an execution never authorized, permanently closing its claim gate proves no future bootstrap can run the agent. Late bootstrap resources are separately cleaned up. Application capacity bounds authorized specialist execution; namespace resource quotas additionally bound inert or orphaned Pods.

**8. One automatic notice attempt.** The report phase uses `notice/<job-id>` for one logical contact follow-up and never waits for narration. Replay reacquires that same submission. Stored notice references project native queued/processing/answered/unanswered state.

Cancellation before admission may defer the notice. Exceptional terminal reconciliation looks up the stable notice ID; absent admission becomes deferred. It does not redeliver. Results remain inspectable independently of narration.

**9. Retention precedes cleanup.** Coordinator cards reference verified artifact copies, never worker-local paths. Results, artifacts, execution tombstones, and origin mappings remain retained. Initially the retained-job limit rejects further delegation instead of silently evicting evidence.

Worker stores remain available for recovery or diagnosis until explicit archival policy exists. Pod/process cleanup requires quiescence; storage cleanup additionally requires accepted results and complete artifact retention. Unknown outcomes retain forensic storage. Late evidence after final settlement is retained as evidence without silently rewriting the final card or triggering another notice.

## Workspace materialization

`--workspace .` is an ingestion boundary. It captures a bounded immutable source snapshot and records provenance: repository revision, included local changes, content digest, and relative subdirectory. Initial defaults include tracked files and their modifications; untracked files require explicit inclusion. State directories and credential material are excluded.

Each worker materializes that snapshot into its own workspace. The worker receives `WorkspaceRef`, and its runtime resolves a container-local directory such as `/workspace/project`. Profile paths become relative paths within that materialization.

Future server ingestion can fetch an approved repository at an immutable commit or accept a verified snapshot upload. Fetch credentials stay with provisioning; worker provider access is separately scoped. Outputs transfer back as artifacts. Applying changes to the user’s repository is a later serialized review/apply feature.

K3s includes local-path persistent storage, but it does not provide cross-node availability for this design. Worker storage and recovery placement must respect the actual volume’s node. [K3s storage documentation](https://docs.k3s.io/add-ons/storage)

## Actual Pi frontend reuse and clients

Vendor the pinned **existing interactive frontend**, preserving its chat orchestration, editor, transcript/tool components, renderer, themes, viewport, and keyboard machinery. Adapt session-dependent seams in that code: submissions, subscriptions, footer data, transcript reconstruction, cancellation, commands, and shutdown. Preserve source provenance and reviewable upstream diffs.

This is an extraction/fork of the actual frontend, not a clean-room composition of Pi widgets. Prefer an upstream backend-interface extraction if available. Do not construct a dummy `AgentSession`, use `SessionManager` as a presentation cache, cast a facade to those types, patch the installed package, or route through stock Pi RPC.

Initial support includes multiline editing, history, paste, Markdown/thinking rendering, tool progress/output, resizing, themes, queued input display, job inspection, and contact-turn cancellation. Footer information comes from domain state; unavailable usage remains explicitly unknown.

Gate session/tree/fork/new/resume/import commands, local bash, model/login changes, extensions/MCP discovery, file expansion, image attachments, and manual compaction until supported domain behavior exists. Busy input initially uses durable follow-ups; steering shortcuts are gated. Quit detaches. Escape targets the input receipt shown by the current view, so retrying cancellation cannot abort a later unrelated turn.

Durable’s [`watchEvents`](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/durable/src/harness/events.ts) provides committed initial state and batches, but its deltas differ from coding-agent events. The adapter reconstructs stable message/tool identities and translates them into presentation state. A reconnect or overflow replaces the entire current view, including partial messages, tool windows, queue, and jobs. Deltas are disposable.

Each authenticated device has a stable client ID. Message IDs are persisted before sending and namespaced by principal/device. Native submission identity supplies durable deduplication and admission order; retries return the original receipt. The initial contract preserves Durable’s same-type, first-submission-wins behavior for changed text under the same ID. It does not promise conflict rejection for client text.

Use one-at-a-time follow-ups and native FIFO, including interleaved notices. Admission order is not wall-clock order across devices or a latency guarantee. Clients neither open SQLite nor trigger work from observation. Slow consumers receive replacement snapshots; watch shutdown drains current callbacks.

The service acquires an OS process-lifetime guard **before** opening its coordinator store. Future operation uses a fixed service host and local persistent disk, with no automatic cross-node failover or multiwriter network SQLite. A replica count or timed Kubernetes lease alone does not establish exclusive ownership.

Drain shutdown closes external admission, completes admitted work/notices, joins native invocations, and closes storage before releasing ownership. Cancel shutdown durably cancels admitted work first. Either may wait indefinitely on unresolved remote execution. Hard owner death leaves persisted obligations for its replacement to adopt.

## One-page rationale

**Problem.** Whole specialist execution must eventually live in fresh Pods, while the existing Pi frontend becomes a client of one persistent contact owner. Durable’s native ownership is valuable but process-local; extending its old child-conversation diagram across that boundary would invent guarantees.

**Shape.** Preserve Durable inside each execution owner and add one explicit assignment protocol between owners. Foundational thinking isolates mutable worker context. Boundary discipline keeps framework objects private. Idempotent operations provide origin deduplication, resource adoption, immutable result transfer, and stable notice admission. The client surface hides these mechanics behind six operations.

**Synthesis decision.** This candidate selects the explicit worker boundary. It retains the old design’s creation-only delegation, immutable profiles, background contact independence, bounded retention, and folded notice policy. Arena synthesis remains the orchestrator’s decision.

**Changes to old decisions.**

| Old decision | Proposed replacement |
|---|---|
| One Harness/store for everything | One coordinator plus one isolated Harness/store per job |
| Native task-owned worker child | Separate worker root; application protocol owns the relationship |
| Native nonterminal tasks determine capacity | Native lifetime plus unresolved external obligation |
| Absolute specialist `cwd` | Immutable workspace provenance and private materialization |
| Text-only snapshots | Structured committed chat/tool/presentation state |
| Facade close controls application lifetime | Client detach and explicit owner stop |

**Tradeoffs accepted.** We accept isolated-store handoff and conservative capacity retention in exchange for honest process placement and recovery. We accept repeated read-only inference in exchange for recoverable checkpoints. We accept a pinned frontend fork and capability gates in exchange for actual Pi reuse.

**Competing whole shapes.** A single central Harness with remote `ExecutionEnv` has the deepest native ownership interface and fewer stores, but leaves the subagent orchestration on the coordinator; it fails the placement requirement. A single Harness with a new distributed scheduler/storage executor could preserve native ownership conceptually, but would require changing Durable’s scheduling and fencing model substantially. It exposes less to Kaeno callers while placing far more machinery beneath them. Separate owners are the smaller honest commitment.

**Open questions and risks.** Can the pinned frontend be separated without retaining session authority? What termination evidence can the selected runtime reliably provide? Will writable specialists justify a different recovery protocol? These are implementation gates; read-only workers and fixed-host ownership are the initial answers.

**Next implementation step.** Prove actual Pi frontend extraction against a faux Durable backend before building execution placement.

## Stages, verification gates, and limits

1. **Frontend gate:** run the adapted actual Pi frontend in a PTY against faux committed state. Exercise streaming, tool trims, compaction replacement, resizing, paste, queueing, Escape, and reconnect. Assert zero normal agent/session creation. If extraction cannot pass, revise the design rather than substitute a lookalike.
2. **Local slice:** implement read-only subprocess workers, private stores, claims, handoff, retention, and owner guard.
3. **Persistent clients:** add authenticated attachment, durable request retries, snapshots, and explicit shutdown.
4. **Future k3s slice:** prove fresh Pod placement, PVC adoption/recovery, scoped bootstrap, output transfer, and termination evidence. This is a commitment, not existing functionality.

Required crash tests:

- Kill after delegation commit but before tool receipt: exactly one job; catalog removal does not lose it.
- Lose Pod-create response: adopt matching UID/manifest; reject incompatible identity.
- Kill after claim commit but before reply: capacity stays held; no overlapping authorized boot.
- Cancel during an unresolved launch: delayed bootstrap cannot invoke a model.
- Kill a read-only worker mid-generation: recover its store/request; permit repeated provider calls explicitly.
- Kill at seal, partial upload, staging, import, and acknowledgment: one accepted card; retained artifacts survive cleanup.
- Fault the coordinator Job or partition/force-delete its worker: no premature capacity release.
- Retry device input, overflow observation, and detach all clients: stable receipts/order and continuing work.
- Start a second owner: reject before opening storage; stale callbacks cannot write after restart.

These tests were **not executed**. Existing same-process native probes do not verify this architecture. Explicit limits include no HA takeover, exactly-once provider calls or external effects, writable workers, automatic Pod replacement after uncertainty, automatic archival, reliable human notification, or newest-commit survival after power loss.