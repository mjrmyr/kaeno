# Privacy-filtered Kubernetes observation

The generic Kubernetes extension now has two independent capabilities: worker execution and **read-only observation**. Observation works with Docker, microsandbox, or Kubernetes workers. It does not grant agents `kubectl`, arbitrary Kubernetes paths, or access to raw objects. There is no homelab extension.

## Assessment of PR #79

[PR #79](https://github.com/mjrmyr/kaeno/pull/79) correctly puts the privacy boundary **before** Kaeno/model ingestion, separates observation credentials from worker execution, and treats missing coverage as unknown rather than healthy. Read-only Pod access alone is not privacy protection: specs can contain plaintext credentials. Keep the independently deployed trusted observer and narrow fact contract.

Changes to that plan in this implementation:

- Observation belongs in `src/extensions/kubernetes/observation/`, with its host tools exported through the generic Kubernetes extension's public `index.ts`. No separate homelab package. Its native runtime registration is independent of the optional execution runtime so either can be installed alone.
- Tools are `kubernetes_overview` and `kubernetes_workload_health`, explicitly assigned, never worker defaults.
- Polling needs only `list`, not `get/watch`. RBAC examples grant exactly that.
- Initial delivery implements the contract, polling observer, authenticated snapshot endpoint, host client/tools and deployment examples. Existing owner-approved routines can schedule questions; no routines are created automatically. Durable history, transition notifications and alert deduplication remain future work.
- Rollout/health assessments are conservative evidence interpretations, not application-availability claims. CronJob schedules alone never imply successful runs. Missing counters are null, not fabricated zeroes.

**Boundary discipline** keeps raw API data inside collection/projection and validates strict remote output before tool serialization. **Foundational thinking** makes scope, coverage, freshness and approved facts explicit first. Scheduling and reports reuse existing machinery rather than introducing another scheduler.

## Data flow and limits

```text
Kubernetes API -> dedicated observer service account -> pure explicit projection
              -> authenticated HTTPS snapshot -> host Kubernetes tools -> assigned worker
```

The observer can read sensitive Pod spec fields and is trusted software. Raw objects live only transiently in collection/projection; they are never logged or persisted. Exported identifiers are untrusted data, never instructions. Approved names can themselves encode sensitive information: this is an allowlist projection, not universal secret detection.

Schema version 1 exports only:

- Resource namespace/kind/name, generation/observed generation.
- Deployment/StatefulSet/DaemonSet desired, ready, available and updated counts where present.
- Pod phase; Ready condition; app/init container names, readiness, restarts, finite state/reason and exit code.
- Opt-in Node Ready/MemoryPressure/DiskPressure/PIDPressure conditions.
- Job counts; CronJob active count, bounded numeric five-field cron schedule or standard macro, suspension and last successful timestamp.
- PVC phase and requested capacity (validated bounded quantity).
- Snapshot timestamp, per-kind/per-namespace coverage and last complete collection timestamp.

No specs, credentials, labels/annotations, env/commands/args, images, logs, event/condition/status messages, IPs, domains or paths leave projection. Unknown conditions/states map to `Unknown`; non-approved container reasons map to `Other`. Output schemas reject additional fields. Transport/config errors have fixed diagnostics, never upstream bodies or raw parser errors.

Scope allows 1–20 distinct explicitly named namespaces and optional cluster-wide nodes. Each list asks for at most 200 resources; a Kubernetes continuation token marks coverage `Truncated`, and the token itself is discarded. Per-scope projected facts have a 60 KiB byte budget; exceeding it also marks truncation, never silent success. Oversized/malformed upstream lists yield incomplete coverage. Containers are capped at 64 with `containersIncomplete`. Raw API responses are capped at 4 MiB before JSON parsing; host snapshot reads at 16 MiB. Overview lists at most 100 resources, unhealthy first, with per-scope counts and `resourcesIncomplete`. Use detail for evidence; there is no unrestricted query or automatic traversal of further pages in this first release.

Collection uses four concurrent lanes, 10-second request deadlines and a default 60-second delay after each completed poll. Detection delay is polling delay **plus collection duration**, API retries on the next poll, and any routine/model delivery delay. Large/unavailable scopes can take longer than 60 seconds. Only a completed sanitized snapshot replaces the previous one. Failed scopes discard old facts but retain the last complete timestamp; coverage is `Forbidden`, `Unavailable`, `Invalid` or `Truncated`, never an empty healthy result. Until the first poll completes the endpoint returns 503.

Default staleness is 180 seconds, measured from poll start. A stalled/dead observer's snapshot becomes stale when Kaeno next checks. Stale resources are assessed `Unknown`, not currently healthy. Complete fresh coverage plus a missing name returns `NotFound`; stale, failed or truncated coverage plus a missing name returns `Unobserved`. There is no sanitized history yet. `lastSuccessAt` means last **complete collection**, not last healthy workload.

Readiness is Kubernetes health, not proof of end-to-end correctness. Requests/limits are not utilization; PVC capacity is not free disk space. No backup or recent-change claims are supported.

## Observer process

Build the normal Kaeno image. Override the command:

```sh
KAENO_OBSERVER_CONFIG=/etc/kaeno-observer/config.json \
  node src/extensions/kubernetes/observation/main.ts
```

Example observer configuration:

```json
{
  "namespaces": ["pilot"],
  "includeNodes": false,
  "clientTokenFile": "/credentials/token",
  "pollIntervalMs": 60000,
  "staleAfterMs": 180000,
  "port": 8080
}
```

`api` defaults to `https://kubernetes.default.svc`; `tokenFile` and `caFile` default to the projected service-account token/CA paths. `caFile: null` uses system trust. Kubernetes and host endpoints require HTTPS with certificate verification; redirects are not followed. `clientTokenFile` holds an independently provisioned bearer token of at least 32 random characters. The service-account token and client bearer file are reread on every request for rotation. CA changes require restart. File paths resolve relative to their configuration file. Missing/invalid startup configuration fails closed with a fixed diagnostic.

The process listens **only on loopback** HTTP. Serve it through a same-pod private TLS proxy; do not expose plaintext HTTP on a Service. The example uses nginx on 8443 and a certificate valid for the Service DNS name. Only `/v1/snapshot` GET is served, bearer-authenticated, with `Cache-Control: no-store`. No unauthenticated snapshot, generic proxy or model-directed URL is offered. Auth tokens are provisioned out of band; no repository file includes a real credential.

Review [`cluster.example.yaml`](../src/extensions/kubernetes/observation/cluster.example.yaml) and, separately, optional [`nodes.example.yaml`](../src/extensions/kubernetes/observation/nodes.example.yaml). They are **examples, not deployed infrastructure**. Adapt image references (prefer digests), namespaces, TLS issuer/SANs, host labels, API IPs/ports, resources and CNI behavior. Project the Kubernetes credential into the observer container only, not the TLS sidecar or Kaeno workers. Do not reuse Kaeno's sandbox-management service account. No write, Secret/ConfigMap API read, logs, exec, attach, proxy or port-forward permissions are granted.

The example observer ingress allows only host pods on TLS port 8443. Worker network policy must also deny access to the API, observer and any raw monitoring endpoints; see the existing sandbox policy in `cluster.yaml`. NetworkPolicies are additive: another allow policy can defeat these restrictions. For non-Kubernetes execution, enforce the equivalent network restriction on the Docker/microVM network. Do not declare isolation verified from manifests alone.

## Host configuration and worker assignment

Set `KAENO_KUBERNETES_OBSERVATION_CONFIG` to a host-only JSON file:

```json
{
  "endpoint": "https://kaeno-observer.observer-system.svc",
  "tokenFile": "/credentials/observer-token",
  "caFile": "/credentials/observer-ca.crt",
  "namespaces": ["pilot"],
  "includeNodes": false,
  "staleAfterMs": 180000
}
```

Scope is checked independently on the host. Unexpected/missing/duplicate coverage, extra fields, out-of-scope facts, invalid timestamps and unavailable endpoints fail closed. Observer scope must match host scope exactly; select neither all namespaces nor nodes implicitly. The client holds credentials only in host closures; it defines no saved private binding and puts no credentials in worker environments.

The CLI installs observation in worker **availability only**, not defaults or router availability. Select it in an owner-controlled dedicated worker profile:

```yaml
tools:
  - kubernetes_overview
  - kubernetes_workload_health
skills: []
```

Give that worker instructions to cite evidence, report freshness/incompleteness, and avoid unsupported application-health claims. It needs neither shell nor kubectl. Existing routines may request a daily digest after owner approval; installing this feature creates no schedule or remediation authority. For embedding, use `loadKubernetesObservationConfiguration(path)` or `kubernetesObservationExtension(client)` from `src/extensions/kubernetes/index.ts`, independently of `kubernetesExtension()` for execution.

## Verification and deployment gate

Automated tests cover synthetic credential canaries through projections, real HTTPS transport with certificate verification, credential rotation, authentication, output bounds, stale/partial coverage, scope checks, tool serialization into captured model requests, and durable SQLite reopen. They do not establish live cluster isolation or application availability. Report/notification sinks and real model providers are not exercised by the synthetic integration test.

Before deployment, owner approval is still needed for namespaces, node access, endpoint placement and concrete RBAC/network manifests. Verify with actual operator-authorized impersonation (failure to impersonate does not prove the service account lacks access):

```sh
SA=system:serviceaccount:observer-system:kaeno-observer
kubectl auth can-i list pods -n pilot --as="$SA"                 # yes
kubectl auth can-i list deployments.apps -n pilot --as="$SA"     # yes
kubectl auth can-i list pods -n unapproved --as="$SA"            # no
kubectl auth can-i get secrets -n pilot --as="$SA"               # no
kubectl auth can-i get configmaps -n pilot --as="$SA"            # no
kubectl auth can-i get pods/log -n pilot --as="$SA"              # no
kubectl auth can-i create pods/exec -n pilot --as="$SA"          # no
kubectl auth can-i create pods -n pilot --as="$SA"               # no
kubectl auth can-i delete pods -n pilot --as="$SA"               # no
kubectl auth can-i list nodes --as="$SA"                        # no unless separately opted in
```

Repeat for every supported resource and forbidden verb. From real worker networks test that observer TLS, its pod port 8080 and Kubernetes API bypass attempts fail; from the authorized host verify trusted TLS plus authentication succeeds and missing/bad credentials fail. Rotate mounted tokens and check recovery. Remove a permitted list permission and stop the observer to verify incomplete/stale reporting. Inspect sanitized outputs/logs locally without dumping raw Pod specs. A dead observer cannot announce its own outage; independent outage alerting requires another checker.
