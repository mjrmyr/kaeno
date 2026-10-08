# Withdrawn host-arena synthesis: Pi TUI and whole-worker k3s pods

> Historical proposal only. The user dropped the *stock Pi frontend* and k3s requirements and chose a [custom `pi-tui` app + same-process native Durable workers](../minimal-kaeno.md). **Do not implement the client/TUI/remote-worker architecture below.**

## Pick

**Base B:** one persistent Kaeno coordinator Harness/store and one private worker Harness/store per assignment. The entire worker agent executes in a local subprocess initially and a fresh k3s pod later. Pi's actual interactive frontend must be extracted/adapted; it is a client of the coordinator, never a second coding-agent session. Candidate A's literal single-Harness remote-`ExecutionEnv` shape was rejected by its own runner because the agent loop stays in the coordinator. Its stronger A′ variant instead placed entire Harnesses in pods with an RPC-backed central `Storage` and model gateway; it was viable but was not chosen.

The cross-judge recommended **A′ (19/25 vs B 17/25)**. Parent **disagrees on size**: a new transactional remote Storage backend + epoch fencing + provider gateway in the *first* local implementation costs more and touches a deeper persistence boundary than one shipped private SQLite store per worker with a small, verifiable immutable result handoff. A′ avoids per-job PVCs and handoff, which is real value; if B's retained private volumes/handoff prove worse in tests, reopen this decision rather than add ad hoc compensations. See [`judge.md`](judge.md) for full rationale and scores.

## Grafts and corrections

- From A′: stronger actual Pi frontend extraction and capability-gating gate; stable manifest hash/worker identity and adopt-before-create; long-lived owner versus client detach; one service with coalesced full client snapshots. Service-side result acceptance checks resource identity and spec digest, not an unfenced callback.
- From B: root `kaeno.jobs` has an **external obligation** held even after a native Job has faulted, become orphaned, or reached terminal. Quota is native live **OR** external held; stop intent permanently closes the bootstrap claim gate before signaling native/remote abort. No auto-release on heartbeat loss or Pod name disappearance.
- From judge: Esc must not invoke global `Conversation.abort()` in a multi-device chat. It may withdraw the caller's own still-queued input; a placed turn cannot be individually aborted with Durable's `abortSubmission`. A separately named, authorized global contact cancellation can withdraw other devices' queued inputs and worker notices and must show that scope explicitly.
- Parent correction to both: `root.watch()`/`watchEvents` exclude arbitrary job documents. Build snapshots from committed transcript/live state **plus** custom docs/task receipts on a single coordinator read revision; subscribe to commits for job-only changes, coalesce updates, and never let observation run policy. This adapter is a planned implementation gate, not proven by the two native probes.
- Simplified B: v1 read-only workers return a bounded text seal; there are no generated artifact uploads until an artifact-retention policy exists. Retain private worker stores after handoff. No automatic worker replacement in an uncertain node partition; require strong proof before reuse of its store.

## Changes to old design

| Before | Synthesized |
|---|---|
| Native task-owned child conversation in one Harness | Coordinator Job + independent worker Harness in another process/pod; explicit assignment boundary |
| One SQLite file holds all transcripts | Coordinator file and one private worker file/volume per job; single owner per store |
| Capacity from all nonterminal native Jobs | Native nonterminal **OR** unresolved external execution reservation |
| `cwd` on host config | Named trusted workspace; immutable bounded snapshot and worker-local path |
| Text-only facade snapshots | Structured contact/tool/job presentation for source-adapted Pi frontend |
| Opening/closing Kaeno = using/stopping bot | Persistent service ownership; clients attach/detach; explicit service stop |
| One client on local Mac | Local multi-attach socket first; authenticated remote device endpoint later |

Kept: one main `kaeno` contact; reusable specialist templates; creation-only replay-safe delegation; immutable effective job profile; one automatic root follow-up attempt and durable result cards; read-only workers; honest cancellation and uncertainty; no parallel general-purpose task scheduler or ordinary coding-agent AgentSession.

## Verification

- Pi source/docs inspection: installed coding-agent 1.1.0's `InteractiveMode` expects `AgentSessionRuntime` and reads session managers; Durable has no remote task executor and `ExecutionEnv` is filesystem + shell only. A real frontend extraction is necessary; it is not yet implemented or proven.
- Earlier five native primitive probes passed (see [`../native-arena/verification.md`](../native-arena/verification.md)). They **do not** prove foreign process/pod ownership.
- New native boundary probes in [`probes.mjs`](probes.mjs): **2 passed** on published Durable 1.1.0. A terminal coordinator task does not drain a worker running in another Harness; a custom job doc is absent from the built-in conversation view, while a commit subscription sees its change. These illustrate why the external obligation and combined projection are required; they do not implement either.
- The revised `kaeno.sketch.ts` typechecks strictly and exports domain-only types. No frontend, worker, service, network, crash/failover or Kubernetes acceptance test has been executed.

## First implementation gates

1. Pi source-derived TUI on fake committed domain snapshots; PTY tests show the familiar editor/streaming/tools/theme behavior and assert no normal AgentSession/SessionManager, no gated-command effects.
2. One local coordinator/worker process, private Durable stores, creation replay + claim gate + seal retransmission, including process-kill after every boundary and quota held after native fault.
3. Multiple local client attachments with per-client ID, explicit detach, safe queued-input withdrawal and full snapshot reconnect.
4. Authenticated service deployment; only then k3s Pod/PVC placement and node-fencing tests. No migration to k3s until these gates pass.

The current project is still **design/scaffold only**. The use of `npm run kaeno` and `kaeno serve/chat` in the design is proposed behavior, not a runnable command.
