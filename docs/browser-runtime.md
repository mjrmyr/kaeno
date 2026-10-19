# Image-provided browser runtime

The Kaeno image installs the exact locked Playwright runtime and its matching Chromium
revision, including OS dependencies, **at image build time**. npm lifecycle scripts
remain disabled. Browser files live at `/opt/playwright`, readable/executable by UID
1000; the root filesystem does not need to be writable. No runtime apt or browser
download is needed.

From any workspace, import the image helper by absolute path (not a workspace npm
package):

```sh
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 \
  PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
  /usr/local/bin/node --input-type=module <<'JS'
import { launchChromium } from '/app/scripts/browser.mjs';
const browser = await launchChromium();
try {
  const page = await browser.newPage();
  // Perform an approved public-web task here; close within the same invocation.
} finally {
  await browser.close();
}
JS
```

`launchChromium()` takes no arguments and returns `Promise<Playwright Browser>`.
It explicitly enables Chromium sandboxing and gives the child only fixed PATH,
HOME, TMPDIR, LANG and PLAYWRIGHT_BROWSERS_PATH values. Provider/envd tokens, proxy
credentials and loader variables are not inherited by Chromium. The outer `env -i`
separately sanitizes the Node process. The helper rejects executable paths outside
`/opt/playwright` rather than substituting a workspace browser. It does not retry
with reduced sandboxing.

## Validation and deployment

`npm run verify` includes mocked helper launch/environment tests; those do not
prove an actual Chromium process can start. The `browser-image` PR check builds
this Dockerfile, then runs `/app/scripts/browser-smoke.mjs` from `/workspace` as
UID/GID 1000 with read-only root, dropped capabilities, no-new-privileges, Docker's
a scoped CI-only seccomp profile, worker-sized writable tmpfs mounts and no network. The smoke
renders controlled inline JavaScript, checks its resulting DOM text and title,
reports the browser version/UID, and closes the browser. Run it manually with the
same `docker build` / `docker run` commands in `.github/workflows/check.yml`.

### Why CI needs a namespace exception

The original PR #25 check ([failed job](https://github.com/mjrmyr/kaeno/actions/runs/39226683615/job/117974566495))
built the image successfully on Ubuntu 24.04.5, then launched
`/opt/playwright/chromium-1248/chrome-linux64/chrome` (156.0.8078.4) without
`--no-sandbox`. It aborted with `zygote_host_impl_linux.cc:130: No usable sandbox!`.
The later crashpad CPU-frequency-file errors are crash reporting, not the cause.

With capabilities dropped and no-new-privileges, Chromium must use unprivileged
user namespaces, not a privileged/setuid sandbox. Docker's default seccomp policy
blocks namespace-bearing `clone` and `unshare` without CAP_SYS_ADMIN. The CI
command previously supplied no exception. The log proves sandbox establishment
failed; it does **not** identify an AppArmor audit denial or the exact denied
syscall. Read-only root is retained: Chromium's profile and temporary files use
writable `/tmp`, while the executable remains in `/opt/playwright`.

`scripts/browser-seccomp.mjs` adds the `clone`, `setns`, `unshare` allow rule
recommended by [Playwright's Docker guide](https://playwright.dev/docs/docker#crawling-and-scraping)
to a vendored, deny-by-default Docker v28.0.0 profile, plus a `chroot` syscall
allowance for Chromium's filesystem isolation inside its new user namespace.
The first scoped CI run passed the original namespace failure but failed
`sys_chroot("/proc/self/fdinfo/") == 0`: Docker gates this syscall on the outer
CAP_SYS_CHROOT, which remains dropped. The added rule grants no capability;
kernel namespace capability checks still apply. See the evidence in
[the scoped run](https://github.com/mjrmyr/kaeno/actions/runs/39232342522/job/117993052921).
Provenance and limitations
are in `.github/seccomp/README.md`. CI generates this policy outside the image.
All other syscall rules, non-root UID, capability drop, no-new-privileges,
read-only root, tmpfs limits and network isolation remain. This exposes namespace
syscalls to the whole smoke container, not only Chromium; it is a targeted CI
exception, **not** an approved policy for untrusted workers. Chromium sandboxing
and its fixed environment are unchanged.

AppArmor and host user-namespace limits are independent of seccomp. CI reports
host settings but does not modify them. If the scoped profile still fails, inspect
host audit denials and user-namespace limits; do not disable AppArmor globally,
use unconfined seccomp, add CAP_SYS_ADMIN, or retry without Chromium's sandbox.

### Deployment remains blocked pending worker validation

**No Docker/Podman executable or Docker socket is available in the implementation
workspace.** Unit tests validate the policy delta, not a real launch. The CI
image smoke must pass before claiming this CI correction works.

**Existing Kubernetes RuntimeDefault browser support is unverified and likely
blocked by the same namespace restriction.** A green scoped Docker check is
only image/CI validation, not deployment approval. No production security policy
is changed here. Before merging/deploying the browser feature, run the controlled
smoke in a newly created worker pod with the exact published image digest and
existing security context (RuntimeDefault seccomp, AppArmor, no privilege
escalation, dropped capabilities, read-only root and bounded writable volumes).
Record the digest, runtime/node versions, applied policies and smoke output.
If it fails, browser deployment remains blocked: either retain the existing
policy and do not deploy the browser feature, or obtain separate approval for a
reviewed node-local seccomp/AppArmor policy and validate again. Do not interpret
this CI exception as authorization to change homelab or pod policy.

After review/merge, the image publishing workflow builds the image. Pin the same
published `ghcr.io/mjrmyr/kaeno@sha256:…` digest for **both** the homelab host and
worker image, through a separate reviewed homelab change. No deployment or
homelab change is part of this browser-runtime PR. Replacing only the host will
not update existing worker images; validate the smoke on a newly created worker.

## Limits

This helper is not a browser service, MCP runner, native screenshot tool or URL
policy boundary. Existing networking policy does not protect same-pod loopback;
there is no full SSRF guarantee. Follow the browser skill's public-site and
untrusted-content rules. Do not supply arbitrary hostile URLs or describe the
browser as isolated from all filesystem/network secrets.
