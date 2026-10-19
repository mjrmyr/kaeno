# Disposable infrastructure tests

The default `npm run verify` remains Node-only: static checks, unit tests and simulated integration tests. It does **not** start Docker or Kubernetes, and passing it does not prove either backend works against real infrastructure.

```sh
npm ci
npm run verify
npm run test:docker
npm run test:kubernetes
npm run verify:all # runs the three commands above, in order; stops on failure
```

No model/API credentials are required. The existing `scripts/work-smoke.ts` faux provider supplies deterministic model decisions; Docker/Kubernetes, worker processes, shell/file tools, SQLite and HTTP execution transport are real. The normal image entrypoint is checked separately, without submitting a model turn. Do not supply production configuration or credentials.

## Prerequisites and safety

- Node.js 24+, npm, and a running **local** Docker daemon/CLI. The suites deliberately ignore `DOCKER_CONTEXT` and default to `unix:///var/run/docker.sock`. Rootless/Desktop users can explicitly set `DOCKER_HOST=unix:///path/to/local/docker.sock`. Remote/TCP Docker endpoints are refused rather than risking a homelab daemon.
- The Kubernetes suite additionally needs kind v0.27.0 and kubectl v1.32.2. CI installs those versions and checks the release checksums. See the harness for the pinned kind node image.
- Enough disk/memory to build the current Dockerfile, and Internet access for its base image, npm/apt dependencies and kind node image.
- Missing prerequisites are errors (nonzero exit), never silent skips. These are opt-in integration suites, not unit tests with an optional backend.
- Use only a disposable local development/CI machine. The suites create unique resource names, never deploy to the developer's Kubernetes context, and never modify homelab configuration.

## Docker scope

`test:docker` builds the **current Dockerfile** under a unique tag and records its image ID. It then:

1. Runs that image's normal CMD as its default non-root user, mounts the local credential-free profile read-only, and mounts a writable named volume at `/data`.
2. Polls `/healthz`, exercises the threads/replies API, checks SQLite exists, restarts the container and checks the durable conversation list is unchanged.
3. Reuses `work-smoke.ts` to delegate real worker work with the exact local image: shell execution, shell file write/read, coding `write`/`read` tool roundtrip, and a single report delivered to the parent. The driver reopens SQLite and checks thread/reply state survived unchanged.
4. Asserts the completed worker container **and named workspace volume** are gone.
5. Re-instantiates the Docker provider with the same identity, verifies it adopts the same live container and workspace rather than duplicating them, and checks repeated removal is safe.

A fresh volume uses `KAENO_SOURCE_MODE=refresh` with local definitions only (no repository/network acquisition); `offline` is valid only after that first verified cache publication. The normal image contains neither the fixture nor a test-specific entrypoint; the harness mounts the fixture.

The deterministic orchestration host runs in the local Node process, while workers run in Docker. A separate normal-CMD container proves image packaging/startup/config/API/storage. This does **not** claim that the normal host image can itself drive Docker: the Docker CLI/socket are not included or mounted into that image by this suite. Kubernetes orchestration runs in-cluster in its own suite.

## Kubernetes scope

`test:kubernetes` builds a separate uniquely tagged image from the current Dockerfile, creates a uniquely named kind cluster with **kindest/node:v1.32.2**, and loads that exact local tag. Every kubectl invocation supplies the private temporary kubeconfig and explicit `kind-<unique-name>` context; kind commands also receive only that private kubeconfig. The developer's current context is never used or changed.

The suite creates `kaeno` inside that disposable cluster and applies the actual `src/extensions/kubernetes/cluster.yaml` prerequisites, including its service accounts, RBAC, headless Service, quota and NetworkPolicy. Fixture and driver files use individual ConfigMap `subPath` mounts: whole-directory projections introduce symlinks rejected by definition acquisition and can change Node entrypoint import resolution. Separate PVC-backed pods check (a) the image's normal entrypoint/config/API/writable SQLite, using the actual host service account, and (b) the existing faux-model driver running **in-cluster**. The driver creates a real WORK pod and exercises shell/file execution, delivery and completed-work SQLite reopen. A bounded observation gate lets the harness inspect the live worker deterministically before it exits, avoiding a timing-dependent short-lived-pod assertion.

Assertions cover host pod creation and quota-read RBAC; denial of Secrets, pod exec and quota mutation; lack of worker pod/Secrets permissions; the worker's exact image tag, sandbox service account, disabled token automount and lack of Secret/projected volumes and the actual absence of a service-account token file in the worker shell; and completed worker pod removal. Cluster deletion is followed by checks for remaining kind clusters/node containers. The driver/normal-host PVCs disappear with the disposable cluster.

The default kind CNI is intentionally retained for this first happy-path increment. Applying NetworkPolicy is **not** an enforcement assertion; the suite prints that security testing is deferred. There are no claimed unrelated-pod denial, worker DNS, or quota-admission assertions.

## Diagnostics and cleanup

By default each run writes `artifacts/<suite>-<unique-id>/` (override the parent directory with `KAENO_TEST_ARTIFACTS`). Logs, status/results and the built-image identity are retained even on failure. Kubernetes additionally collects pod status/descriptions and events. CI uploads diagnostics on job failure for seven days.

```sh
npm run test:docker -- --keep
npm run test:kubernetes -- --keep
KAENO_TEST_ARTIFACTS=/tmp/kaeno-diagnostics npm run test:docker
```

`--keep` retains a **failed** environment for debugging; success is always cleaned up. The command prints unique names/paths to remove afterward. Without `--keep`, cleanup runs on success, assertion failure, SIGINT and SIGTERM. Cleanup/leak failures also produce a nonzero exit. Each rerun has independent names and does not reuse a prior failed environment. SIGKILL, a crashed Docker daemon, or a killed CI machine cannot execute in-process cleanup; use the printed resource names to remove those leftovers manually.

Kubeconfig/client keys, bearer-token environment dumps, authentication files and SQLite databases are not diagnostics to upload. Test SQLite/private configuration live separately from uploaded artifacts. Logs contain only the credential-free fixture and deterministic test task outputs. Do not point the harness at real credentials or inject secrets into test task output.

## Deliberate incremental coverage

This is the first real-backend slice, not a comprehensive reliability or security certification. The following still require follow-up real-infrastructure tests:

- Restart/crash of an orchestration host **while work is running**, adoption through durable WORK state, and proof of no duplicated execution/report. The current Docker adoption check is provider re-instantiation; completed-work SQLite reopen and idle normal-host restart are separate checks, not substitutes.
- Cancelling a running WORK task and proving prompt removal of its container/pod and descendants.
- Kubernetes quota rejection/admission under concurrent work and held reservations.
- Enforced Kubernetes network isolation, worker DNS, and an unrelated pod denied access. Default kind networking does **not** prove NetworkPolicy enforcement. Such assertions need a pinned enforcing CNI (for example Calico), not merely applying the production NetworkPolicy manifest.
- Production model providers/credentials, remote registries, homelab DNS/TLS/CNI and production deployment.

The CI workflow defines jobs on PRs and pushes to `main`; it does not configure required branch-protection checks. Repository administration is outside this task's permissions.

Implementation decisions follow **Make Operations Idempotent**: unique ownership scopes, adopting stable identities, repeated removal and post-cleanup leak assertions. Reusing the deterministic smoke driver instead of creating a parallel fake integration path keeps the verification surface small.
