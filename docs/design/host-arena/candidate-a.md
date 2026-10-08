# Kaeno host design, candidate A: central store authority with whole-agent workers

## 1. Testing Direction A

**Verdict: literal Direction A puts the specialist's operations in the pod, not the specialist itself.** In that design one central Harness owns a Job-owned child conversation. The central scheduler then runs that child's `pi.generation`, which covers context assembly, prompt sections, requests, retries, classification and compaction. It also runs `pi.tool`, which covers validation, hooks, dispatch and result commits. `generation.ts` calls `runtime.models.streamSimple` in the same process. A pod could only supply `HarnessOptions.env` (an `ExecutionEnv` is just `FileSystem & Shell`) and maybe a proxied provider stream. Durable's own example 29 describes this exact setup as "an ExecutionEnv that runs inside the conversation's container". A child turn with no tool calls would even finish while its pod was missing. That makes the pod a remote sandbox, and calling it "a subagent in a pod" is the relabeling the grounding forbids.

**The strongest successor, A′, works like this:**
- The service hosts every store.
- Each specialist assignment runs a **complete Durable Harness** in a freshly started worker: an OS process now, a k3s pod later.
- That worker reads and writes through a fenced remote `Storage`, but the bytes stay in the service.
- The worker owns the whole agent loop. The service keeps what was good about A: one central authority for contact, Jobs, capacity, cards and notices, plus central, authoritative checkpoints for the worker's own run.
- Native ownership never crosses a process boundary. The Job and its worker are linked only through an explicit protocol of identity, lease and reconciliation.

This seam is small and grounded:
- Durable's `Storage` interface has 16 methods, and `commit(writes)` is a single atomic batch call.
- Durable ships `registerStorageConformance` for testing custom storage.
- `ROOT_CONVERSATION_ID` is public, so results can be read through public records instead of a private schema.

## 2. Usage first (proposed commands; none are implemented)

```sh
# Stage 1 — MacBook, from this repository
npm run kaeno -- serve --state .kaeno --agents kaeno/agents --workspace kaeno=.
npm run kaeno -- chat            # adapted Pi TUI over .kaeno/kaeno.sock; open more terminals freely
npm run kaeno -- status          # jobs + executions
npm run kaeno -- service stop    # stop ≠ cancel: jobs pause, resume on next serve
# Stage 2 — persistent service, device clients
kaeno serve --state /var/lib/kaeno --listen tls://0.0.0.0:7443 --devices /etc/kaeno/devices.json
kaeno chat --connect tls://kaeno.home:7443 --device ipad
# Stage 3 — k3s workers
kaeno serve … --launcher k3s --namespace kaeno-workers --worker-image registry/kaeno@sha256:…
# Only ever started by a launcher:
kaeno worker --service unix:.kaeno/kaeno.sock --execution 812-q7f3 --credential-file …
```

```ts
// cli.ts `chat` — the real Pi frontend over a domain client
const client = await connectKaeno({ kind: "unix", path: ".kaeno/kaeno.sock" });
try { await runPiChat(client); } finally { await client.detach(); } // runs and jobs continue

// cli.ts `serve`
const service = await openKaenoService(loadConfig(argv)); // owner lock before any storage open
process.once("SIGTERM", () => void service.stop());       // seal, close, unlock; never cancels jobs

// scripts/tests: same KaenoSession surface in-process or remote
const { id } = await client.send({ requestId: crypto.randomUUID(), text: "Ask reviewer to assess src/auth.ts" });
const answer = await client.answer(id);                  // contact settled, NOT worker completion
const unwatch = await client.watch(f => f.type === "snapshot" ? view.reset(f.state) : view.apply(f.changes));
```

## 3. Shape

**Ownership**

```txt
kaeno service — sole owner of stateDir (flock owner.lock before any open)
├─ central Harness ── kaeno.sqlite
│    root "kaeno" (contact)
│     ├─ pi.generation → pi.tool(delegate): one creation-only commit, no effects
│     └─ Job [background, root-owned]  launch → run → report → drain │ abort
│          ╎ linked by ExecutionId + lease — NOT native ownership
│    docs: kaeno.contact · kaeno.jobs (jobs.ts) · kaeno.executions (executions.ts)
├─ Executions: leases · StoreHost · model gateway · snapshots · Launcher
│    stores/<id>.sqlite ◄── Storage RPC, (id, epoch)-fenced ───┐
└─ ChatProjection: ONE watchEvents(root) + jobs → N clients    │
worker <id> — fresh OS process (stage 1) │ fresh pod (stage 3) ┘
  Harness(RemoteStorage, gateway Provider, NodeExecutionEnv(workspace))
  root = the specialist: generation, tools, compaction, retries all run HERE
```

Each store has exactly one owner at any moment. The service owns `kaeno.sqlite`. For `stores/<id>.sqlite`, the service holds the SQLite connection and enforces the fence, but the only Durable Session on that file is the worker holding the current epoch.

**Deployment**

```txt
Stage 1 (built)                               Stage 3 (committed design, not built)
 kaeno chat ─┐ unix socket 0600                 device: kaeno chat ─ TLS + device token ─┐
 kaeno chat ─┤                                                                           ▼
             ▼                                  StatefulSet kaeno: replicas 1, local-path RWO PVC
 kaeno serve ── spawn per job ──► kaeno worker   │ Role: pods+secrets in ns kaeno-workers only
 .kaeno/{owner.lock, kaeno.sqlite,               ▼
   stores/, executions/, blobs/}                Pod kx-<id>: restartPolicy OnFailure, activeDeadlineSeconds,
                                                emptyDir /workspace, no SA token, egress → service:7444 only
```

**Modules**

```txt
src/index.ts       public surface: domain types + 4 entry functions
src/service.ts     owner guard, Harness lifetime, KaenoSession ops, listeners, stop
src/chat.ts        THE projection: Durable events + jobs → ChatState/ChatChange; bounded fan-out
src/jobs.ts        delegate/jobs tools, Job phases + abort, capacity, cards, notice policy
src/executions.ts  leases, StoreHost, model gateway, snapshots, Launcher(local | k3s)
src/worker.ts      attach, materialize, RemoteStorage, gateway Provider, fail-stop
src/directory.ts   trusted profiles + workspace registry (no hot reload)
src/wire/          private codecs; lint permits imports only from service/executions/worker
src/frontend/pi/   pinned vendored Pi interactive mode + backend.ts (its only seam)
```

A job's call chain spans three files: `jobs.ts → executions.ts ⇄ worker.ts`.

## 4. Type sketch

```ts
// ===== public (src/index.ts) — no Durable/Chord/pi types =====
export type Thinking = "off" | "low" | "medium" | "high";
export type SendRequest = Readonly<{ requestId: string; text: string; whenBusy?: "followUp" | "steer" }>;
export type SendReceipt = Readonly<{ id: string }>;
export type Answer = Readonly<{ status: "answered"; text: string } | { status: "unanswered"; reason: string }>;
// JobResult, Notice: unchanged from kaeno.sketch.ts
export type Execution = "launching" | "running" | "stopping" | "draining" | "terminal";
export type JobView = Readonly<{ id: string; agent: string; objective: string; execution: Execution;
  attaches: number; activity: string | null }> &
  (Readonly<{ result: null; notice: null }> | Readonly<{ result: JobResult; notice: Notice }>);
export type ChatBlock = Readonly<{ type: "text" | "thinking"; text: string }
  | { type: "toolCall"; callId: string; name: string; argsJson: string }>;
export type ChatMessage = Readonly<
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; blocks: readonly ChatBlock[]; stop: "done" | "aborted" | "error"; error?: string }
  | { kind: "tool_result"; id: string; callId: string; text: string; isError: boolean }
  | { kind: "compaction"; id: string; summary: string }>;
export type LiveRun = Readonly<{ partial: readonly ChatBlock[]; retry: string | null;
  tools: readonly Readonly<{ callId: string; name: string; output: string; running: boolean }>[] }>;
export type ChatState = Readonly<{
  incarnation: string; revision: number;
  contact: Readonly<{ model: string; thinking: Thinking }>;
  agents: readonly Readonly<{ name: string; description: string }>[];
  messages: readonly ChatMessage[];
  live: LiveRun | null;                                  // null ⇔ contact idle
  queued: readonly Readonly<{ receiptId: string; text: string; mode: "steer" | "followUp" }>[];
  usage: Readonly<{ inputTokens: number; outputTokens: number; costUsd: number }>;
  jobs: readonly JobView[];
}>;
export type ChatChange = Readonly<
  | { type: "message"; message: ChatMessage } | { type: "live"; live: LiveRun | null }
  | { type: "live_text"; block: number; append: string } | { type: "queued"; queued: ChatState["queued"] }
  | { type: "usage"; usage: ChatState["usage"] } | { type: "jobs"; jobs: readonly JobView[] }>;
export type ChatFrame = Readonly<{ type: "snapshot"; state: ChatState }
  | { type: "changes"; revision: number; changes: readonly ChatChange[] }>;
export type CancelTarget = Readonly<{ kind: "contact" } | { kind: "job"; id: string }>;

export interface KaenoSession {
  /** Durable admission into the one contact inbox; same requestId ⇒ same receipt (text not compared). */
  send(input: SendRequest): Promise<SendReceipt>;
  answer(receiptId: string): Promise<Answer>;
  /** Pi "dequeue": withdraw a still-queued input. */
  withdraw(receiptId: string): Promise<"withdrawn" | "already_placed" | "settled" | "not_found">;
  /** Snapshot first; later frames are disposable. Overflow/reconnect ⇒ fresh snapshot, never replay. */
  watch(listener: (frame: ChatFrame) => void | Promise<void>): Promise<() => Promise<void>>;
  /** Job: durable abort request, not completion. Contact: waits for ordinary idle; jobs survive. */
  cancel(target: CancelTarget): Promise<Readonly<{ status: "requested" | "already_terminal" }>>;
}
export interface KaenoClient extends KaenoSession { detach(): Promise<void> }  // this connection only
export interface KaenoService extends KaenoSession { stop(): Promise<void> }   // seal/close/unlock; not cancel
export type Endpoint = Readonly<{ kind: "unix"; path: string } | { kind: "tls"; url: string; deviceToken: string }>;
export type ServiceConfig = Readonly<{
  stateDir: string; agentsDir: string;
  workspaces: Readonly<Record<string, { kind: "dir"; path: string } | { kind: "git"; url: string; ref: string }>>;
  contact: Readonly<{ model: { provider: string; modelId: string }; thinkingLevel: Thinking; instructions: string }>;
  limits: Readonly<{ activeJobs: number; activePerAgent: number; retainedJobs: number; maxAttaches: number }>;
  listen: readonly Endpoint[];
  launcher: Readonly<{ kind: "local" } | { kind: "k3s"; namespace: string; image: string; workerUrl: string }>;
}>;
export async function openKaenoService(_c: ServiceConfig): Promise<KaenoService> { throw new Error("not implemented"); }
export async function connectKaeno(_e: Endpoint): Promise<KaenoClient> { throw new Error("not implemented"); }
export async function runPiChat(_s: KaenoSession): Promise<void> { throw new Error("not implemented"); }
export async function runWorker(_o: Readonly<{ service: string; executionId: string; credentialFile: string }>): Promise<0 | 1> {
  throw new Error("not implemented"); // 0 = done/fenced (no restart), 1 = fail-stop (restart)
}

// ===== jobs.ts (private) =====
type JobInput = { request: DelegateRequest; profile: EffectiveProfile;   // profile.workspace: name | null; no cwd
  executionId: ExecutionId; deadlineAt: number };                          // `${jobTaskId}-${nonce}` from admission commit
type JobCheckpoint = { phase: "launch" } | { phase: "run" } | { phase: "report" } | { phase: "drain" };
const Job = defineTask<JobInput, JobCheckpoint, { jobId: string }>({
  name: "kaeno.job", version: 2, initial: () => ({ phase: "launch" }),
  phases: {
    launch: async () => { throw new Error("not implemented"); }, // memo snapshot; executions.start; commit run
    run:    async () => { throw new Error("not implemented"); }, // next() loop; stop(grace); decide card + pending notice
    report: async () => { throw new Error("not implemented"); }, // ONE followUp kaeno:report:<jobId>
    drain:  async () => { throw new Error("not implemented"); }, // release() until "gone"; commit completed
  },
  abort: async () => { throw new Error("not implemented"); },   // stop → decide → commit → release loop → aborted
});

// ===== executions.ts (private; sole writer of kaeno.executions, stores/, executions/, blobs/) =====
type ExecutionId = string & { readonly __brand: "ExecutionId" };
type SpecHash = string & { readonly __brand: "SpecHash" };
type LaunchSpec = Readonly<{ executionId: ExecutionId; runtimeRevision: string; profileRevision: string;
  snapshot: { digest: string } | null; deadlineAt: number; resources: { cpu: string; memory: string; disk: string } }>;
type ResourceRef = Readonly<{ kind: "process"; pid: number; startedAt: number } | { kind: "pod"; name: string; uid: string }>;
type Lease = { specHash: SpecHash; resource: ResourceRef | null; epoch: number; fenced: boolean };
const ExecutionsDoc = defineDoc<{ leases: Record<string, Lease> }>({ kind: "kaeno.executions", version: 1, scope: "session" /* … */ });
type WorkerOutcome = Readonly<{ kind: "answered"; text: string } | { kind: "unanswered"; reason: string }>;
type ExecutionStatus = Readonly<{ attaches: number; outcome: WorkerOutcome | null;
  resource: "absent" | "starting" | "running" | "exited" | "terminating" | "conflict" | "unreachable" }>;
interface Executions {
  /** Adopt-before-create; idempotent per id; different SpecHash ⇒ "conflict" (never adopt or delete). */
  start(spec: LaunchSpec, context: Context): Promise<ExecutionStatus>;
  /** Fresh status after a job-store commit, resource change, or `until` (in-memory wake-up). */
  next(id: ExecutionId, until: number, context: Context): Promise<ExecutionStatus>;
  /** Cooperative abort, ≤ graceMs for self-detach, then durable fence. Returned outcome is FINAL. */
  stop(id: ExecutionId, graceMs: number, context: Context): Promise<WorkerOutcome | null>;
  /** Kill/delete by exact identity; "pending" until confirmed gone. Never forces. */
  release(id: ExecutionId, context: Context): Promise<"gone" | "pending">;
}
interface Launcher { // LocalProcessLauncher (stage 1) | K3sPodLauncher (stage 3)
  ensure(spec: LaunchSpec, hash: SpecHash, c: Context): Promise<{ ref: ResourceRef } | { conflict: SpecHash } | { unreachable: string }>;
  observe(ref: ResourceRef, c: Context): Promise<ExecutionStatus["resource"]>;
  remove(ref: ResourceRef, graceMs: number, c: Context): Promise<"gone" | "pending">;
  sweep(liveJobs: ReadonlySet<ExecutionId>, c: Context): Promise<void>;   // deletes orphans only
}

// ===== worker.ts (private) =====
class RemoteStorage implements Storage { /* every method → one RPC tagged (id, epoch); ANY error ⇒ exit(1) */ }
function gatewayProvider(channel: WorkerChannel, model: ModelRef): Provider { throw new Error("not implemented"); }

// ===== frontend/pi/backend.ts — the only seam the vendored Pi code sees =====
export interface PiChatBackend {
  readonly capabilities: ReadonlySet<"prompt" | "steer" | "followUp" | "dequeue" | "abort" | "jobs">;
  attach(onEvent: (e: FrontendEvent) => void): Promise<() => Promise<void>>; // snapshot + events handleEvent consumes
  submit(text: string, mode: "prompt" | "steer" | "followUp"): Promise<void>; // owns requestId + retry outbox
  dequeue(): Promise<readonly string[]>;
  abort(): Promise<void>;
}
```

## 5. Remote worker protocol

**Identities**
- **JobId:** the central Job's TaskId.
- **ExecutionId:** `<JobId>-<nonce>`. The nonce is minted in the delegate's admission commit and stored in the immutable Job input. It stays stable across replays. After a power-loss rollback that reuses a TaskId, it changes, so the stale pod and store become orphans rather than being adopted.
- **SpecHash:** sha256 of the canonical LaunchSpec, which covers the image digest or code hash, profile revision, snapshot digest, deadline and resources.
- **Resources:**
  - A pod is identified by `{name: kx-<ExecutionId>, uid}`.
  - A process is identified by `{pid, startedAt}` plus an flock on `executions/<id>/worker.lock`.
  - Names locate a resource; UIDs identify it. Every delete carries a UID precondition, and every kill re-checks the process start time.
- **Epoch:** an attach counter held in the lease and committed before the attach is acknowledged.
- **Worker credential:** `HMAC(serviceKey, ExecutionId‖SpecHash)`. It is deterministic, never stored, and valid only while the lease is unfenced.

**Launch and adoption** (Durable spec §5.2 "effect sandwich": commit intent, perform the effect, commit the outcome)

The `launch` checkpoint is the intent. The phase runs these steps:
1. Memoize the snapshot digest; the first writer wins.
2. Build the spec.
3. Call `start()`:
   - Create the lease `{specHash, epoch 0}` if it is absent. If it exists with the same hash, continue; with a different hash, report a conflict.
   - Call `Launcher.ensure`:
     - Look first: on k3s, GET the pod by name; locally, probe the lock and `spec.json`.
     - Adopt the resource if its hash matches; otherwise create it (k3s: Secret, then Pod).
     - If the create returns `AlreadyExists`, GET and compare.
   - Record the resource in the lease.
4. Commit `{phase:"run"}`.

If a create succeeded but its response was lost, the replay adopts the resource instead of creating a second one. At startup, `sweep()` deletes only labeled resources whose ExecutionId belongs to no live Job. This means a launch that was in flight during a crash is adopted, never swept.

**Attach and fencing**

The worker sends its ExecutionId, its credential, its resource identity (`POD_UID` via the downward API, or its pid), its runtime revision and its SpecHash. In one central commit, the service checks:
- **Reject** the attach if any of these hold:
  - there is no lease, or the lease is fenced;
  - the hash or runtime revision does not match;
  - the recorded resource is missing or has a different UID ("adopt before serve");
  - `epoch ≥ maxAttaches` (this also fences the lease).
- **Otherwise** increment the epoch, close any older session (its SqliteStorage instance closes, so in-flight operations reject), open a fresh SqliteStorage instance, and return the assignment.

Every storage, model and blob operation carries `(id, epoch)`, and only the current epoch is served.

The worker is fail-stop. Any channel error, timeout or ambiguous commit makes it exit 1 with no further writes. kubelet (`OnFailure`) or the local supervisor then restarts it. The new process re-attaches, and Durable's own recovery resumes from the central checkpoint:
- a committed partial becomes an aborted entry;
- a replay-unsafe tool call gets an `interrupted` result.

A fenced or exhausted worker exits 0, so it is not restarted.

**Worker run**
1. Open a Harness over RemoteStorage with `progress` set to 250 ms.
2. Call `root(ctx, { agent: profile, init: write kaeno.assignment{SpecHash} })`, then verify the assignment on every attach.
3. Submit the objective and brief with `requestId: kaeno:work:<ExecutionId>`, which Durable deduplicates.
4. Call `resume()` and wait. A control `stop` message triggers `root.abort()`.
5. Once settled: close the Harness, detach, exit 0.

There is no upload protocol. The result is the committed submission in the central job store. The service reads it through the public `Storage` API: `submissionByRequest(ROOT_CONVERSATION_ID, …)` and then `entry(answer)`.

**Run and decision**

`run` loops on `next()`:
- **Outcome present:** call `stop(grace)`; the worker usually detaches first. Then validate and bound the answer, and commit the card, a `pending` notice and `{phase:"report"}` in one commit.
- **Deadline, exhausted attaches, or resource exited without an outcome:** call `stop(grace)` to get the final outcome. An answer means `succeeded`; otherwise `failed: deadline` or `outcome_unknown`.

`report` is unchanged: exactly one root followUp, `kaeno:report:<JobId>`. `drain` calls `release()` with `runtime.sleep` backoff until it returns `"gone"`, then commits the terminal state.

**Cancel**

`cancel({kind:"job"})` calls `harness.abortTask` and returns `requested`. The run invocation is signalled and joined. Because the Job owns no native work, its abort handler starts at once:
1. Call `stop(grace)`.
2. Keep any card already decided. Otherwise, an answer means `succeeded`, and anything else means `cancelled`.
3. Turn a pending notice into `deferred`.
4. Commit the decision while the task is still live.
5. Loop on `release()` until the resource is gone.
6. Commit `aborted`.

If the service closes mid-abort, the abort mark is kept and the idempotent handler reruns after reopen. A Job never becomes terminal while its launch intent or its resource is unresolved.

**Capacity**

The rule is unchanged: count every nonterminal Job. A Job is terminal only when its lease is fenced and its resource is confirmed gone, so capacity always equals real remote occupancy. An unreachable Kubernetes API or a pod stuck in `Terminating` keeps holding capacity and shows as `draining`. There is no force-delete and no timeout-based stealing.

**Retention**
- **Card:** stored in `kaeno.jobs`, bounded in size.
- **Full transcript:** the store `stores/<id>.sqlite`, kept with the card and counted against `retainedJobs`. Nothing is evicted silently.
- **Snapshots:** content-addressed blobs, kept while referenced.
- **Artifacts (later, write-capable workers):** uploaded content-addressed over the fenced channel and referenced from a worker document committed before the answer. Nothing outside the pod changes without an explicit apply step.

## 6. Workspace materialization

A Mac absolute `cwd` means nothing inside a pod. Profiles therefore name a registered **workspace** instead. The Job's `launch` phase, never the delegate tool, turns that name into an immutable snapshot:
- `dir` source: a tarball of `git ls-files -co --exclude-standard`, so ignored files and secrets stay out;
- `git` source: fetch `ref` and archive that commit.

The snapshot is stored as a sha256 blob, and its digest is memoized in the Job (first writer wins). The worker:
1. fetches the blob over its fenced channel;
2. verifies the digest;
3. extracts it into its scratch directory (`executions/<id>/workspace` locally, `emptyDir /workspace` in a pod; a marker file makes extraction idempotent across container restarts);
4. uses that directory as the Durable `cwd`.

Provider keys never enter workers. The gateway Provider forwards `streamSimple` to the service's real `Models`, and only the profile's model is allowed.

## 7. Reusing the actual Pi frontend

**What has to be adapted.** Installed 1.1.0's `interactive-mode.js` is 5,958 lines. Its constructor requires `AgentSessionRuntime`, and roughly 350 lines reach `session`, `sessionManager` or `settingsManager`. The package `exports` map blocks deep imports. The renderer composition (`createInteractiveTui`, `createChatViewport`), the theme controller and the footer data provider are not in the public index.

**Plan:**
1. **Upstream first.** Propose an `InteractiveBackend` extraction. `package.json` lists `pi-client`, `pi-protocol` and `pi-server` as dev-only dependencies and has a source-only `./client` export. Check whether that work already defines this seam.
2. **Meanwhile, a scoped vendored fork.**
   - Copy the interactive orchestration (interactive-mode, tui-renderer, chat-viewport, theme controller, status indicator, footer) from the pinned upstream source, verified against the 1.1.0 source map's `sourcesContent`.
   - Make one mechanical change:
     - `runtimeHost` becomes `backend: PiChatBackend`;
     - `subscribeToAgent` becomes `backend.attach`;
     - `session.prompt/steer/followUp` becomes `backend.submit`;
     - `session.abort` becomes `backend.abort`;
     - the initial render and compaction rebuild become `renderSnapshot`.
   - Import exported components (AssistantMessage, ToolExecution, UserMessage, CustomEditor, KeybindingsManager, Theme) from the pinned package.
   - Track the patch series; CI fails if the vendored base drifts from the pin.
3. **An adapter** folds `ChatChange` appends into the whole-message events that `handleEvent` already consumes.

There is no `AgentSession` cast, no dummy session, no `SessionManager`, and no `pi --mode rpc` (that would run the normal agent).

**Supported:**
- transcript, streaming text and thinking, tool rows, compaction summaries;
- the editor with history, paste and external editor; keybindings; themes;
- Enter to prompt, or to steer while busy; the follow-up key;
- durable queue display and dequeue (via `withdraw`); Esc cancels the contact;
- the footer (model, usage, jobs, connection) and job cards;
- `/jobs`, `/cancel <job>`, and `/quit` (which detaches);
- client-local display settings.

**Gated.** These show "not available in Kaeno", make no backend call and execute nothing locally:
- `!`/`!!` bash, `/model`, `/thinking` and model cycling, `/login` and `/logout`;
- `/new`, `/resume`, `/fork`, `/tree`, `/clone`, `/import`, `/export`, `/share`, `/session`, `/name`, `/reload`, `/compact`;
- Pi extensions, skills, templates and MCP; images; `/bug`; update checks and telemetry.

The client-side compaction queue is deleted; every input goes straight to durable admission.

**Verification gate** (the first implementation milestone):
- golden frames from a scripted pi-tui `Terminal` and a fake backend, covering snapshot, streaming, tool rows, queue/dequeue, steer, Esc, overflow re-render, the reconnect banner and job cards;
- every gated command asserted to make no backend call and spawn no process;
- a lint rule banning `AgentSession`, `AgentSessionRuntime`, `SessionManager` and `SettingsManager` from `frontend/`;
- a hash check on the vendored base;
- a manual smoke test in Terminal.app, iTerm2 and kitty.

## 8. One service, many clients

**Ownership.** The service process is the only owner of the Harness and its SQLite file. It takes an flock on `owner.lock` before opening anything. The lock is released by the OS if the process dies abruptly and is never stolen by a timer.

**Observation.** One `ChatProjection` subscribes once (`watchEvents(root)`, the jobs doc, the task graph and execution activity) and folds all of it into `ChatState` with a revision number per service incarnation. Each client gets a snapshot when it attaches, then frames through a bounded queue (128 frames or 1 MB):
- on overflow, the queue is dropped and a fresh snapshot is sent;
- a client that cannot accept a snapshot within 10 s is disconnected.

Clients never open SQLite, and a reconnect never starts any work.

**Request IDs and order.** The client mints a UUID for each submission and keeps it in an in-memory outbox, resending after reconnect until it gets a receipt. The service submits with Durable `requestId: c:<uuid>`, a namespace disjoint from the `kaeno:*` IDs. Order is Durable's commit order: concurrent devices are serialized there and all see the same order in their snapshots.

**Detach versus stop:**
- **Detach** ends one connection's watch and touches nothing else.
- **Stop:**
  1. seals admission and sends `stopping` to clients;
  2. ends watches;
  3. closes the Harness (Jobs keep their checkpoints);
  4. closes worker channels, so workers fail-stop (pods back off, or end at `activeDeadlineSeconds`);
  5. releases the lock.
- **Restart:** Jobs pick up again. The local launcher relaunches a worker only once its lock shows it is dead.

**Auth.** Stage 1 relies on the socket's 0600 permissions. Stage 2 uses TLS plus per-device tokens, hashed at rest. There is one human user and no per-device permissions.

## 9. Built locally versus committed for k3s

**Stage 1 (built on one Mac):**
- the service/client split and the Pi frontend extraction;
- the central Harness and the Job phases;
- `LocalProcessLauncher`: a fresh OS process per assignment, with a supervisor that mimics `OnFailure` restarts;
- StoreHost, RemoteStorage, the gateway and snapshots, all over the Unix socket;
- every crash test below.

**Stage 2:** adds only a TLS listener and device tokens.

**Stage 3 (designed, not built; no manifests, images or cluster changes exist yet):**
- `K3sPodLauncher`: deterministic names, UID preconditions, a per-execution Secret, `activeDeadlineSeconds` as a kubelet-enforced backstop, no service-account token, non-root with a read-only root filesystem, `emptyDir`;
- an in-cluster TLS worker port;
- the image digest used as `runtimeRevision`;
- a StatefulSet with 1 replica on a node-pinned `local-path` RWO PVC, so the flock stays meaningful;
- a Role scoped to one namespace;
- a NetworkPolicy allowing egress only to the service.

## 10. Crash tests

1. Kill the service with SIGKILL after the delegate commit but before launch → after restart there is exactly one resource.
2. A fake launcher creates the resource, then times out the response, and the service is killed → restart adopts the same UID/pid, and create was called once.
3. A resource already exists with the same name but a different SpecHash → it is neither adopted nor deleted, and its attach is rejected.
4. Kill the worker mid-stream → it is restarted with epoch+1, the store shows one aborted partial followed by the answer, and the Job succeeds.
5. Kill the worker inside `read` → the call gets an `interrupted` result and the run continues.
6. The worker crash-loops until `maxAttaches` → fenced, `outcome_unknown`, transcript retained.
7. The worker commits its answer and the service is killed before deciding → restart decides from the store, with exactly one `kaeno:report` submission.
8. A stale-epoch connection commits or calls the model → rejected, and the store's sequence is unchanged.
9. Cancel while a launch is in flight → the handler resolves `ensure`, releases the resource and ends `cancelled`; capacity is held until the resource is gone.
10. A hung worker ignores the abort → fenced after the grace period, killed after a start-time check, ends `cancelled`.
11. The launcher API is unreachable during drain → the Job stays `draining` and holds capacity, then recovers.
12. `service stop` while jobs run → workers exit 1, and the next `serve` reattaches and finishes them.
13. Two clients send concurrently with retried duplicate IDs → one submission per ID, in the same order on both clients.
14. A client socket blocks → that client gets an overflow snapshot; other clients are unaffected; no extra SQLite handles are opened.
15. A second `serve` on the same state directory fails before opening storage; after the owner is killed, the next `serve` opens.
16. Durable's `registerStorageConformance` passes against RemoteStorage↔StoreHost.
17. A simulated rollback that drops the WAL tail → a reused TaskId gets a new ExecutionId, the old resource and store are swept, and the report is not sent twice.

## 11. Explicit limits

- There is a single service with no high availability. An outage stalls every worker, because every commit and model call goes through the service.
- In v1, losing a pod (eviction or node failure) means `outcome_unknown`. The checkpoint survives, but nothing resumes it in a new pod.
- A node that never confirms termination holds capacity until an operator acts.
- A crash can cause a model request to be re-sent, so cost can repeat. There are no exactly-once effects.
- Workers are read-only. There is no write-back, no recursive delegation, and no live worker-transcript streaming; job cards show coarse `activity` only.
- WAL with `synchronous=NORMAL` may lose the newest commits on power loss; recovery relies on rerunning idempotent phases.
- The client outbox lives in memory, so a message that was not yet admitted dies with the client.

## 12. Rationale

**Problem.** Kaeno has to keep Durable's transactional contact and job semantics while the actual Pi chat frontend renders it and each specialist's whole agent runs in a fresh process, and later in a fresh pod. Durable gives one process per store, has no remote task executor, and offers native ownership and abort only inside one Harness. The Pi frontend is tied to `AgentSessionRuntime`. The design must keep:
- fresh job-scoped workers and creation-only delegation;
- the rule that every nonterminal Job counts toward capacity;
- retained results and one automatic notice attempt.

**Shape.** Data structures first:
- The central store holds `kaeno.jobs` (`byOrigin` → JobId, plus cards), `kaeno.executions` (leases, owned only by `executions.ts`) and the native Job tasks.
- Each execution has its own Durable store.

The load-bearing decision is that the service owns all the bytes and the workers own all the agent loops. That keeps A's central authoritative checkpoints without pretending the loop runs in the pod. One fence mechanism (epoch, lease and fail-stop) covers storage, model calls and blobs. Results need no upload protocol, because they are already committed facts in a centrally held store.

**Interface depth:**
- `KaenoSession` exposes five operations and hides Durable, projection and remote execution.
- `Executions` exposes four and hides leases, RPC, the gateway, snapshots and launchers.
- `PiChatBackend` hides Kaeno from the vendored code.

Validation happens at the boundaries: config, tool arguments, the attach handshake, answer bounding and client frames. Principles applied: one writer per piece of state, idempotent effect sandwiches, branded identities, and fail-stop wherever an outcome is ambiguous.

**Synthesis decision.** Filled in by arena.

**Tradeoffs accepted:**
- We accept tying worker liveness to the service in exchange for central checkpoints, one fence, and no result-upload protocol.
- We accept a patch-tracked vendored frontend in exchange for genuine reuse without a second session authority.
- We accept holding capacity through unconfirmed termination in exchange for never over-committing the cluster.
- We accept `outcome_unknown` on pod loss in exchange for not needing a protocol for overlapping replacement pods.
- We accept building the model gateway in stage 1 in exchange for an identical worker in every stage with no keys inside it.

**Alternatives considered:**
- **Literal A** (central Harness with a remote env and model): the deepest native interface, with ownership, abort and checkpoints for free. It fails the placement requirement, and is right only if the requirement were "tools run in an isolated pod".
- **Pod-local worker stores with result upload** (the main competing whole shape): workers survive service outages and no Storage RPC is needed. But checkpoints die with the pod, results exist only if an upload/ack/retry protocol succeeds, and transcripts need a second upload. It exposes more protocol for weaker guarantees.
- **Distributed Harness** (pods executing central tasks): would require a remote task executor inside Durable's scheduler, which means forking Durable.
- **`pi --mode rpc` or `createAgentSession` for rendering:** either runs the normal agent or creates a second context authority.

**Open questions:**
- Does upstream's pi-client/protocol work already provide the backend seam we need?
- Should "resume in a fresh pod from the central checkpoint" be part of stage 3?
- Where should server-stage workspaces come from: a git fetch with a deploy key, or snapshots uploaded by clients?
- Is a service round-trip on every commit acceptable for long jobs?
- Is losing the newest commit on power loss acceptable for the persistent service?

**Next implementation step.** Build StoreHost and RemoteStorage over a loopback channel, and pass `registerStorageConformance` plus the epoch-fence tests. If that fails, switch to pod-local stores before building anything else.

## 13. Changes to old decisions

- **One Durable store** becomes one central store plus one store per execution, all hosted by the service, each with a single Session owner.
- **The native child conversation owned by the Job** becomes the worker's root conversation in its own store, linked to the Job by ExecutionId and lease. Native ownership does not cross processes.
- **Phases `work`/`report` with native bottom-up abort** become `launch`/`run`/`report`/`drain`, and the abort becomes stop → fence → decide → release. A Job is terminal only after drain.
- **The absolute profile `cwd`** becomes a workspace name pinned to an immutable snapshot.
- **The API `openKaeno`/`close`/`snapshot()`** becomes `openKaenoService` and `connectKaeno`, with `stop` and `detach` separated, and snapshot-plus-change frames.
- **Workers using host credentials** becomes the service gateway plus a per-execution credential.
- **Kept:** creation-only `delegate` with `byOrigin` replay, the capacity rule, retained cards, one notice attempt, background Jobs, contact-cancel semantics, and no `AgentSession` or `SessionManager`.
