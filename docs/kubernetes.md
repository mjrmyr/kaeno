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
- **Identity:** `runtimeClassName` is part of the saved target, and adoption requires a pod's `spec.runtimeClassName` to match. Switching between runc and Kata is rejected while sandbox reservations remain, just like other target changes; once work has drained, the next start adopts it. Configurations that do not set it keep their previous identity.
- **Image architecture:** Kata runs the same OCI image. It must match the Kata nodes' architecture, and the published GHCR image is linux/amd64 only.
- **Network:** Kata pods keep the host-side pod network interface, so NetworkPolicy still applies. Verify this with your CNI.
- **Verify** that a sandbox really ran in a VM: `kubectl get pod <pod> -o jsonpath='{.spec.runtimeClassName} {.spec.overhead}'`, and compare `uname -r` inside the worker with the node's kernel.

## Lifecycle and capacity

- The extension durably saves each work's pod name, random environment token, image, and FIFO reservation before creating external resources.
- Capacity is the minimum of `floor(quota / per-pod charge)` across pods, CPU requests/limits, and memory requests/limits. Quantities use integer arithmetic, including binary memory units and millicores. An invalid quota, unsupported ephemeral-storage bound, or quota fitting no pod fails with a configuration error.
- WORK reads the environment's optional generic `capacity()` at admission. The lesser of that limit and `KAENO_WORK_MAX_CONCURRENT` bounds unfinished work. Admission is serialized in WORK's existing transaction, preventing parents from holding every slot while waiting for children. Quota edits apply to new admissions without restart; successful tool-call replay does not reread capacity.
- The extension also maintains a durable FIFO reservation queue, counts physical foreign sandbox pods, and reserves slots before POSTing. Kubernetes remains the authority if another workload consumes quota.
- Quota-related POST rejection gets at most five attempts with four one-second waits. Other errors, including POST 404, fail immediately. Failed WORK cleanup releases reservations; persistent quota rejection also releases its uncreated reservation immediately.
- On entry to WORK supervision, pods must become Ready within four minutes by default. During this readiness check, image/configuration failures, failed/completed pods, terminating pods, and disappeared pods fail promptly. This is not continuous health monitoring while WORK waits for replies or children. Waiting and API calls respect cancellation.
- Retries adopt only matching owner/work/conversation/token-hash/image identities. A POST conflict is followed by identity validation, not blindly treated as success. A saved image is retained across restarts even if the configured image changes for new work.
- Release is repeatable. It requests deletion, waits up to ten seconds, and only frees capacity once the pod is absent. Slow deletion retains the reservation for later reconciliation.
- Startup and the existing periodic WORK reconciler remove terminal reservations and owner-scoped orphan pods, while retaining live work. Task liveness is rechecked to avoid sweeping work admitted after the original live-work scan.

Pods run non-root with a read-only root filesystem, dropped capabilities, no privilege escalation, runtime-default seccomp, bounded writable workspace/home/tmp volumes, no service-account token, and a four-hour lifetime backstop. Only the per-work environment token enters the pod; cluster and GitHub App credentials stay on the host.

## Investigating retained or stopped worker pods

**Pod phase is not WORK status.** These are directly created `v1/Pod` objects, not Jobs. They have `restartPolicy: Never`, a four-hour `activeDeadlineSeconds`, no Kubernetes `ownerReferences`, and no TTL controller. The `kaeno.io/owner` label is application ownership, not a garbage-collection owner reference. The deadline stops execution; it does not delete the object. Adding `ttlSecondsAfterFinished` to a Pod is not a fix: that setting belongs to Jobs.

Kaeno calls `release` on final reporting and cancellation. It also reconciles once at startup (before resuming tasks), then every five minutes. Reconciliation uses **durable task liveness**, not container phase: it retains a sandbox for every unfinished task, including `awaiting-reply` and `waiting-for-children`, even when the Pod is `Succeeded` or `Failed`. It rechecks tasks absent from the initial scan before treating them as orphans. Retained terminal Pods alone therefore do not prove the reaper stopped. Reservations for these tasks also remain held, reducing available admission capacity.

The worker container runs an execution server, not the assistant orchestration. `Completed` in `kubectl get pods` describes container termination, not a delivered assistant report. A reply to a paused WORK can reach its still-running supervision loop without another readiness check; calls to a stopped execution server can then fail. Supervision does not continuously detect sandbox loss while waiting. At a fresh supervision entry, an existing terminal Pod fails readiness instead of being replaced. A missing Pod can be recreated, but its `emptyDir` workspace is lost. A host restart is neither guaranteed repair nor a reason to delete unfinished work's Pods.

Check the work's authorized `list_work` / `inspect_work` view as well as the Pod. If an earlier work was awaiting a reply, distinguish forwarding that reply from receiving its final report. Work-result turns intentionally cannot start/message/cancel work; forwarding may need a real user turn. Do not interpret this assistant permission restriction as a Kubernetes error.

### Collect evidence before recovery

The following are read-only examples; adapt namespace, host label, owner and names to the deployment. Do not dump full Pod manifests: the sandbox spec contains its environment bearer token. Container logs and assistant reports may also contain sensitive task data; redact before sharing.

```sh
NS=kaeno
kubectl -n "$NS" get deploy kaeno -o jsonpath='{.spec.template.spec.serviceAccountName}{"\\n"}{.spec.template.spec.containers[*].image}{"\\n"}'
kubectl -n "$NS" get pods -l app.kubernetes.io/name=kaeno \
  -o custom-columns='NAME:.metadata.name,START:.status.startTime,RESTARTS:.status.containerStatuses[*].restartCount,IMAGEID:.status.containerStatuses[*].imageID'

for POD in kaeno-work-291 kaeno-work-312 kaeno-work-344; do
  kubectl -n "$NS" get pod "$POD" -o jsonpath='{.metadata.name}{"\\n"}{.metadata.uid}{"\\n"}{.metadata.creationTimestamp}{"\\n"}{.metadata.deletionTimestamp}{"\\n"}{.metadata.ownerReferences}{"\\n"}{.metadata.labels.kaeno\\.io/owner}{"\\n"}{.spec.runtimeClassName}{"\\n"}{.spec.activeDeadlineSeconds}{"\\n"}{.status}{"\\n"}'
  kubectl -n "$NS" get events --field-selector "involvedObject.name=$POD" --sort-by=.metadata.creationTimestamp
  kubectl -n "$NS" logs "$POD" -c envd --timestamps --tail=100
 done

kubectl -n "$NS" logs deploy/kaeno --since=12h --timestamps \
  | grep -E 'harness:|kaeno.work #(291|312|344):|environment unavailable|identity mismatch|still terminating|Kubernetes .*failed|task_failed|fetch failed'
kubectl -n "$NS" get resourcequota kaeno-sandbox
```

Record container `terminated.reason`, `exitCode`, `startedAt` and `finishedAt`, Pod reason/message, UID and events. `AGE` is object age, not time since completion. A later `Failed` observation must not be substituted for an earlier `Completed` observation: compare UIDs, timestamps and attempt history. Deadline expiry normally produces `Failed` / `DeadlineExceeded`; it is not established by `Completed`. `envd` explicitly exits zero on SIGTERM, but code alone does not identify what stopped a particular Pod. Events may already have expired. For a restarted host, also collect `kubectl logs <host-pod> --previous` if available.

Verify actual host RBAC (an operator needs impersonation permission for `--as`; a forbidden impersonation response does not establish the host's permissions):

```sh
SA=$(kubectl -n "$NS" get deploy kaeno -o jsonpath='{.spec.template.spec.serviceAccountName}')
for VERB in get list create delete; do
  kubectl auth can-i "$VERB" pods -n "$NS" --as="system:serviceaccount:$NS:$SA"
done
kubectl auth can-i get resourcequotas -n "$NS" --as="system:serviceaccount:$NS:$SA"
# If runtimeClassName is configured:
kubectl auth can-i get runtimeclasses.node.k8s.io/kata-qemu --as="system:serviceaccount:$NS:$SA"
```

### Reports and cleanup errors

The final report phase stops children, aborts the worker conversation, and **awaits environment release before delivering the report**. A failed GET/DELETE, identity mismatch, target mismatch, or Pod still present after the ten-second deletion wait can therefore leave a final report undelivered. Inspect the durable work phase and `harness:` / task-failure logs rather than assuming the report was sent because the model produced text. Delivery to a parent conversation or the chat outbox is another boundary after release.

The reconciliation pass also stops at its first error. Periodic errors are reported through `onReport` (`harness:` in the host); the timer remains scheduled, but later items can be starved by the same failing item on every pass. Startup reconciliation errors prevent task resumption. Host shutdown closes durable invocations and the timer; it does not delete all unfinished workers. Saved backend/target/binding incompatibilities can prevent startup before reconciliation. Restore the original configuration rather than bypassing identity checks.

For recovery, first preserve needed evidence and inspect the durable works. If no longer needed, cancel them through the authorized WORK interface and verify release/report delivery. Cancellation deletes ephemeral workspace data; obtain the user's authorization. Do not add a phase-only sweeper, delete Pods wholesale, mutate SQLite, or switch RuntimeClass/backend to clear the symptom: these can lose active work or strand its report. A policy for expiring paused work and handling dead sandboxes needs to settle/report the durable task as well as clean its resources.

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

Do not switch execution backends with unfinished work. Drain/cancel work and back up SQLite first. While any sandbox reservation remains, a database that has recorded Kubernetes state rejects changes to its cluster, namespace, owner, resource sizing, quota, Service, sandbox service account or RuntimeClass, rather than silently adopting different resources. Restore the original configuration until that work finishes. Once no reservations remain, nothing is tracked under the old target, and the next sandbox admission adopts the configured one. Live edits to the quota itself remain supported.

Integration tests use a simulated Kubernetes API, real SQLite reopen, a real local HTTP API transport, and the real remote execution server. Live-cluster scheduling, TLS, image pulling, DNS and CNI enforcement still require deployment verification against your cluster.
