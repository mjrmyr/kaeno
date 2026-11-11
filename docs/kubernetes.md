# Kubernetes worker extension

The optional Kubernetes extension is an alternative to Docker containers and microsandbox microVMs for worker execution. It is not a `kubectl` tool and grants agents no Kubernetes API access. It composes through `KaenoExtension` and `WorkEnvironment`; all Kubernetes implementation details live in `src/extensions/kubernetes/`.

Workers are declared as [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) `Sandbox` objects (`agents.x-k8s.io/v1beta1`). Kaeno owns the desired state of each Sandbox (exists, `Running` or `Suspended`, deleted); the agent-sandbox controller reconciles the Pod, headless Service and workspace PersistentVolumeClaim behind it. The host itself can be declared the same way.

## Configure

Run the Kaeno host inside the cluster, where it can reach sandbox Service DNS. Build/publish the current Dockerfile as an image your cluster can pull. Create an owner-controlled configuration file:

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

This is a fragment alongside the existing agent/source configuration. `configFile` resolves relative to that owner file. The CLI selects Kubernetes explicitly through this field; omitted `execution` defaults to Docker. See [execution configuration and switching](execution.md). No cluster credentials are needed when Kubernetes is disabled. Mount the source cache's `sourceDirectory` on the host, never into worker pods. The independent GitHub App reader/tools work with either backend.

`owner` must be a stable, unique DNS label (maximum 32 characters) for this application/database. Never share it between independent databases, including database clones. Sandbox names are `<owner>-conv-<conversationId>`.

Optional configuration:

| Field                        | Default                                                | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| `api`                        | `https://kubernetes.default.svc`                       | API origin, without credentials or a URL path                |
| `tokenFile`                  | `/var/run/secrets/kubernetes.io/serviceaccount/token`  | Host-only bearer token; reread on every request for rotation |
| `caFile`                     | `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` | API CA certificate; `null` uses system trust                 |
| `workspace.size`             | `5Gi`                                                  | Workspace PVC size per conversation (`Mi`, `Gi` or `Ti`)     |
| `workspace.storageClassName` | cluster default                                        | StorageClass for workspace PVCs                              |
| `quota`                      | `kaeno-sandbox`                                        | Sandbox compute ResourceQuota name                           |
| `serviceAccount`             | `kaeno-sandbox`                                        | Unprivileged sandbox service account                         |
| `runtimeClassName`           | none                                                   | RuntimeClass for sandbox pods, e.g. `kata-qemu` for microVMs |
| `readyTimeoutMs`             | `240000`                                               | Maximum sandbox readiness wait                               |

Credential paths resolve relative to the configuration file. HTTPS verifies the configured CA; TLS verification is never disabled. HTTP exists for local API fixtures/proxies and should not be used across untrusted networks. API calls have a 30-second timeout. API error bodies are not surfaced, because Kubernetes can echo submitted environment secrets.

## Cluster prerequisites

Install the agent-sandbox controller and CRD (the core `sandbox.yaml` is enough; the extensions for templates, claims and warm pools are not used):

```sh
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.2/sandbox.yaml
```

Then review and adapt [`src/extensions/kubernetes/cluster.yaml`](../src/extensions/kubernetes/cluster.yaml). It provides an example of:

- Host service account and namespace-local RBAC: get/list/create/patch/delete Sandboxes, get/list pods, get ResourceQuotas. No exec, secrets, pod creation, cluster-wide access, or quota administration.
- Unprivileged sandbox service account, with token automount disabled.
- A `Terminating`-scoped compute ResourceQuota. Sandbox pods have `activeDeadlineSeconds`; the long-running host must not, so it is not charged to this quota.
- A storage ResourceQuota bounding workspace PVCs, which outlive their pods while a conversation is suspended.
- Sandbox NetworkPolicy: host-only ingress on 7070, cluster DNS, and public IPv4 egress excluding private/link-local ranges.
- The Kaeno host as a `Sandbox` named `kaeno`: one stable pod labelled `app.kubernetes.io/name: kaeno` with service account `kaeno-kubernetes-host`, a `data` PVC for SQLite at `/data`, the `kaeno-config` ConfigMap at `/config`, and `failedPodPolicy: Recreate` so the controller replaces a failed host pod.

Create the namespace and the `kaeno-config` ConfigMap separately. Adapt DNS labels, private pod/service CIDRs, metadata endpoints, CNI-specific behavior, and permitted egress for your cluster before applying the example. NetworkPolicy requires an enforcing CNI; pod security settings alone do not provide network isolation. The extension does not install the controller, grant RBAC, or alter network policy.

Disable automatic sidecar injection for sandbox pods: identity checks and quota arithmetic assume exactly one execution container. The sandbox image must run `/app/src/host/envd.ts` with Node.js and support UID/GID 1000, as the current Dockerfile does. Configure image-pull credentials on the sandbox service account if needed.

## MicroVM isolation with Kata Containers

[Microsandbox](microsandbox.md) runs microVMs in-process on one host and has no remote API, so it cannot schedule across a cluster. To get the same per-work kernel boundary on Kubernetes, run sandbox pods under a [Kata Containers](https://katacontainers.io) RuntimeClass. Everything else in this backend stays the same.

1. Install Kata on the nodes that have `/dev/kvm` (bare metal, or VMs with nested virtualization), for example with [kata-deploy](https://github.com/kata-containers/kata-containers/tree/main/tools/packaging/kata-deploy). It labels capable nodes `katacontainers.io/kata-runtime=true` and creates RuntimeClasses such as `kata-qemu` whose `scheduling.nodeSelector` targets those nodes. Check with `kubectl get runtimeclass`.
2. Apply the RuntimeClass ClusterRole/ClusterRoleBinding from `cluster.yaml`, listing every name you configure in `resourceNames`.
3. Set `"runtimeClassName": "kata-qemu"` in `kubernetes.json`. To isolate the host as well, set it on the host Sandbox's pod template.

Behavior and caveats:

- **Mixed clusters:** the RuntimeClass's node selector places sandbox pods only on Kata nodes. If no Kata node can schedule a pod, the Sandbox stays not Ready and fails at `readyTimeoutMs`.
- **Quota:** ResourceQuota charges the RuntimeClass `overhead.podFixed` on top of container requests and limits. Kaeno reads it alongside the quota on each admission. A configured RuntimeClass that is missing is a configuration error.
- **Identity:** `runtimeClassName` is part of the saved target, and adoption requires the Sandbox pod template's `runtimeClassName` to match. Switching between runc and Kata is rejected while sandbox reservations remain.
- **Image architecture:** Kata runs the same OCI image. It must match the Kata nodes' architecture, and the published GHCR image is linux/amd64 only.
- **Verify** that a sandbox really ran in a VM: `kubectl get pod <sandbox> -o jsonpath='{.spec.runtimeClassName} {.spec.overhead}'`, and compare `uname -r` inside the worker with the node's kernel.

## Lifecycle, suspension and capacity

A sandbox belongs to a conversation, not to a single WORK. A ticket's WORKs share its conversation, so they share one Sandbox and its workspace volume (`/workspace` and `/home/agent`; `/tmp` stays ephemeral).

- **Admission (`ensure`).** The extension durably saves the conversation's sandbox name, random environment token, image and a FIFO reservation before touching the cluster. It then waits for a compute slot, creates the Sandbox (or patches a suspended one back to `operatingMode: Running`), and waits for its `Ready` condition and `serviceFQDN`.
- **Suspension (`suspend`).** When a ticket's WORK ends, including when it reports `waiting` for the owner, Kaeno patches the Sandbox to `operatingMode: Suspended`. The controller deletes the pod and keeps the Sandbox, Service and PVC. The compute slot is freed once the pod is gone, waiting at most ten seconds; otherwise the slot stays reserved and reconciliation retries.
- **Wake.** The ticket's next WORK queues behind works already waiting, then resumes the same Sandbox with the same token and volume.
- **Release.** Child WORKs, and conversations that are neither live nor retained by an open ticket, have their Sandbox deleted. Garbage collection removes its pod, Service and PVC. Capacity frees once the Sandbox and pod are both gone.
- **Reconciliation** at startup and every five minutes suspends sandboxes whose WORK ended while their conversation is retained (for example after a crash between finishing and suspending), deletes sandboxes of conversations no longer retained, and removes owner-scoped orphan Sandboxes. Task liveness is rechecked to avoid acting on work admitted after the live-work scan. Each candidate is isolated; errors are aggregated and reported. A failed release never falls through to orphan deletion, which would bypass its identity checks.

Capacity is the minimum of `floor(quota / per-pod charge)` across pods, CPU requests/limits, and memory requests/limits, minus foreign pods matching the sandbox label. Suspended sandboxes hold only storage and do not count. WORK reads `capacity()` at admission; the lesser of that and `KAENO_WORK_MAX_CONCURRENT` bounds unfinished work. Pod creation happens in the controller, so a quota rejection appears as `Ready=False` (`ReconcilerError`) rather than a failed POST; Kaeno surfaces that condition when the readiness wait times out.

Adoption only accepts Sandboxes whose owner label, conversation and token-hash annotations, image and RuntimeClass match the saved reservation. A POST conflict is followed by identity validation. A saved image is retained across restarts even if the configured image changes for new work.

A Sandbox that disappears after admission, while running or while suspended, fails the WORK with "its workspace cannot be restored" instead of silently presenting an empty volume. Image/configuration failures, failed or completed pods and terminating pods fail promptly. Supervision polls the health check every five seconds while running; transient API errors are reported and retried, not interpreted as loss.

Pods run non-root with a read-only root filesystem, dropped capabilities, no privilege escalation, runtime-default seccomp, no service-account token, a five-second termination grace period and a four-hour lifetime backstop per running incarnation. Only the conversation's environment token enters the pod; cluster and GitHub App credentials stay on the host.

## Investigating sandboxes

**Sandbox state is not WORK status.** A `Suspended` Sandbox with a Bound PVC is the normal state of an idle ticket. Pod phase describes only the current incarnation: `Completed` means envd terminated, not that a report was delivered.

The following are read-only examples. Do not dump full Sandbox or Pod manifests: the pod template contains the environment bearer token.

```sh
NS=kaeno
kubectl -n "$NS" get sandboxes,pods,pvc -l app.kubernetes.io/name=kaeno-sandbox
kubectl -n "$NS" get sandbox personal-conv-42 \
  -o jsonpath='{.spec.operatingMode}{"\n"}{range .status.conditions[*]}{.type}={.status} {.reason}: {.message}{"\n"}{end}'
kubectl -n "$NS" get events --field-selector involvedObject.name=personal-conv-42 --sort-by=.metadata.creationTimestamp
kubectl -n "$NS" logs personal-conv-42 -c envd --timestamps --tail=100
kubectl -n "$NS" logs kaeno --since=12h --timestamps \
  | grep -E 'harness:|environment unavailable|identity mismatch|still (terminating|stopping)|Kubernetes .*failed'
kubectl -n "$NS" get resourcequota
```

Verify the host's RBAC:

```sh
SA=kaeno-kubernetes-host
for VERB in get list create patch delete; do
  kubectl auth can-i "$VERB" sandboxes.agents.x-k8s.io -n "$NS" --as="system:serviceaccount:$NS:$SA"
done
kubectl auth can-i list pods -n "$NS" --as="system:serviceaccount:$NS:$SA"
```

Final reports and cancellation are committed before resource cleanup, so a stuck backend cannot block them. Failed GET/PATCH/DELETE, identity or target mismatch, and pods still present after the ten-second wait are reported through `onReport` (`harness:` in the host log); the saved reservation remains for reconciliation. For recovery, inspect the durable works first. Do not delete Sandboxes wholesale, mutate SQLite, or switch RuntimeClass/backend to clear a symptom: deleting a Sandbox deletes the ticket's workspace.

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
  workspace: { size: "10Gi" },
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

Install `kubernetesExecutionProvider` for generic host selection, or import `kubernetesExtension` or `loadKubernetesConfiguration` directly from `src/extensions/kubernetes/index.ts`. `loadKubernetesConfiguration(path, context)` implements the shared `ExecutionConfigurationLoader` contract and returns `{ environment, extensions }`. The API client, Sandbox schemas/manifests, quantity parser, and reservation documents are not exported.

## Boundary choice

The extension implements `WorkEnvironment` directly rather than the generic `SandboxProvider`, keeping durable quota reservations beside the Kubernetes lifecycle. Optional `capacity(context)` supplies a live admission limit, `suspend` maps onto the Sandbox `operatingMode`, and the stable `identity` lets WORK reject a changed backend or target before recovery resumes. No Kubernetes types or imports enter core.

## Switching

Do not switch execution backends, or upgrade from the earlier bare-Pod implementation, with unfinished work. Drain or cancel work, let cleanup finish, and back up SQLite first; the reservation document format changed and earlier pods are not adopted. While any sandbox reservation remains, including a suspended ticket's, a database that has recorded Kubernetes state rejects changes to its cluster, namespace, owner, resource sizing, workspace size or class, quota, sandbox service account or RuntimeClass. Restore the original configuration until those conversations end. Live edits to the quota itself remain supported.

Integration tests use a simulated Kubernetes API with a fake agent-sandbox controller, real SQLite reopen, a real local HTTP API transport, and the real remote execution server. Live-cluster scheduling, the real controller, storage provisioning, TLS, image pulling, DNS and CNI enforcement still require verification against your cluster.
