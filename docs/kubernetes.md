# Kubernetes worker extension

The optional Kubernetes extension is an alternative to Docker containers and microsandbox microVMs for worker execution. It is not a `kubectl` tool and grants agents no Kubernetes API access. It composes through `KaenoExtension` and `WorkEnvironment`; all Kubernetes implementation details live in `src/extensions/kubernetes/`.

## Configure

Run the Kaeno host inside the cluster, where it can reach sandbox pod DNS. Build/publish the current Dockerfile as an image your cluster can pull. Create an owner-controlled configuration file:

```json
{
  "namespace": "kaeno",
  "owner": "personal",
  "image": "ghcr.io/YOUR-OWNER/kaeno:YOUR-TAG",
  "resources": {
    "requests": { "cpu": "100m", "memory": "128Mi" },
    "limits": { "cpu": "1", "memory": "1Gi" }
  }
}
```

Select it in the owner configuration (`KAENO_CONFIG`):

```json
{
  "execution": {
    "provider": "kubernetes",
    "configFile": "./kubernetes.json"
  }
}
```

This is a fragment alongside the existing agent/source configuration. `configFile` resolves relative to that owner file. Start with `npm start`. The CLI selects Kubernetes explicitly through this field; omitted `execution` defaults to Docker. See [execution configuration and switching](execution.md). No cluster credentials are needed when Kubernetes is disabled. Agent and skill selection come from the same `KAENO_CONFIG` in both cases; only the source cache path/storage differs. Mount its `sourceDirectory` on the host (for example, a PVC at `/sources`), never into worker pods. The independent GitHub App reader/tools work with either backend.

`owner` must be a stable, unique DNS label (maximum 32 characters) for this application/database. Never share it between independent databases, including database clones. Pod names are `<owner>-work-<workId>`.

Optional configuration:

| Field              | Default                                                | Purpose                                                      |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------ |
| `api`              | `https://kubernetes.default.svc`                       | API origin, without credentials or a URL path                |
| `tokenFile`        | `/var/run/secrets/kubernetes.io/serviceaccount/token`  | Host-only bearer token; reread on every request for rotation |
| `caFile`           | `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` | API CA certificate; `null` uses system trust                 |
| `quota`            | `kaeno-sandbox`                                        | Sandbox ResourceQuota name                                   |
| `service`          | `kaeno-sandbox`                                        | Headless Service for sandbox DNS                             |
| `serviceAccount`   | `kaeno-sandbox`                                        | Unprivileged sandbox service account                         |
| `runtimeClassName` | none                                                   | RuntimeClass for sandbox pods, e.g. `kata-qemu` for microVMs |
| `readyTimeoutMs`   | `240000`                                               | Maximum pod readiness wait                                   |

Credential paths resolve relative to the configuration file. HTTPS verifies the configured CA; TLS verification is never disabled. HTTP exists for local API fixtures/proxies and should not be used across untrusted networks. API calls have a 30-second timeout. API error bodies are not surfaced, because Kubernetes can echo submitted environment secrets.

## Cluster prerequisites

Review and adapt [`src/extensions/kubernetes/cluster.yaml`](../src/extensions/kubernetes/cluster.yaml). It provides an example of:

- Host service account and namespace-local RBAC: get/list/create/delete pods, get ResourceQuotas. No exec, patch, secrets, cluster-wide access, or quota administration.
- Unprivileged sandbox service account, with token automount disabled.
- Headless `kaeno-sandbox` Service, exposing port 7070.
- A `Terminating`-scoped ResourceQuota. Sandbox pods have `activeDeadlineSeconds`; the long-running host must not, so it is not charged to this quota.
- Sandbox NetworkPolicy: host-only ingress on 7070, cluster DNS, and public IPv4 egress excluding private/link-local ranges.

Create the namespace separately. Set the host Deployment's `serviceAccountName` to `kaeno-kubernetes-host` and label its pod `app.kubernetes.io/name: kaeno`. Mount the configuration file and durable SQLite storage on the host. Adapt DNS labels, private pod/service CIDRs, metadata endpoints, CNI-specific behavior, and permitted egress for your cluster before applying the example. NetworkPolicy requires an enforcing CNI; pod security settings alone do not provide network isolation. The extension does not create infrastructure, grant RBAC, or alter network policy.

Disable automatic sidecar injection for sandbox pods: identity checks and quota arithmetic assume exactly one execution container. The sandbox image must run `/app/src/host/envd.ts` with Node.js and support UID/GID 1000, as the current Dockerfile does. Configure image-pull credentials on the sandbox service account if needed. Those registry credentials are for the kubelet, not environment variables available to agents.

## MicroVM isolation with Kata Containers

[Microsandbox](microsandbox.md) runs microVMs in-process on one host and has no remote API, so it cannot schedule across a cluster. To get the same per-work kernel boundary on Kubernetes, run sandbox pods under a [Kata Containers](https://katacontainers.io) RuntimeClass. Everything else in this backend stays the same, including scheduling, the headless Service, NetworkPolicy, quota, readiness and reconciliation.

1. Install Kata on the nodes that have `/dev/kvm` (bare metal, or VMs with nested virtualization), for example with [kata-deploy](https://github.com/kata-containers/kata-containers/tree/main/tools/packaging/kata-deploy). It labels capable nodes `katacontainers.io/kata-runtime=true` and creates RuntimeClasses such as `kata-qemu` whose `scheduling.nodeSelector` targets those nodes. Check with `kubectl get runtimeclass`.
2. Apply the RuntimeClass ClusterRole/ClusterRoleBinding from `cluster.yaml`, listing every name you configure in `resourceNames`. It grants `get` on those RuntimeClass objects only.
3. Set `"runtimeClassName": "kata-qemu"` in `kubernetes.json`.

Behavior and caveats:

- **Mixed clusters:** the RuntimeClass's node selector places sandbox pods only on Kata nodes. Kaeno does no node selection itself. If no Kata node can schedule a pod, it stays Pending and fails at `readyTimeoutMs`. The Kaeno host pod uses the default runtime and can run on any node.
- **Quota:** ResourceQuota charges the RuntimeClass `overhead.podFixed` on top of container requests and limits. Kaeno reads it alongside the quota on each admission, so capacity reflects both. A configured RuntimeClass that is missing is a configuration error.
- **Identity:** `runtimeClassName` is part of the saved target, and adoption requires a pod's `spec.runtimeClassName` to match. Switching between runc and Kata with unfinished work is rejected, just like other target changes. Configurations that do not set it keep their previous identity.
- **Image architecture:** Kata runs the same OCI image. It must match the Kata nodes' architecture, and the published GHCR image is linux/amd64 only.
- **Network:** Kata pods keep the host-side pod network interface, so NetworkPolicy still applies. Verify this with your CNI.
- **Verify** that a sandbox really ran in a VM: `kubectl get pod <pod> -o jsonpath='{.spec.runtimeClassName} {.spec.overhead}'`, and compare `uname -r` inside the worker with the node's kernel.

## Lifecycle and capacity

- The extension durably saves each work's pod name, random environment token, image, and FIFO reservation before creating external resources.
- Capacity is the minimum of `floor(quota / per-pod charge)` across pods, CPU requests/limits, and memory requests/limits. Quantities use integer arithmetic, including binary memory units and millicores. An invalid quota, unsupported ephemeral-storage bound, or quota fitting no pod fails with a configuration error.
- WORK reads the environment's optional generic `capacity()` at admission. The lesser of that limit and `KAENO_WORK_MAX_CONCURRENT` bounds unfinished work. Admission is serialized in WORK's existing transaction, preventing parents from holding every slot while waiting for children. Quota edits apply to new admissions without restart; successful tool-call replay does not reread capacity.
- The extension also maintains a durable FIFO reservation queue, counts physical foreign sandbox pods, and reserves slots before POSTing. Kubernetes remains the authority if another workload consumes quota.
- Quota-related POST rejection gets at most five attempts with four one-second waits. Other errors, including POST 404, fail immediately. Failed WORK cleanup releases reservations; persistent quota rejection also releases its uncreated reservation immediately.
- Pods must become Ready within four minutes by default. Image/configuration failures, failed/completed pods, terminating pods, and disappeared pods fail promptly. Waiting and API calls respect cancellation.
- Retries adopt only matching owner/work/conversation/token-hash/image identities. A POST conflict is followed by identity validation, not blindly treated as success. A saved image is retained across restarts even if the configured image changes for new work.
- Release is repeatable. It requests deletion, waits up to ten seconds, and only frees capacity once the pod is absent. Slow deletion retains the reservation for later reconciliation.
- Startup and the existing periodic WORK reconciler remove terminal reservations and owner-scoped orphan pods, while retaining live work. Task liveness is rechecked to avoid sweeping work admitted after the original live-work scan.

Pods run non-root with a read-only root filesystem, dropped capabilities, no privilege escalation, runtime-default seccomp, bounded writable workspace/home/tmp volumes, no service-account token, and a four-hour lifetime backstop. Only the per-work environment token enters the pod; cluster and GitHub App credentials stay on the host.

## Embedding

```ts
const kubernetes = kubernetesExtension({
  namespace: "kaeno",
  owner: "personal",
  image: "your-image:tag",
  resources: {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "1", memory: "1Gi" },
  },
  readToken: () => readFile(tokenPath, "utf8"),
  ca: await readFile(caPath, "utf8"),
  createEnvironment: ({ url, token, id, cwd }) =>
    new RemoteExecutionEnv(url, token, id, cwd, fetch),
});

await openKaeno({
  ...configuration,
  extensions: [...configuration.extensions, kubernetes.extension],
  work: { ...configuration.work, environment: kubernetes.environment },
  storage,
  models,
});
```

Install `kubernetesExecutionProvider` for generic host selection, or import `kubernetesExtension` or `loadKubernetesConfiguration` directly from `src/extensions/kubernetes/index.ts`. For file-backed loading, call `loadKubernetesConfiguration(path, { defaultNamespace, createEnvironment, createSandboxEnvironment })`; it implements the shared `ExecutionConfigurationLoader` contract and returns `{ environment, extensions }`. The Kubernetes file owns its explicit `owner`, so it does not use the fallback namespace or the shared `createSandboxEnvironment` factory. Embedders still supply both as part of the common loader context. Its schema, credential paths, defaults and construction remain inside the extension. The API client, pod schemas/specs, quantity parser, and reservation documents are not exported. Execution transport is injected by composition rather than constructed across feature boundaries.

## Boundary choice

Two designs were compared: implement the generic `SandboxProvider`, or implement `WorkEnvironment` directly. The latter keeps durable quota reservations beside the Kubernetes lifecycle without threading the work runtime through the provider interface. The public factory returns only a native extension and a work environment. Optional `capacity(context)` lets any environment supply a live admission limit; WORK retains its existing transactional admission/counting responsibility. The required stable `identity` also lets WORK reject a changed execution backend/target before recovery resumes. No Kubernetes types or imports enter core.

## Differences from the old `main` implementation

The sandbox lifecycle, quota sizing, admission deadlock prevention, retry bounds, readiness checks, and orphan cleanup are retained. The new implementation uses the current extension/WORK interfaces rather than restoring the old application, agent factory, or sandbox-manager dependencies.

- Skills remain available through the current saved-binding skill tools. The removed skill-cache PVC/init-container materialization is not restored.
- GitHub authentication remains in the independent GitHub App extension. Old SSH/API secrets are not mounted into worker pods.
- The removed artifact archive and `/collect` protocol are not restored by this backend. Worker tools still read/write files through the existing execution protocol; pod/workspace evidence must be collected before deletion if an independent evidence extension is added.
- Workspace volumes are ephemeral, as on old `main`: deleting/recreating a pod loses its files. Restart adoption preserves files only while the original pod survives. There is no pod-loss restoration or migration from the old database.

Do not switch execution backends with unfinished work. Drain/cancel work and back up SQLite first. A database that has recorded Kubernetes state rejects changes to its cluster, namespace, owner, resource sizing, quota, Service, or sandbox service account rather than silently adopting different resources; use the original configuration or a deliberately fresh database. Live edits to the quota itself remain supported.

Integration tests use a simulated Kubernetes API, real SQLite reopen, a real local HTTP API transport, and the real remote execution server. Live-cluster scheduling, TLS, image pulling, DNS and CNI enforcement still require deployment verification against your cluster.

## Live smoke test

`npm run smoke:kubernetes` runs the WORK smoke test inside your cluster. It uses the current kubectl context:

```sh
KAENO_K3S_SSH=user@node npm run smoke:kubernetes            # uses kubernetes.config.example.json
KAENO_K3S_SSH=user@node npm run smoke:kubernetes -- ./my-kubernetes.json
```

1. It builds this checkout as `kaeno:local` for `linux/amd64`. Set `KAENO_PLATFORM` for another architecture, or `KAENO_SKIP_BUILD=1` to reuse an existing build.
2. It imports the image with `k3s ctr images import` over SSH. Leave `KAENO_K3S_SSH` unset when the node can already pull the image, and change `image` in the backend file to match.
3. It checks the `cluster.yaml` prerequisites in the `kaeno` namespace.
4. It runs [`scripts/kubernetes-smoke.yaml`](../scripts/kubernetes-smoke.yaml) as a Job. The Job uses the host service account and the host label, so the sandbox NetworkPolicy lets it in. `scripts/work-smoke.ts` and the backend file are mounted from a ConfigMap.
5. It prints the Job logs and exits non-zero if the Job fails.

Set `KAENO_HOST_SERVICE_ACCOUNT` when your host runs under a service account other than `kaeno-kubernetes-host`. That account also needs the RuntimeClass ClusterRole binding when Kata is enabled. The Job pod has a deadline, so it temporarily takes one slot in the `Terminating` sandbox quota rather than competing with the long-running host.

The model is simulated, so no model credentials are needed. A worker runs a shell command in a real sandbox pod, and the test checks Linux, UID 1000 and `/workspace`. It also prints `uname -r`: under Kata that shows the guest kernel, not the node's. The example file uses the dedicated owner `kaeno-smoke` and `runtimeClassName: kata-qemu`. Remove `runtimeClassName` to test plain runc pods. Never use an active application's owner: the test reconciles that owner's sandbox pods away.
