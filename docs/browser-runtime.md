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
default seccomp, worker-sized writable tmpfs mounts and no network. The smoke
renders controlled inline JavaScript, checks its resulting DOM text and title,
reports the browser version/UID, and closes the browser. Run it manually with the
same `docker build` / `docker run` commands in `.github/workflows/check.yml`.

**Image build, real Chromium launch and sandbox compatibility were not validated
in the implementation workspace: it has no Docker/Podman executable or Docker
socket.** The added CI check must establish Docker compatibility. A Docker pass
also does not prove Kubernetes RuntimeDefault seccomp/user-namespace compatibility;
repeat the controlled smoke in a worker pod under the existing security policy
before declaring that deployment browser-ready. A namespace/seccomp denial is a
runtime compatibility blocker: do not work around it with `--no-sandbox`,
privileged pods, relaxed security settings or runtime package installs.

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
