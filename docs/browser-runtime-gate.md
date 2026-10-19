# Browser in Kubernetes: deployment decision

## Recommendation and approval gate

Keep the existing official MCP **stdio process in each WORK container**. No proxy, browser
service, sidecar, extra mandatory environment variable or custom node security machinery.
PR34's speculative `sandboxPolicy`/Localhost profile configuration and namespace diagnostics
have been removed. The direct local `browser_close` teardown fix and regression tests stay.

The pragmatic way to make Chromium run under the observed namespace-denying WORK policy is
**explicitly disable the Chromium sandbox inside the existing restricted WORK container**.
This is a recommendation awaiting owner approval, **not implemented or enabled here**.
Current code still passes `--sandbox` and fails closed. Simply deleting that flag would also
change the security posture with this pinned Chromium configuration; that is not a safe fix.

**Decision requested:** may WORK Chromium use explicit `--no-sandbox`, accepting that a
compromised renderer can access the WORK process identity, files and network (including
loopback), rather than being contained by Chromium's renderer sandbox? If approved, the
minimal follow-up is a single explicit MCP argument replacement plus its test/documentation;
no node changes or new configuration system are needed. Approval is not deployment approval.

The agent already has bash as the same non-root identity in an ephemeral, read-only-root,
capability-dropped, no-privilege-escalation WORK pod with no service-account token. That makes
WORK a plausible pragmatic outer boundary for an owner who accepts this risk. It does **not**
make untrusted website JavaScript equivalent to intentionally granted agent bash access.
The browser sandbox is defense in depth between hostile renderers and WORK resources.
Container/pod isolation is not an equivalent replacement. Environment sanitization is not OS
process isolation; a compromised browser may access same-identity processes/files and envd
credentials. Envd bearer authentication, WORK-only exposure and cleanup must remain.

## Three practical choices

| Choice                                                         | Benefit                                                                                                     | Cost / security limit                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Official MCP/browser image, same container or sidecar          | Maintained browser dependencies and headless stdio/HTTP entrypoint                                          | Does not override node seccomp/AppArmor/userns denial. The official MCP image explicitly uses `--no-sandbox`. A sidecar shares pod networking; separate container files/process visibility depend on pod settings. Kaeno currently assumes exactly one WORK execution container for identity/quota; adding a sidecar is not a drop-in fix. |
| **Existing WORK + explicit `--no-sandbox` (approval pending)** | Smallest operational change; retains existing authenticated envd transport, per-WORK state and pod teardown | Removes Chromium renderer sandbox, retains only outer WORK containment. Not appropriate if hostile pages must be isolated from WORK files/processes. No silent fallback.                                                                                                                                                                   |
| Dedicated remote browser pod/service                           | Can put browser compromise outside the credential-bearing WORK filesystem/process boundary                  | Needs endpoint, lifecycle, authentication/network restriction and per-WORK browser/context isolation. Remote host still needs sandbox-compatible policy or knowingly relies on its own container/VM boundary. More infrastructure; reserve for a requirement to isolate web content from WORK itself.                                      |

A sandbox-preserving same-pod solution still needs a compatible host/runtime policy. An
image swap alone cannot supply it. We do not know the denying node rule and therefore do
not ship speculative seccomp profiles, sysctl/bootstrap changes, privileged containers,
SYS_ADMIN, unconfined settings or a SUID escalation workaround.

## Retrieved official sources and pinned behavior

Sources below were actually retrieved via HTTPS/curl during this revision; no successful
native-browser web session is claimed. Documentation examples are not live-cluster tests.

- [Official MCP Docker instructions](https://github.com/microsoft/playwright-mcp/blob/main/README.md#docker):
  `mcr.microsoft.com/playwright/mcp`, headless Chromium only; stdio `docker run -i --rm
--init`, or long-lived HTTP on port 8931. HTTP adds a reachable service, not an automatic
  authentication/isolation boundary. The README says MCP is **not a security boundary**.
- [Pinned v0.0.83 Dockerfile](https://github.com/microsoft/playwright-mcp/blob/v0.0.83/Dockerfile):
  installs dependencies with `playwright-core install-deps chromium`, browser with
  `install --no-shell chromium`, runs as `node` with tini; entrypoint explicitly includes
  `--headless --browser chromium --no-sandbox`. It is not evidence that sandboxed Chromium
  works under RuntimeDefault. Pin an image version/digest rather than following `latest`.
- [Playwright Docker guide](https://playwright.dev/docs/docker): the image contains browser
  binaries/dependencies, not your Playwright package. For untrusted crawling it recommends a
  separate non-root user **and a seccomp profile permitting user namespace creation**.
  Its root/trusted-test shortcut disables Chromium sandboxing; it is not our security model.
  There is no Kubernetes magic in the image: equivalent pod/host prerequisites still apply.
- [Official remote-server recipe](https://playwright.dev/docs/docker#remote-connection):
  versioned `mcr.microsoft.com/playwright:v1.64.0-noble`, non-root `pwuser`,
  `playwright@1.64.0 run-server --port 3000 --host 0.0.0.0`. Client and server versions must
  match. The documented stable image is **not** a matching substitute for our pinned alpha.
- [Chromium Linux sandbox](https://chromium.googlesource.com/chromium/src/+/main/sandbox/linux/README.md)
  describes namespace, setuid and seccomp layers; [sandbox design](https://chromium.googlesource.com/chromium/src/+/main/docs/design/sandbox.md)
  explains restricting compromised code through OS mechanisms. These differ from the outer
  Kubernetes container boundary.

`npm view @playwright/mcp version` returned **0.0.83**, matching the lockfile. Installed
Playwright is **1.64.0-alpha-1790635538000**, browser revision **1247**, installed at image
build by the lockfile CLI. No package/image upgrade is needed to fix close or choose policy.

The actual pinned `node node_modules/@playwright/mcp/cli.js --help` confirms `--sandbox`,
`--no-sandbox`, `--endpoint`, `--cdp-endpoint`, `--cdp-header`, `--cdp-timeout` and `--port`.
Inspection of installed `playwright-core/lib/coreBundle.js` confirms:

- CLI sandbox maps to `launchOptions.chromiumSandbox`. On Linux, unspecified sandbox defaults
  depend on channel; `chromium` and `chrome-for-testing` default false. Our explicit
  `--browser chromium --sandbox` opts in. Do not generalize the default to all MCP browsers.
- `--endpoint` maps to `browser.remoteEndpoint` (Playwright connection); `--cdp-endpoint`
  uses `chromium.connectOverCDP`. CDP is Chromium-specific and is not the MCP HTTP endpoint.
  Remote launch policy belongs to the remote browser, not a client-side sandbox flag.

## Evidence and verification gate

Prior PR34 runtime evidence: `/ms-playwright/chromium-1247/chrome-linux64/chrome` reached
`No usable sandbox`/SIGABRT. Disposable user, user+mount and user+network namespace probes
returned EPERM. This confirms inability to launch under the combined policy, **not** which
seccomp/AppArmor/sysctl rule denied it. No node audit logs or host policy were inspected.

`npm run browser:smoke` runs a small controlled loopback fixture through the actual
BrowserSession: JavaScript, cross-navigation persistence, screenshot, direct close and
finally cleanup. It never disables sandboxing, downloads a browser or changes pod policy.
A failure before navigation is a failed release gate, not a network or JavaScript verdict.
Unit tests cover repeated/unused/failed-launch close without forwarding upstream close,
reconnect on the next action, cancellation, sanitized environment and directory removal.

Fresh checks for this revision: `npm run verify` passed **37 files / 350 tests**, including
TypeScript, lint, architecture and formatting checks. `npm run browser:smoke` reached the
installed revision 1247 but failed before navigation with **No usable sandbox / SIGABRT**.
Its temporary directory was removed; a subsequent `/proc/*/exe` inspection found no visible
`/ms-playwright/` executables. No screenshot or successful JavaScript execution is claimed.

Before releasing either chosen runtime policy, validate real browser launch, screenshots,
sibling-session isolation, cancellation/process cleanup and actual CNI egress/private-network
restrictions in the candidate WORK pod. No live Kubernetes deployment or node changes are
part of this revision. Until security approval and a passing runtime gate, close is fixed
but browser navigation remains unavailable on the observed restricted runtime.
