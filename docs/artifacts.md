# Run Artifacts — Design

Persist, per delegation ("run"), the physical evidence of what a sandboxed agent actually
did — so behavior and work products can be debugged from real data instead of guesses.
One primitive, used identically in production and by the self-test rig.

## Decisions (settled)

1. **Capture is implicit and out-of-band.** Sandboxed agents do not know artifacts exist.
   No instructions, no tools, no prompt coupling. Kaeno snapshots what is there.
2. **Capture happens at teardown** through the existing envd channel, plus pod logs via the
   orchestrator's `pods/log` RBAC. Orphaned sandboxes are collected the same way by the
   sweep; if the pod is already gone, nothing is recorded.
3. **No arbitrary timeouts.** Collection is bounded by two natural limits only: the byte
   cap (size) and the pod lifecycle (`activeDeadlineSeconds` — when the pod dies, envd dies,
   the connection resets, collection ends). Teardown step failures stay independent
   (pod deletion and capacity release must never be blocked by collection).
4. **Access follows existing primitives:** CHAT can retrieve everything; WORK agents only
   parent↔child edges.
5. **No redaction** at rest or at retrieval (may be added later). No retention policy:
   entries carry timestamps so unneeded runs can be deleted manually later.
6. **No config schema.** Blacklist and cap are hardcoded constants. Artifacts root is an
   environment variable (same pattern as `KAENO_DB` / `KAENO_SKILL_CACHE`).

## Captured per run (the triad + trace)

1. **Workspace + home capture** — a copy of `/workspace` and `/home/agent`, blacklist-filtered.
2. **envd request log** — every execution request the orchestrator made into the sandbox:
   method, handle, timestamps, durations (new in `EnvironmentServer`).
3. **Sandbox pod logs** — fetched via `pods/log` immediately before `deletePod`.
4. **Orchestrator trace stream** — `AgentTraceLogger`'s events for the run, written to a
   durable per-run file in addition to the console (context already carries
   `conversationId`/`taskId`/`workId`/`sandbox.pod`).
5. **Workspace manifest** — flat text listing (path, size, mtime; `git status` snapshot if
   the workspace is a repo). Cheap "what actually changed" signal that survives even when
   the capture itself is truncated at the cap.

## Blacklist (hardcoded)

Never captured, at any depth:

- `**/node_modules`
- `**/.venv`, `**/__pycache__`, `**/.cache`, `**/.npm`, `**/target`
- `**/.git`
- `/workspace/.agents/skills` (`SKILL_ROOT`) — materialized skill trees; recorded via
  `treeHash` in the work blueprint and re-derivable from the skill cache
- `/home/agent/.ssh` — credentials, never persisted

## Cap

- **64 MiB per run**, hardcoded, enforced **streaming at ingest**: the collector counts
  bytes and stops at the cap, marking the capture `truncated: true` in the manifest.
  The sandbox is never trusted to respect any limit; worst-case abuse costs exactly
  64 MiB of node disk.

## Data flow

### Normal teardown (`SandboxManager`)

Existing sequence is extended with one step, keeping all failure independence:

1. (existing) `env.cleanup()` — unchanged, keeps its own 5s abort guard
2. **collect artifacts** — no timeout; pull pod logs, pull envd request log, stream the
   blacklisted tar from envd; write into the `ArtifactStore`
3. (existing) `client.deletePod(pod)`
4. (existing) `capacity.releaseSandbox(pod)`

A collection failure records whatever partial evidence arrived (manifest says so) and
still proceeds to deletion and release. A hung collection self-terminates when the pod's
own deadline kills envd.

### Orphan sweep (`sweepOrphanedSandboxes`)

For each orphaned pod that still exists: run the same collection step, then delete.
For pods already gone: skip silently — no manifest entry, nothing recorded.

## Storage

### Layout

```
$KAENO_ARTIFACTS (default: /var/lib/kaeno/artifacts)
└── work-<workId>/task-<taskId>/
    ├── manifest.json
    ├── trace.log            # orchestrator-side trace events for this run
    ├── pod.log              # sandbox container logs
    ├── envd.log              # envd request log
    ├── workspace-manifest.txt
    └── workspace/…          # extracted capture tree (blacklist applied)
    └── home/…               # extracted capture tree (blacklist applied)
```

- envd streams a single `tar.gz`; the orchestrator extracts it into the run directory
  (kept as an extracted tree so retrieval needs no untar step; the cap bounds total size).
- `KAENO_ARTIFACTS` is set in the deployment; the directory lives on a PVC.
  Sandboxes never mount it — their channel is upload-only via envd.

### Manifest

`manifest.json` (and a mirrored row in the durable store so artifacts join into the
existing delegation tree):

- identity: `workId`, `taskId`, `conversationId`, `pod`, `template`
- capture: included roots, blacklist hits skipped count, `truncated`, `bytes`
- timestamps: `createdAt`, `finishedAt` (for later manual cleanup)
- envd request-log and pod-log availability status

Because the tree is already first-class in the durable store (frozen blueprints,
parent↔child edges, admitted reports, `WorkView`, pod annotations
`kaeno.io/conversation` / `kaeno.io/task`), manifest rows need **zero new bookkeeping**
to answer "which run, under which parent, from which conversation" at any depth.

## API surface & access rules

Consistent with the existing URL scheme:

- `GET /v1/threads/:key/work` — existing listing; each `WorkView` gains an `artifacts`
  summary (present, truncated, byte count).
- `GET /v1/threads/:key/work/:workId/artifacts` — manifest + file listing for the run.
- `GET /v1/threads/:key/work/:workId/artifacts/<path>` — file content (text bodies
  served as text, anything else base64 or raw with content type).

Access: enforced at retrieval — the CHAT root may read everything; a WORK agent may
read only its own and its children's runs (parent↔child edges only, matching the
existing communication topology). Sibling runs are invisible to each other.

## Changes per module

1. `src/artifacts/` (new) — `ArtifactStore`: run directory creation, manifest
   read/write, durable-store rows, path-scope checks; `BLACKLIST` constant.
2. `src/execution/envd.ts`, `codec.ts`, `dispatch.ts`, `remote-env.ts` —
   append-only request log in `EnvironmentServer`; new `collect` RPC streaming the
   blacklisted tar with byte cap; client-side collection call.
3. `src/sandboxes/sandbox-manager.ts` — teardown collection step (no timeout,
   failure-independent); pass results to `ArtifactStore`.
4. `src/sandboxes/k8s.ts` — `getPodLog(name)` on `SandboxClient` (homelab RBAC already
   grants `pods/log get`); no-op in the in-memory test cluster.
5. `src/agents/agent-logs.ts` — durable trace sink per run (second destination for the
   existing logger; no console change).
6. `src/agents/agents.ts` — orphan sweep: collect before delete, skip silently if gone.
7. `src/work/work.ts` + `src/api/api.ts` — artifacts summary in `WorkView`/reports;
   the two retrieval endpoints above with access enforcement.
8. Homelab `apps/kaeno/` — new `kaeno-artifacts` PVC (`local-path`, 10Gi), mount in the
   orchestrator deployment, `KAENO_ARTIFACTS` env. No sandbox mounts, no RBAC change.

## Shipping

The `collect` RPC changes the envd protocol, but orchestrator and sandbox ship atomically
(`publish-images.yml` pins the sandbox digest into the kaeno image), so there is no
compatibility window.

## Testing & the self-test rig

- Unit: blacklist filtering, cap truncation, manifest schema, path-scope enforcement.
- Integration (existing in-memory cluster + real envd processes): teardown collection,
  partial-failure independence, orphan sweep both branches.
- The self-test rig runs the same modules with local processes, so a nested run's
  artifacts land in the same store shape — the agent debugging its own test run uses
  the exact primitive it has in production.

## Sequencing (vertical slices)

1. `src/artifacts/` store + blacklist + manifest (+ unit tests)
2. envd request log + `collect` RPC (+ integration test with real envd)
3. `SandboxManager` teardown + pod logs + orphan sweep
4. Durable trace sink
5. `WorkView`/API surface + access enforcement
6. Homelab PVC/deployment manifests
