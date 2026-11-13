# Kubernetes extension

The Kubernetes extension also provides independent [privacy-filtered read-only observation](kubernetes-observation.md), available with any execution backend. The rest of this page describes worker execution.

The optional Kubernetes execution capability is an alternative to Docker containers and microsandbox microVMs for worker execution. It is not a `kubectl` tool and grants agents no Kubernetes API access. It composes through `KaenoExtension` and `WorkEnvironment`; all Kubernetes implementation details live in `src/extensions/kubernetes/`.

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

`owner` must be a stable, unique DNS label (maximum 32 characters) for this application/database. Never share it between independent databases, including database clones. Pod names are `<owner>-work-<workId>`. Workspace PVC names are `<owner>-workspace-<conversationId>`: the ticket's conversation, not its changing Assignment, owns storage.

Optional configuration:

| Field                        | Default                                                | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| `api`                        | `https://kubernetes.default.svc`                       | API origin, without credentials or a URL path                |
| `tokenFile`                  | `/var/run/secrets/kubernetes.io/serviceaccount/token`  | Host-only bearer token; reread on every request for rotation |
| `caFile`                     | `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` | API CA certificate; `null` uses system trust                 |
| `quota`                      | `kaeno-sandbox`                                        | Sandbox ResourceQuota name                                   |
| `service`                    | `kaeno-sandbox`                                        | Headless Service for sandbox DNS                             |
| `serviceAccount`             | `kaeno-sandbox`                                        | Unprivileged sandbox service account                         |
| `runtimeClassName`           | none                                                   | RuntimeClass for sandbox pods, e.g. `kata-qemu` for microVMs |
| `readyTimeoutMs`             | `240000`                                               | Maximum pod readiness wait                                   |
| `workspace.size`             | `5Gi`                                                  | PVC request; positive integral Ki/Mi/Gi/Ti quantity          |
| `workspace.storageClassName` | cluster default                                        | StorageClass for new workspaces, e.g. `local-path` on k3s    |

Credential paths resolve relative to the configuration file. HTTPS verifies the configured CA; TLS verification is never disabled. HTTP exists for local API fixtures/proxies and should not be used across untrusted networks. API calls have a 30-second timeout. API error bodies are not surfaced, because Kubernetes can echo submitted environment secrets.

## Cluster prerequisites

Review and adapt [`src/extensions/kubernetes/cluster.yaml`](../src/extensions/kubernetes/cluster.yaml). It provides an example of:

- Host service account and namespace-local RBAC: get/list/create/delete pods, get ResourceQuotas, and get/create/delete PersistentVolumeClaims. No exec, patch, secrets, cluster-wide access, or quota administration.
- A dynamic storage provisioner and a default StorageClass, or explicit `workspace.storageClassName`. `WaitForFirstConsumer` classes are supported: Kaeno creates the pod before waiting for storage binding through pod readiness. Local-path storage is node-local and cannot survive loss of that node/disk. PVCs are not backups; actual durability depends on the storage provider. Operators may set a separate namespace storage/PVC quota; the Terminating-scoped compute quota does not bound retained PVCs.
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

- The extension durably saves each work's pod name, random environment token, image, and FIFO reservation before creating external resources. A separate conversation-scoped workspace record saves the PVC name, random ownership marker, observed PVC UID, and current Assignment holder. `/workspace` mounts that PVC and is both the working directory and `$HOME`. Tools' home-directory configuration and caches therefore live beneath the same persistent root; the agent owns its layout. There is no separate home mount. `/tmp` remains a disposable per-pod `emptyDir`.
- Ticket suspension removes the pod and frees capacity while retaining the PVC. The next Assignment mounts the same PVC with a new execution pod/token. Child WORK releases both pod and PVC. Retained ticket conversations keep storage across host restart; ticket end makes it eligible for the periodic sweep. Storage cleanup never bypasses failed pod deletion.
- Capacity is the minimum of `floor(quota / per-pod charge)` across pods, CPU requests/limits, and memory requests/limits. Quantities use integer arithmetic, including binary memory units and millicores. An invalid quota, unsupported ephemeral-storage bound, or quota fitting no pod fails with a configuration error.
- WORK reads the environment's optional generic `capacity()` at admission. The lesser of that limit and `KAENO_WORK_MAX_CONCURRENT` bounds unfinished work. Admission is serialized in WORK's existing transaction, preventing parents from holding every slot while waiting for children. Quota edits apply to new admissions without restart; successful tool-call replay does not reread capacity.
- The extension also maintains a durable FIFO reservation queue, counts physical foreign sandbox pods, and reserves slots before POSTing. Kubernetes remains the authority if another workload consumes quota.
- Pod quota-related POST rejection gets at most five attempts with four one-second waits. Other errors, including POST 404, fail immediately. Failed WORK cleanup releases reservations; persistent quota rejection also releases its uncreated reservation immediately.
- On entry to WORK supervision, pods must become Ready within four minutes by default. Image/configuration failures, failed/completed pods, terminating pods, and disappeared pods fail promptly. Supervision also polls the optional environment health check every five seconds while running or waiting for replies/children; confirmed sandbox loss fails the durable work and stops its conversation/subtree. Transient API/authentication errors are reported and retried, not interpreted as workspace loss. Waiting and API calls respect cancellation.
- Retries adopt only matching owner/work/conversation/token-hash/image/PVC-mount identities. PVC adoption checks owner/conversation/ownership-marker/UID and filesystem access mode. A missing previously observed PVC, a replacement UID, Lost storage or a terminating claim fails closed; it is never silently recreated empty. A POST conflict is followed by identity validation, not blindly treated as success. A saved image is retained across restarts even if the configured image changes for new work.
- Release is repeatable. It requests deletion, waits up to ten seconds, and only frees capacity once the pod is absent. Failed or slow deletion retains the reservation for later reconciliation; it does not block final report delivery or cancellation after the subtree is stopped.
- Startup and the 2½-minute WORK reconciler remove terminal reservations and owner-scoped orphan pods, while retaining live work and open-ticket PVCs. Unretained workspaces are deleted only after confirming their pods are gone and observing them unretained on two sweeps (normally within five minutes). This protects a new ticket that finishes between collecting the retained-conversation list and reading backend state; admission resets its retirement mark. PVC deletion uses a UID precondition, waits for absence, and retains durable tracking on failure. An older Assignment's cleanup cannot delete a newer holder's workspace. Each failed cleanup is isolated so other candidates still run; errors are aggregated and reported. Failed startup cleanup is reported and retried periodically rather than preventing task resumption. Task liveness is rechecked to avoid sweeping work admitted after the original live-work scan. A failed reservation release never falls through to orphan deletion, which would bypass its identity checks.

Pods run non-root with a read-only root filesystem, dropped capabilities, no privilege escalation, runtime-default seccomp, a requested workspace PVC size and a bounded writable tmp volume, no service-account token, and a four-hour lifetime backstop. PVC request size is not necessarily an enforced filesystem limit (notably with local-path); set storage-level limits/quota as appropriate. Only the per-work environment token enters the pod; cluster and GitHub App credentials stay on the host.

## Investigating retained or stopped worker pods

**Pod phase is not WORK status.** These are directly created `v1/Pod` objects, not Jobs. They have `restartPolicy: Never`, a four-hour `activeDeadlineSeconds`, no Kubernetes `ownerReferences`, and no TTL controller. The `kaeno.io/owner` label is application ownership, not a garbage-collection owner reference. The deadline stops execution; it does not delete the object. Adding `ttlSecondsAfterFinished` to a Pod is not a fix: that setting belongs to Jobs.

Kaeno calls `suspend` for ticket roots and `release` for child work on final reporting and cancellation. Suspension deletes execution pods but keeps ticket workspace PVCs. It also reconciles once at startup (before resuming tasks), then every 2½ minutes. Reconciliation uses **durable task liveness**, not container phase: it does not directly delete an unfinished work's Pod. Instead, the work's supervisor detects confirmed sandbox loss, stops its conversation and descendants, and delivers a failed report. Once the task settles, reconciliation can retry any failed cleanup. It rechecks tasks absent from the initial scan before treating them as orphans. A retained terminal Pod can therefore indicate pending cleanup, a failed health API request, or work not yet settled; inspect the task and logs. Reservations remain held until deletion is confirmed, reducing available admission capacity.

The worker container runs an execution server, not the assistant orchestration. `Completed` in `kubectl get pods` describes container termination, not a delivered assistant report. Health supervision remains active while waiting for a reply or children and while a conversation/tool invocation is busy. A stopped, terminating or missing previously ready Pod fails the current work rather than replaying in-flight commands. Its PVC remains for a later Assignment of the ticket. On restart, an existing terminal Pod fails readiness. Before a pod has ever become ready and been exposed to tools, admission can reconcile a lost PVC/pod creation response; once ready is recorded, a missing execution pod is not silently restarted. Filesystem persistence does not imply resumable running processes or exactly-once external effects.

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
for VERB in get create delete; do
  kubectl auth can-i "$VERB" persistentvolumeclaims -n "$NS" --as="system:serviceaccount:$NS:$SA"
done
# If runtimeClassName is configured:
kubectl auth can-i get runtimeclasses.node.k8s.io/kata-qemu --as="system:serviceaccount:$NS:$SA"
```

### Reports and cleanup errors

The final report phase stops children and aborts the worker conversation before retirement. It then durably delivers the report and commits the terminal task outcome **before** attempting resource deletion. Cancellation similarly commits its terminal outcome after subtree shutdown and report withdrawal, before deletion. Thus **even a stuck cleanup backend cannot prevent durable report delivery or cancellation**. Failed GET/DELETE, identity mismatch, target mismatch, or a Pod still present after the ten-second deletion wait is reported through `onReport` (`harness:` in the host); the saved reservation remains for reconciliation. Report delivery retains its existing durable deduplication keys. Conversation/subtree shutdown failures are not treated as harmless resource-deletion failures: work must not declare its subtree stopped while descendants can still run.

Each reconciliation candidate is isolated and failures are aggregated after the sweep, so one bad Pod does not starve unrelated cleanup. A failed startup sweep is reported and retried by the periodic timer; it does not block durable report recovery. Host shutdown stops health supervision, durable invocations and the cleanup timer; it does not delete all unfinished workers. Saved backend/target/binding incompatibilities still prevent startup before reconciliation. Restore the original configuration rather than bypassing identity checks.

The four-hour execution limit remains an intentional resource/security backstop while a pod exists. An idle ticket has no execution pod consuming that limit or compute quota. Confirmed sandbox termination fails and reports active work, including a work waiting with live children, then pod cleanup is retried; the ticket's workspace PVC remains. Jobs plus TTL would remove evidence without settling the durable task and would not restore ephemeral files. There is no automatic replay of commands or unbounded extension of the deadline. API outages can delay loss detection; they are logged and retried. A tool or external side effect already completed before detection is not rolled back.

For recovery, first preserve needed evidence and inspect the durable works. If no longer needed, cancel them through the authorized WORK interface and verify release/report delivery. Ending a ticket or disposing child WORK deletes its workspace PVC; obtain the user's authorization. Reclaiming the backing volume depends on the provisioner's reclaim policy. An aborted ticket Assignment retains storage while its ticket remains open. Do not add a phase-only sweeper, delete Pods wholesale, mutate SQLite, or switch RuntimeClass/backend to clear the symptom: these can lose active work or strand its report.

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

For ticket persistence, retaining idle execution pods was compared with conversation-scoped PVCs and disposable Assignment pods. PVCs preserve all workspace files, not only published Git state, while freeing execution quota and rotating tokens. This reuses core's existing `suspend(work, runtime)` and `reconcile(live, runtime, retainedConversations)` hooks. Backend-local per-conversation transition ordering and holder checks fence late cleanup; no GitHub-specific recovery or new core lifecycle abstraction is needed.

## Differences from the old `main` implementation

The sandbox lifecycle, quota sizing, admission deadlock prevention, retry bounds, readiness checks, and orphan cleanup are retained. The new implementation uses the current extension/WORK interfaces rather than restoring the old application, agent factory, or sandbox-manager dependencies.

- Skills remain available through the current saved-binding skill tools. The removed skill-cache PVC/init-container materialization is not restored.
- GitHub authentication remains in the independent GitHub App extension. Old SSH/API secrets are not mounted into worker pods.
- The removed artifact archive and `/collect` protocol are not restored by this backend. Worker tools still read/write files through the existing execution protocol; pod/workspace evidence must be collected before deletion if an independent evidence extension is added.
- Workspace files now live on a PVC rather than pod `emptyDir`. They survive normal ticket Assignment completion, host restart and replacement pods, subject to the storage provider. Home-directory files persist under `/workspace`; `/tmp` and running processes remain ephemeral. There is no migration of already-deleted workspace files or the old database.

Do not switch execution backends with unfinished work. Drain/cancel work and back up SQLite first. While any sandbox reservation remains, a database that has recorded Kubernetes state rejects changes to its cluster, namespace, owner, resource sizing, quota, Service, sandbox service account or RuntimeClass, rather than silently adopting different resources. Restore the original configuration until that work finishes. Workspace configuration is part of the target too, and retained PVCs pin it even with no running pods. Only once no reservations or workspaces remain does the next sandbox admission adopt a changed target. Live edits to the quota itself remain supported.

## Upgrading from ephemeral workspaces

Grant the new PVC permissions and configure a usable StorageClass before deploying. Drain unfinished work using the old version first: adding workspace configuration changes the saved execution identity, so old unfinished Assignments intentionally cannot resume under the new backend shape. Back up SQLite and any needed live workspace files before draining. Previously deleted `emptyDir` data cannot be recovered by this change. Existing idle tickets can obtain a persistent workspace on their next Assignment, but their earlier lost files are not backfilled. No application startup deploys RBAC, changes storage classes, or copies legacy pod files automatically.

Integration tests use a simulated Kubernetes API, real SQLite reopen, a real local HTTP API transport, and the real remote execution server. The file-persistence regression maps actual PVC mounts to separate on-disk directories, closes old execution servers on pod deletion, starts replacement servers, and reads an unpublished file after a new Assignment and host restart. Live-cluster scheduling, TLS, image pulling, DNS and CNI enforcement still require deployment verification against your cluster.
