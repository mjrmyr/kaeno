# Homelab observation plan

Status: proposed design; not implemented. This document does not authorize deployment or cluster permission changes.

## Goal and agreed constraints

Kaeno should explain which homelab workloads are unhealthy, cite Kubernetes evidence, and distinguish unknown health from healthy state without receiving raw Kubernetes objects or credentials.

- The homelab currently has only the Kubernetes API, with no monitoring stack.
- Approved operational facts may leave the homelab for the configured model provider.
- Namespace, workload, Pod, container and node names may appear in reports.
- Observation is read-only. Remediation is out of scope.
- The owner selects an explicit namespace allowlist. Node health requires a separate cluster-wide opt-in.

## Architecture and ownership

```text
Kubernetes API
    | dedicated read-only service account
    v
Trusted in-cluster observer
    | authenticated, encrypted API; approved health facts only
    v
Kaeno homelab extension
    | explicitly assigned tools
    v
Dedicated observer worker -> router -> owner reports
```

The observer is the privacy boundary. It constructs new output objects from approved fields before data reaches Kaeno, not after a model has read it. Raw objects exist only within trusted collection/projection code and are not persisted or logged.

Keep observation separate from `src/extensions/kubernetes/`, which manages worker execution. The Kaeno integration belongs in a new `src/extensions/homelab/` integration using the existing extension contribution boundary. The observer should be a separately deployed process with its own identity; its exact source/package location remains an implementation decision.

No Kubernetes types enter durable core. Existing routines provide scheduled work, and existing signed webhooks can support later transition notifications. No new scheduler, generic Kubernetes proxy, or tool framework is needed.

### Alternatives

| Design                                         | Decision                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Worker with read-only kubectl                  | Reject: read-only Pod access can reveal plaintext credentials; arbitrary queries defeat the output boundary. |
| Existing monitoring integration                | Defer: there is no monitoring stack. A future adapter can produce the same approved facts.                   |
| Dedicated observer and narrow native extension | Choose: isolates Kubernetes credentials and makes exported information explicit and testable.                |

Boundary discipline determines the projection boundary. The laziness protocol keeps the initial interface to two tools and reuses existing scheduling and delivery.

## Observation contract

Initial facts:

| Resource                           | Approved observations                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Deployment, StatefulSet, DaemonSet | Desired/ready/available/updated counts where applicable; generation and observed generation; bounded rollout assessment |
| Pod/container                      | Phase, readiness, restart count, approved waiting/termination reason, exit code                                         |
| Node (opt-in)                      | Ready, memory pressure, disk pressure, PID pressure conditions                                                          |
| Job/CronJob                        | Active/succeeded/failed counts, schedule, suspension, last successful completion where available                        |
| PersistentVolumeClaim              | Pending/bound/lost state, requested capacity                                                                            |
| Collection                         | Observation time, last successful collection, per-resource coverage, bounded failure category and freshness             |

Names are allowed, but names remain untrusted data, never instructions. Server-side selectors and scope checks must not rely on model cooperation.

Every exported string needs an explicit source and validation rule. Status, condition and reason fields are finite approved values; unknown values become `Other` or `Unknown`. Do not export arbitrary upstream strings just because they are called reasons. Resource quantities, schedules and identifiers receive domain-specific validation and bounds. Do not infer success from missing fields.

Every response includes a schema version and freshness/coverage information. Collection permission failures and partial results remain visible as missing coverage. Retaining the last good sample is acceptable only if its timestamp and stale state remain explicit. Define freshness thresholds in owner configuration with safe defaults.

Never export:

- Secret or ConfigMap contents.
- Environment variables, commands, arguments, raw specs or YAML.
- Logs, Kubernetes event text, condition messages or arbitrary status messages.
- Arbitrary labels or annotations.
- IPs, ingress domains, registry paths or volume paths.
- Raw upstream errors, request headers or response bodies.

Projection uses explicit field construction, never object spreading followed by deletion. Output schema validation rejects additional fields. Regex or exact-value secret detection may supplement this boundary but cannot replace it. Credentials and encoded/transformed secrets cannot be universally detected.

### Limitations

- Readiness is Kubernetes health, not proof of end-to-end application correctness.
- CPU/memory requests and limits are not usage. Actual utilization requires an additional metrics API or monitoring system.
- PVC requested capacity is not filesystem free space.
- Backup correctness and application availability require additional signals.
- Current-state snapshots do not provide reliable change history. Do not claim recent changes until sanitized history exists.

## Initial tool interface

```text
homelab_overview()
homelab_workload_health(namespace, kind, name)
```

Tools return bounded typed facts from the latest observer snapshot, not raw upstream responses. Workload kinds are a finite supported set; unsupported kinds and out-of-scope namespaces fail with safe diagnostics. A missing object and an unobserved object must be distinguishable.

No arbitrary URL, Kubernetes path, JSONPath, shell command, raw resource endpoint or unrestricted query language is exposed. Define output size limits and explicit incomplete-result indicators rather than silently truncating a healthy-looking summary.

The extension holds observer authentication on the host, not in worker environments or saved bindings. Explicitly select the tools for a dedicated worker; do not add them to every worker's defaults. Credentials must support rotation. Missing/invalid configuration fails closed; runtime observer failure returns unavailable, not healthy.

## Deployment security

The observer uses its own service account, not Kaeno's sandbox-management identity.

- Grant only required `get/list/watch` verbs and resource types; omit watch if polling alone is implemented.
- Use namespace RoleBindings for the explicit namespace allowlist.
- Grant node reads separately and only when configured.
- No Secrets, ConfigMaps, logs, exec, attach, proxy, port-forward or write permissions.
- Mount Kubernetes credentials only into the observer; use rotating service-account credentials and verified TLS.
- Protect the observer endpoint with authentication and TLS, directly or through a documented private TLS ingress/proxy. HMAC signing alone does not encrypt webhook contents.
- Restrict network access so workers cannot reach the observer, Kubernetes API, or future raw monitoring endpoints directly. Verify enforcement with the actual CNI; manifests alone are not proof.
- Run the observer unprivileged with bounded resources and a read-only filesystem where possible.

Kubernetes RBAC does not provide field-level Pod access. The observer can encounter sensitive Pod-spec fields even though it exports only status facts. It is trusted software, and compromise of that process is outside the projection guarantee. Avoid generic object dumps and raw-error logging on all paths.

Anything ingested by Kaeno may reach model requests, append-only conversation history, reports, notifications and backups. Final-answer redaction is too late. Do not persist raw cluster data with the intention of deleting it later.

## Monitoring behavior

Poll initially around every 60 seconds with bounded request deadlines and concurrency. Collection runs independently of Kaeno/model-provider availability. Replacing the current snapshot must not expose partially constructed data.

First release:

1. On-demand health questions.
2. An owner-approved daily digest using existing routines.
3. Optional periodic health checks with a documented detection-delay expectation.

Later, deterministic transition detection can emit signed generic webhooks for sustained unhealthy state, recovery and stale collection. Sanitize before webhook submission. Cluster data remains data and cannot authorize remediation, tool grants or routine changes.

Transition delivery needs durable deduplication and retry semantics. A new delivery ID must not be generated on each retry; a later recurrence must not be confused with a duplicate. Restarts must not create notification storms. Track sanitized state only.

A dead observer cannot reliably announce its own outage. Kaeno must report staleness when it checks; stronger independent outage alerting needs an external checker or monitoring system.

## Implementation phases and acceptance criteria

### 1. Contract and offline projection

Define versioned observation types, config schema, supported resources, field bounds and pure projections with synthetic fixtures.

Acceptance:

- Every exported field has an explicit purpose and test.
- Additional/unknown fields cannot pass through serialization.
- Canary credentials planted in env vars, annotations, labels, messages, reasons and API errors never appear in output.
- Unknown states, missing fields and oversized collections are represented conservatively.

### 2. Observer and deployment examples

Implement API collection, authenticated snapshot serving, credential rotation, verified TLS, safe diagnostics, timeouts and coverage/freshness reporting. Provide reviewed deployment, namespace RBAC and network-policy examples without automatically applying them.

Acceptance:

- A pilot namespace produces only approved facts.
- Actual RBAC checks prove forbidden reads and writes fail.
- Worker-to-observer/API bypass attempts fail under the deployed network policy.
- Partial collection, expired credentials and API outages produce unknown/degraded coverage, never false health.
- Raw objects and errors are absent from logs and persisted files.

### 3. Native Kaeno integration

Implement host configuration, observer client, the two tools and explicit dedicated-worker assignment. Add integration tests through real tool serialization and durable conversation storage.

Acceptance:

- Kaeno answers overview and workload questions with evidence and limitations.
- Out-of-scope requests fail even if the model supplies them directly.
- Canary values are absent from captured model requests, durable storage, host logs, reports and notification payloads.
- Observer unavailability and stale samples are reported accurately.
- Saved bindings contain no credentials; normal extension recovery rules apply.

### 4. Scheduled reports

Configure owner-approved daily and optional periodic routines. Tune volume before adding push alerts.

Acceptance:

- Reports identify unhealthy resources and distinguish observed healthy, stale and unobserved scopes.
- Reports do not claim utilization, disk usage, backup correctness or end-to-end availability without supporting signals.

### 5. Sanitized history and transition notifications

Add bounded retention for approved facts only, sustained-failure/recovery rules and deduplicated signed webhook delivery.

Acceptance:

- Retry, restart and recovery tests demonstrate idempotent notifications.
- Recurring incidents remain distinct.
- Alert content follows the same output contract as tools.

## First milestone

Kaeno can identify unhealthy workloads, cite approved Kubernetes evidence, and explain uncertainty without receiving raw Kubernetes objects or cluster credentials.

Before deployment, the owner must select namespaces, choose whether node access is needed, and approve concrete RBAC/network manifests and observer endpoint placement. No live cluster access is needed to implement the offline contract and tests.
