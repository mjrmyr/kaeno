# Grounding: real Pi frontend and local-to-k3s execution

## User contract

Use the existing Pi chat TUI, not just an unrelated terminal UI built from pi-tui widgets. Start from this repository on one MacBook. Later run one persistent self-managed Kaeno service, attach multiple device clients, and launch a fresh k3s pod for each specialist assignment. This is an architecture update, not runtime implementation or deployment.

## Versions / evidence

- Installed `@earendil-works/pi-coding-agent` 1.1.0: `/Users/km/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent` (read-only; do not change install).
- Source Durable checkout: `/tmp/kaeno-pi-source/packages/durable`, inspected commit `6fb2e7815167e6b19006fc526d1a5d0f5f998787`.
- Published runtime dependencies and TypeScript checker: `/tmp/kaeno-native-verify` (Durable/pi-ai/chord 1.1.0).
- Existing authoritative design: `/Users/km/projects/priv/kaeno/docs/design/{minimal-kaeno.md,kaeno.sketch.ts,kaeno-rationale.md}`. Native probe verification lives in `native-arena/verification.md`; it proves only same-process Harness primitives.

## Pi interactive frontend: how it actually works

`pi` CLI constructs an `AgentSessionRuntime`, then `InteractiveMode(runtimeHost, options)`. Installed `dist/modes/interactive/interactive-mode.d.ts` explicitly requires `AgentSessionRuntime`; it is not a backend-neutral frontend interface. The corresponding `.js`:

- lines 348–359: getters directly reach `runtimeHost.session`, `session.agent`, `session.sessionManager`, `session.settingsManager`.
- lines 360–425: constructs Pi's renderer, containers, `CustomEditor`, keybindings, theme controller and `FooterComponent(session, ...)`; subscribes to session replacement lifecycle.
- lines 2680–2734: `!` commands execute session-local bash; submissions while streaming call `session.prompt(..., { streamingBehavior: "steer" })`.
- lines 2737+: `session.subscribe` feeds streaming/transcript/tool renderers; compaction rebuilds from `SessionManager` entries.
- footer component also reads `session.sessionManager`, persisted entry tree, cwd, model and usage.
- session/tree/new/resume/fork/import/model/login/extension paths throughout that file depend on coding-agent session services.

`docs/sdk.md`: `SessionManager` is authoritative for finalized coding-agent context, even when in-memory. Normal SDK `createAgentSession` therefore introduces another execution/context owner, not merely a renderer. `docs/rpc.md` / `docs/cli-integration.md`: `pi --mode rpc` hosts the normal agent behind stdin/stdout JSONL. It does NOT turn the existing TUI into a client for arbitrary remote Durable services. `RpcClient` talks to that normal subprocess, not to Pi Durable.

Conclusion: stock `new InteractiveMode(durableFacade)` is not supported. Reusing the *actual* chat frontend needs a pinned source extraction/adaptation (prefer upstream backend-interface extraction; scoped vendored frontend fork if necessary). Keep editor, terminal renderer, transcript/tool components, themes, and keyboard behavior. Replace session-bound orchestration with a deliberately small backend contract. No `as AgentSession` casts, dummy executing session, in-memory SessionManager context authority, installed-package monkey patches, or second agent just to render. Explicitly capability-gate unsupported commands rather than let them run locally.

Relevant docs completely read for this pass: installed `README.md`, `docs/{sdk,rpc,extensions,tui,cli-integration}.md`. Example: `examples/sdk/13-session-runtime.ts` shows full session replacement, not Durable integration. Source maps/distribution are grounding, not proof of extraction size or full frontend compatibility. Terminal interaction tests against the extracted frontend are a first implementation gate.

## Durable: ownership and process boundaries

- A Harness coordinates one Session/storage in one process. `README.md` Storage: one process owns a store; no cross-process locking. SQLite WAL/NORMAL supports process-crash recovery, not newest-commit survival after host power loss.
- `src/harness/types.ts` `HarnessOptions`: `models`, registry, settings, optional per-conversation `env`, creation hook. No built-in remote task executor or distributed ownership primitive.
- `src/harness/generation.ts` resolves the model and calls `runtime.models.streamSimple`; `ExecutionEnv` changes filesystem/shell capabilities, not where the native agent/task orchestration executes.
- `src/env/index.ts`: `ExecutionEnv extends FileSystem, Shell`. It can adapt files/commands to a container. It is NOT a whole-worker dispatch API. Remote tools alone must not be relabeled an entire subagent running in a pod.
- Native ownership and bottom-up abort cover records/invocations inside that Harness only. A native parent Job cannot automatically drain another process, another Harness/store, or a k3s pod.
- Background root-owned Jobs keep contact available. Creation-only tool can transactionally deduplicate by tool task ID and create durable intent without doing network/process effects. External spawning must occur later in a Job phase, with explicit stable identity/reconciliation.
- Native table reads before writes; all nonterminal parent tasks count toward capacity, including abort-marked/completing/report phase. Native `completing` cannot prove remote worker drainage.

## Durable observation can feed an adapted frontend

`README.md` Agent Events and `test/examples/21-late-join.ts`: `watchEvents(harness, conversationId, context)` gives initial full committed snapshot plus serialized per-commit event batches. Slow consumers (>100 pending batches) get a replacement snapshot. Events are similar to coding-agent events, not identical: `message_update` carries `changes`, tool output carries set/trim/append. It is not a drop-in `AgentSessionEvent` stream. Native domain facade's old text-only snapshot is too small for Pi's real streaming/tool UI.

Client-facing presentation must adapt committed state, not run policy from callbacks. Reconnect starts from full state; live deltas are disposable, not delivery receipts. View/watch shutdown must drain current callbacks. Multiple connected clients must not each open SQLite or trigger new work from reconnect.

Additional source detail: `src/harness/view.ts` mounts only the five built-in pi.* documents, not arbitrary Kaeno documents. A unified domain snapshot must explicitly read the job documents/task records as well as transcript/live state; subscribing only to root.watch/watchEvents misses job-only changes. `Session.subscribeCommits` is public; a service-side coalescing adapter can subscribe there and capture a read-only transaction-consistent projection with `Tx.doc`/table reads. Per-open incarnation + monotone sequence protects clients from stale frames, not from workload split brain.

## Kubernetes facts (official documentation)

Read 2026-10-08:
- https://kubernetes.io/docs/tasks/run-application/force-delete-stateful-set-pod/ — force deletion does not wait for kubelet confirmation; an old pod process can continue after its name disappears, allowing an overlapping replacement. This is not limited to our choice of Pod controller.
- https://kubernetes.io/docs/concepts/storage/persistent-volumes/ — RWO permits multiple pods on one node; RWOP requires CSI support and appropriate sidecars. RWO and a deterministic pod name are not execution fencing.

Fetched text excerpts are under `/tmp/arena-kaeno-host/{force-delete,volumes}.txt`. Do not promise RWOP on stock k3s storage without a real capability preflight. One-node, no-auto-failover placement is a viable minimal initial cluster policy; multi-node recovery needs proven old-executor fencing before replacement. Client SSH attachment can meet initial multi-device access without exposing a public HTTP gateway or multiwriter SQLite.

## Required pressure tests

1. Actual Pi frontend reuse versus clean-room pi-tui composition: extraction is real work, not an API switch.
2. Whether one central Harness with remote environments genuinely meets whole-agent-per-pod placement.
3. Stable job/execution identity; spawn succeeds but response lost; same-id different manifest rejected; restarted coordinator adopts before creating.
4. Remote cancellation: parent abort handler must not declare finished while worker or external launch intent remains unresolved.
5. Pod/container name vs UID; old callbacks and outputs; replacement overlap; process death before/after checkpoint/result upload; no automatic unsafe rerun.
6. File access: Mac absolute cwd is not a server workspace. Server jobs need immutable workspace provenance/materialization, credential handling and output transfer.
7. Multi-device admission ordering, request retries, full snapshots, auth, slow clients, disconnect vs stop; no second ledger/scheduler unless an external boundary truly requires it.
8. Persistent service ownership/fencing: one replica is topology, not proof against split brain. No multiwriter shared SQLite on network storage.

## Arena runners

Claude CLI availability check succeeded (`claude-opus-5-5`, effort max). Use one isolated Claude candidate and one isolated OpenAI Codex `gpt-6.1-sol`, reasoning xhigh candidate, then an OpenAI readonly cross-judge. Outputs go to isolated `/tmp/arena-kaeno-host/candidate-{a,b}/`; no candidates edit the repository.
