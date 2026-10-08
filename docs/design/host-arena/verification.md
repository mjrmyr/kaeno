# Verification: frontend/server/pod architecture pass

**Architecture only.** No Kaeno runtime, reused Pi frontend, client transport, worker process, k3s manifest or deployed service exists. Proposed shell commands in documentation are not executable.

## Executed (published dependencies 1.1.0)

- Source grounding: installed `@earendil-works/pi-coding-agent` 1.1.0 `InteractiveMode` requires `AgentSessionRuntime` and reads the current normal session/manager; Pi SDK and RPC start normal coding-agent sessions. Pi Durable's `HarnessOptions.env` changes environment capabilities, not where the agent scheduler runs. `Harness` is single process/store owner. Durable `watchEvents` contains native built-in pi.* state, not Kaeno's custom job document.
- `docs/design/kaeno.sketch.ts` strict TypeScript 5.9.3 `--noEmit --strict --module NodeNext --skipLibCheck` **passed**, dependencies installed in `/tmp/kaeno-native-verify`. Emitted public declaration does not contain `@earendil`, `TaskId`, `Context` or `ConversationId`; **passed**. The scaffold bodies all throw `not implemented`.
- Earlier five native probes (`../native-arena/probes.mjs`) rerun: **5 passed**. They prove creation-only replay, contact background ownership within a single Harness, `completing` capacity, table read order and withdrawn notice behavior; none prove process/pod execution.
- Two new native boundary probes [`probes.mjs`](probes.mjs): **2 passed** with `node --test`. The coordinator's Job can fault while another Harness's worker remains running and a custom doc reservation stays held. Root built-in conversation view excludes custom app docs, but `Session.subscribeCommits` sees their changes. These are focused counterexamples, not a completed cross-process job protocol.
- Local HTML presentation static links/IDs verified; deck navigation/mobile/no-JS/print previously tested. Updated architecture text and links checked statically.

Re-run in the prepared local dependency fixture (not a production install):

```sh
cp docs/design/kaeno.sketch.ts /tmp/kaeno-native-verify/kaeno.sketch.ts
cp docs/design/host-arena/probes.mjs /tmp/kaeno-native-verify/host-probes.mjs
/tmp/kaeno-native-verify/node_modules/.bin/tsc --noEmit --strict --target ES2022 \
  --module NodeNext --moduleResolution NodeNext --skipLibCheck /tmp/kaeno-native-verify/kaeno.sketch.ts
node --test /tmp/kaeno-native-verify/host-probes.mjs
```

## Not executed; implementation acceptance criteria

- Source-derived Pi TUI running against Kaeno domain frames with no `AgentSession`/`SessionManager` authority; PTY golden-state tests for transcript, streaming, tools, compaction, resize, paste and gated commands. Pin source revision and verify patch drift.
- A single consistent chat/jobs/task snapshot across commits, job-only changes, overflow/coalescing and reconnect with multiple clients. Client disconnect never stops service; Esc cannot abort another client's placed turn.
- Local single-owner guard before SQLite open, kill/restart, incompatible runtime drift rejection before implicit scheduling, stale callback fencing and explicit service stop.
- Job admission replay/changed arguments/limits; held external obligation on native fault, orphan, completing and report phases; no slot release on result card alone.
- Process create response loss/adoption, delayed bootstrap after cancel, prior authorization response loss, sealed result retransmission, lost coordinator acknowledgement, conflicting seal, worker store recovery only after verified predecessor death, and artifact retention when later added.
- Real k3s Pod creation/UID adoption conflict, CSI/PVC capability preflight, stalled Pod in Terminating, partition/forced delete, missing worker storage, image/runtime drift and no overlapping replacement or quota release after uncertain termination.
- Authenticated TLS/device lifecycle (once enabled), input retry semantics, bounded snapshots for slow clients, security of workspace snapshot and pod-scoped credentials/RBAC. Mac-only Unix socket precedes network exposure.
- No exactly-once provider calls, automatic high availability or power-loss newest-commit guarantees claimed.
