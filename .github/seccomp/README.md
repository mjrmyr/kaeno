# CI Chromium namespace policy

`docker-default-v28.0.0.json` is vendored byte-for-byte from
<https://github.com/moby/moby/blob/v28.0.0/profiles/seccomp/default.json>.
SHA-256: `9c1025c88ccaa517b648da571961838744ea2137f176bfe6a48b21294cae9c76`.
Upstream license: Apache-2.0 (see LICENSE).

The generator adds the three-syscall exception in
<https://github.com/microsoft/playwright/blob/v1.64.1/utils/docker/seccomp_profile.json>:
`clone`, `setns`, `unshare`. The additional `chroot` exception is explained below. It does not allow `clone3` or change any existing
rule, architecture map, errno, capability condition or default deny action.
Tests pin the baseline hash and compare the entire generated policy minus that
two rules to the baseline. No policy is fetched at CI execution time.

The syscall exception permits Chromium to build its own user-namespace sandbox
with no outer capabilities; kernel permission checks still apply. It increases
kernel attack surface for the CI smoke container. This is intentionally not
installed in the image or wired into Docker/Kubernetes worker provisioning.
AppArmor, user namespace sysctls and runtime versions can independently prevent
sandboxing. There is no fallback and no host setting is changed. The pinned
baseline is reproducible, not a claim to track the runner daemon's current
built-in profile; review upstream changes explicitly when updating it.

See `docs/browser-runtime.md` for failure evidence and the mandatory deployment
validation gate. Do not copy this CI policy into production without review and
approval.

The first real CI run with the namespace exception reached Chromium's filesystem
isolation but failed `sys_chroot("/proc/self/fdinfo/") == 0`:
<https://github.com/mjrmyr/kaeno/actions/runs/39232342522/job/117993052921>.
Docker gates `chroot` on the outer CAP_SYS_CHROOT, absent under cap-drop ALL.
A second rule allows only the `chroot` syscall, not that capability. Linux still
requires CAP_SYS_CHROOT in the caller's user namespace; Chromium obtains it only
inside its own newly created namespace to restrict its filesystem view. No
outer capability or filesystem access is granted. This fourth syscall is an
evidence-based addition to Playwright's three-syscall recommendation.
