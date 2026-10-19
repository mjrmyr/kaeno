# Sandboxed Chromium: restricted WORK release gate

This is a **diagnostic/configuration proposal, not a verified production remediation**.
Do not enable the example policy until the node gates below pass. No live settings are changed.

## Observed failure and limits of the evidence

On the restricted WORK used for this investigation, the real `BrowserSession` running the
pinned official MCP server failed against a **local controlled fixture**, before navigation:
Chromium revision 1247, `zygote_host_impl_linux.cc:130 No usable sandbox`, then SIGABRT.
This reproduces worker4731's public-navigation failure without involving DNS/public egress.
The executable was `/ms-playwright/chromium-1247/chrome-linux64/chrome`.

Read-only metadata and disposable child probes reported:

| Evidence                                       | Value                                 |
| ---------------------------------------------- | ------------------------------------- |
| UID/GID                                        | 1000/1000                             |
| Effective/permitted/bounding capabilities      | all zero                              |
| NoNewPrivs                                     | 1                                     |
| Seccomp / filters                              | 2 (filter) / 1                        |
| AppArmor current label                         | `cri-containerd.apparmor.d (enforce)` |
| `kernel.unprivileged_userns_clone`             | 1                                     |
| `user.max_user_namespaces`                     | 125019                                |
| `kernel.apparmor_restrict_unprivileged_userns` | unavailable in this pod               |
| `unshare(CLONE_NEWUSER)`                       | EPERM                                 |
| `unshare(CLONE_NEWUSER \| CLONE_NEWNS)`        | EPERM                                 |
| `unshare(CLONE_NEWUSER \| CLONE_NEWNET)`       | EPERM                                 |
| Kernel                                         | `6.12.107+deb13-amd64`                |

**Confirmed:** namespace creation is denied, and sandboxed Chromium cannot start under the
current combined policy. **Not confirmed:** which filter/LSM/kernel rule denied each syscall;
whether Chromium's `clone`, `clone3`, `setns` or `chroot` are denied; whether allowing `unshare`
alone would fix Chromium. EPERM does not distinguish seccomp from AppArmor or another
namespace prerequisite. Chromium's generic Ubuntu/AppArmor suggestion is not a diagnosis.
The SUID sandbox is not an alternative with `allowPrivilegeEscalation:false`.

Inspected sources: kaeno main `9dd30a82a1b92da8d42252166a0a7af7b5c81f48` generates
RuntimeDefault pods, cap-drop ALL, non-root, read-only root, no service-account token.
Homelab main `fb50032f68a46fdeb48ff188d61394163efca150` pins host/WORK image
`sha256:7f319fd2681c085f776104230cc5df74e9d24b12de5d6fd20260a917b6893fbc`
and has no WORK policy override or node OS/profile provisioning. Its registry configuration
and this pod's mount metadata identify k3s/containerd, not the active runtime's full policy.
No Kubernetes API, node audit logs, or host administration was accessed.
PR26 is merged, but was based on another work branch; the current main tree no longer has
its Docker CI profile/smoke. PR30 is merged through the MCP integration; this is the
proxy-free code. A historical Docker green is not evidence for today's Kubernetes runtime.

## Close lifecycle fix

`browser_close` now tears down the owned MCP client and temporary directory directly,
without forwarding an upstream tool call. This handles both unused sessions and failed
launches returned as MCP `isError` (where a connected client still exists), and preserves
cleanup of active sessions. It is idempotent; only the next non-close action reconnects.
This supersedes PR32's no-client-only guard, which does not cover that actual failure path.
No unrelated WORK lifecycle/refactor changes are included.

## Implemented opt-in (default unchanged)

`KAENO_KUBERNETES_CONFIG` now accepts **only a Localhost seccomp path** plus a required
nonempty selector for operator-provisioned nodes:

```json
{
  "sandboxPolicy": {
    "seccompLocalhostProfile": "kaeno/chromium-reviewed-v1.json",
    "nodeSelector": { "kaeno.io/browser-sandbox": "reviewed-v1" }
  }
}
```

This is a fragment to add to an otherwise valid config, **not a deployable profile**.
The path is relative to the kubelet seccomp root; absolute paths, traversal, empty segments
and backslashes are rejected. Kubernetes still validates label syntax/admission rules.
No Unconfined, capability, AppArmor-disable or privilege-escalation option is added.
Only generated WORK pods change; the host stays RuntimeDefault. All other hardening remains.
An absent profile fails pod creation; an absent node label leaves the pod unscheduled. There
is no fallback. Policy/path/selector changes invalidate saved WORK target configuration;
drain/finish existing work before changing it. The default saved target format is unchanged.

A custom seccomp profile **replaces**, not augments, RuntimeDefault. Supplying a default-allow
profile would silently remove protections: do not do that. Unprivileged namespace syscalls
increase kernel attack surface even with no capabilities in the parent namespace. This is
an operator-reviewed, per-WORK policy delta, not a claim of equivalent security.

## Node evidence and provisioning gate (operator; not executed here)

1. Identify the node, runtime/containerd version and configured runtime handler serving the
   failed WORK. Obtain its actual effective seccomp baseline and AppArmor definition using
   the node's supported runtime tooling. Record hashes/versions; do not assume Docker's
   profile matches containerd's. Check node-side userns limits/sysctls and applicable LSMs.
2. Correlate node audit/kernel logs with the failed launch's PID/time. Look for
   `apparmor="DENIED"` userns records and seccomp syscall/arch records. Absence of logs is
   not proof of allowance: ERRNO seccomp actions may not emit audit records. If needed,
   collect syscall results using an operator-approved tracing setup on an isolated canary
   with the same runtime settings. Do not grant tracing privileges to normal WORK pods.
3. Review only evidenced changes against a pinned copy of the **actual runtime baseline**.
   The historical Docker candidate (`clone`, `setns`, `unshare`, `chroot`) is a hypothesis,
   not a provisionable containerd profile. Keep other deny rules/architectures intact;
   constrain namespace/clone flags where supported and verified with this Chromium version.
   No profile is checked in here because the runtime baseline/denial evidence is unavailable.
4. If seccomp is the only blocker, install the reviewed versioned profile under the kubelet's
   configured seccomp root on **each eligible node**, using the existing node-management
   process. Determine the actual root from kubelet configuration; do not assume the k3s
   path. Validate ownership/mode/hash and profile loading, then label only those nodes with
   the reviewed version. Do not mount host paths or add a privileged profile-installer DaemonSet.
5. If AppArmor is also blocking, stop and review a narrow WORK-specific profile with the
   operator. This PR does not configure AppArmor or change host userns sysctls. Any need
   for broad host-policy relaxation is an explicit human security decision, not a default.
6. Only after isolated canary verification, propose the actual homelab profile provisioning
   and `kubernetes.json` opt-in together for review. Do not opt the single homelab node in
   speculatively. Maintain the paired host/WORK image digest invariant.

## Actual-image test gate

The Dockerfile includes `scripts/browser-runtime-smoke.ts`. In a **candidate WORK pod**
created by the normal generator on the reviewed node/runtime, run (operator commands):

```sh
kubectl -n kaeno exec <candidate-work-pod> -c envd -- \
  node /app/scripts/browser-runtime-smoke.ts --diagnose-only
kubectl -n kaeno exec <candidate-work-pod> -c envd -- \
  node /app/scripts/browser-runtime-smoke.ts
```

The second command exits nonzero on any MCP/Chromium error. It exercises the actual
`BrowserSession`, its sanitized child environment, pinned server/browser, sandbox enabled,
controlled loopback JavaScript, two navigations with `window.name` persistence, a real image
screenshot and close. It always closes the MCP client and local fixture. The probes only
read fixed kernel metadata and call unshare in disposable children; no credentials or private
services are read. Use `npm run browser:smoke -- --diagnose-only` in a source checkout.
This fixture intentionally uses loopback: it proves browser startup, **not network isolation**.

Record candidate digest, node/runtime, effective seccomp/AppArmor profile hashes, pod manifest,
command exit code and output. A PASS from Docker or an unrestricted laptop is **not sufficient**.
Still gate release on distinct-pod session isolation, cancellation, process/temp-directory
cleanup, normal native-tool invocation and the network matrix in [browser-mcp.md](browser-mcp.md)
(public egress, configured private/tailnet/link-local denials, IPv6, redirects/rebinding,
loopback and envd bearer rejection). Do not change live policy to run this gate automatically.

In this investigation `npm run browser:smoke` exited **1** with the sandbox failure above;
no successful screenshot or remediated launch is claimed. There is no Docker executable or
node administration access in this WORK, so candidate image building and policy-enabled
canary verification remain release gates. Unit/integration tests cannot substitute for them.
