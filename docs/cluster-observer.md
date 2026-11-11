# Cluster observer

The optional cluster observer lets Kaeno and every worker look at the owner's Kubernetes cluster without seeing its secrets. It is separate from the [Kubernetes execution backend](kubernetes.md) and works with any backend. Its tools are read-only defaults for both roles; explicit `tools` lists still override defaults.

| Tool               | What it shows                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `cluster_overview` | Node health and usage, pod counts, unhealthy pods, workloads below their desired replicas, recent warnings |
| `cluster_list`     | Summary rows of one kind, like `kubectl get`, optionally by namespace and label selector                   |
| `cluster_describe` | One object's status, conditions, containers and resources, plus its recent events                          |
| `cluster_events`   | Recent events, newest first; warnings only unless `includeNormal`                                          |
| `cluster_usage`    | CPU and memory of nodes or pods from metrics-server, highest first                                         |
| `cluster_logs`     | The latest log lines of a pod's container, in allowed namespaces only, with likely secrets masked          |

Kinds: pods, deployments, statefulsets, daemonsets, replicasets, jobs, cronjobs, services, ingresses, persistentvolumeclaims, persistentvolumes, nodes, namespaces.

## Configure

Run the Kaeno host in the cluster and set `KAENO_CLUSTER_CONFIG` to an owner-controlled file:

```json
{
  "exclude": ["vault"],
  "logs": { "namespaces": ["apps", "media"], "maxLines": 200 }
}
```

| Field             | Default                                                | Purpose                                                   |
| ----------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `api`             | `https://kubernetes.default.svc`                       | API origin                                                |
| `tokenFile`       | `/var/run/secrets/kubernetes.io/serviceaccount/token`  | Host-only bearer token, reread on every request           |
| `caFile`          | `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` | API CA certificate; `null` uses system trust              |
| `exclude`         | `[]`                                                   | Namespaces Kaeno never sees, nor their events or usage    |
| `logs.namespaces` | `[]`                                                   | Namespaces whose logs Kaeno may read; empty disables logs |
| `logs.maxLines`   | `200`                                                  | Most log lines per call                                   |

Apply and adapt [`src/extensions/kubernetes/observe/cluster.yaml`](../src/extensions/kubernetes/observe/cluster.yaml). It binds a read-only ClusterRole to the host's service account and grants `pods/log` per namespace, mirroring `logs.namespaces`. Usage needs [metrics-server](https://github.com/kubernetes-sigs/metrics-server); without it, usage is reported as unavailable.

## What Kaeno cannot see

Three independent layers keep secrets on the host:

1. **RBAC.** The ClusterRole grants `get` and `list` on the kinds above and nothing else: no Secrets, ConfigMaps, service-account tokens, exec, attach, port-forward, proxies, watch or writes. Logs are granted only in the namespaces you bind.
2. **Projection.** The host never passes an API object through. Each kind is parsed into an explicit whitelist of fields; everything else is dropped, including environment variables (values and secret references), `envFrom`, command and arguments, annotations (`last-applied-configuration` holds full manifests), volumes, image-pull secrets, `managedFields` and TLS secret names. Excluded namespaces are filtered out of every result. Only GET requests exist, and API error bodies are never surfaced.
3. **Redaction.** Free text that can carry secrets anyway (log lines, event messages, status and termination messages) is masked for private keys, JWTs, bearer and basic credentials, URL passwords, cloud and Git tokens, and `password=`/`token:`-style values. This is best effort: keep namespaces whose logs print secrets out of `logs.namespaces`.

Tool descriptions mark cluster content as untrusted data, never instructions.

Verify the service account's permissions (needs impersonation rights):

```sh
SA=system:serviceaccount:kaeno:kaeno-kubernetes-host
kubectl auth can-i list pods -A --as=$SA            # yes
kubectl auth can-i get secrets -A --as=$SA          # no
kubectl auth can-i list configmaps -A --as=$SA      # no
kubectl auth can-i create pods/exec -A --as=$SA     # no
kubectl auth can-i get pods/log -n apps --as=$SA    # yes
kubectl auth can-i get pods/log -n vault --as=$SA   # no
```

The execution backend's namespace-local pod permissions on the same service account are not reachable through these tools.

## Alerts from Alertmanager

Add an `alertmanager` source to `KAENO_WEBHOOKS_CONFIG` (see [Webhooks](../README.md#webhooks)):

```json
{
  "name": "alertmanager",
  "kind": "alertmanager",
  "secretFile": "alertmanager.secret",
  "trust": "all"
}
```

Alertmanager cannot sign requests, so it authenticates with the secret as a bearer token. Mount the same secret (at least 32 characters) for Alertmanager and add a receiver:

```yaml
receivers:
  - name: kaeno
    webhook_configs:
      - url: http://kaeno.kaeno.svc:8081/hooks/alertmanager
        send_resolved: true
        http_config:
          authorization:
            credentials_file: /etc/alertmanager/secrets/kaeno/secret
```

Each alert group becomes one thread, `alertmanager:<hash of the group key>`. An event lists every alert's labels, start time, and `summary` and `description` annotations. Repeat notifications of an unchanged group deduplicate, and the thread closes when the whole group resolves.

Alerts are system events: they inform Kaeno but grant nothing. To be told about them, save a preference with Kaeno, for example "When Alertmanager fires, check the cluster and tell me briefly what's wrong on Telegram."

Test it with `amtool alert add test severity=warning --annotation=summary="Test alert" --alertmanager.url=http://alertmanager:9093`.
