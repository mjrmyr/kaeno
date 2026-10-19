# WORK browser tools over MCP

Replacement for rejected PR25 (including PR26's changes to that branch), not a stack on it.
Starts from main `68d135af2dad74d35a30d0d9f83bbe1793df015b`.

## Shape and alternatives

1. **Chosen:** discover schemas from the official server without launching a browser;
   register ordinary durable tools; forward execution over the existing authenticated envd
   connection. One official stdio server per WORK envd owns the browser state.
2. A generic host MCP manager with remote stdio tunnelling would require process/stream
   handles, dynamic registry lifecycle and another cleanup layer. The runtime currently has
   no MCP support. That framework does not earn its place for one server.
3. Host-launched browser sessions would be simpler but give websites the wrong network,
   filesystem and credential boundary. Rejected.

Laziness protocol: reuse tool registration, remote execution, cancellation and WORK sandbox
removal; no browser runner scripts, vendored seccomp policy or general MCP framework.
Boundary discipline: validate the envd request and MCP result at their entry points.

`KAENO_BROWSER_PROXY=http://public-egress-proxy:3128` enables the extension in the host.
Unset means no browser tools offered. This is an operator setting, never a model argument.
Worker defaults include the discovered tools; agents with explicit `tools:` lists must select
browser tools explicitly. The assistant does not receive them by default. Execution without
`RemoteExecutionEnv` fails; it never launches a browser on the host.

The 11 selected upstream tools are navigate, navigate_back, snapshot, click, type, fill_form,
select_option, press_key, wait_for, take_screenshot and close (all `browser_` prefixed).
No run-code, evaluate, uploads, browser installation, storage export or page-defined WebMCP.
Tools retain upstream JSON schemas. MCP text errors and screenshot image blocks reach the
model as actual tool results, not a skill or bash-script convention.

## Deployment prerequisites — disabled by default

**Do not enable until BOTH prerequisites are verified on the actual worker network/runtime.**

- Provision an HTTP forward proxy that rejects non-public IPv4 and IPv6 destinations,
  including loopback, private/link-local, metadata, cluster/service/node ranges, multicast,
  reserved addresses, and DNS rebinding (validate resolved addresses and pin the connection).
  Enforce the same checks on CONNECT, redirects and WebSockets; allow only required public
  ports. No proxy credentials are accepted. The proxy must not expose a private admin service
  on its data port. A URL's spelling is not sufficient validation.
- Enforce worker egress at the network boundary: browser traffic can reach only that proxy,
  with needed DNS/control-plane exceptions narrowly scoped. This prevents direct protocols
  such as WebRTC from bypassing HTTP proxying. Browser proxying disables Chromium's implicit
  loopback bypass, but is **not itself a security boundary**. Playwright origin allow/block
  lists are also not a security boundary and explicitly do not cover redirects. Existing
  generic sandbox networking has not been upgraded by this PR. No homelab changes or deploy.

Chromium is launched with **`--sandbox`**, never `--no-sandbox`. The image remains non-root;
existing Kubernetes `RuntimeDefault`, dropped capabilities and `allowPrivilegeEscalation:false`
are unchanged. Linux must permit unprivileged user namespaces and the necessary namespace
syscalls under its seccomp/AppArmor policy. Some RuntimeDefault profiles prohibit them;
those deployments will fail browser launch. An operator-reviewed, narrowly scoped Localhost
seccomp/AppArmor policy may be necessary; no blanket privileged/unconfined fallback is supplied.
This PR deliberately does not claim current production Kubernetes compatibility.

The image installs Chromium and OS dependencies at build time using the **lockfile-pinned**
Playwright CLI. `@playwright/mcp` is 0.0.83; its matching Playwright is
1.64.0-alpha-1790635538000 / Chromium revision **1247**. Upstream currently pins an alpha
Playwright revision; do not independently substitute a stable browser package.
`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` is shared read-only by non-root browser processes.

## State, cleanup, credentials and limits

Schema discovery uses an in-memory MCP connection in the host, closes it immediately, and
never invokes browser tools. Actual tools use an official SDK stdio transport inside envd.
The child receives only fixed POSIX identity/shell values, PATH, temporary HOME/TMPDIR and browser-cache location: no provider,
envd, SSH, GitHub or ambient proxy credentials. Its cwd is a fresh temporary directory, not
`/workspace`; no authenticated browser profile or storage state is imported.

The envd singleton matters: remote environment objects are recreated per tool call. Keying
sessions by transient RPC client ID would silently lose state. WORKs have separate envd
pods/containers, so siblings cannot share the browser. State persists across calls, not WORK
completion, server restart or idle expiry. Closing the browser preserves the MCP process.
Cancellation/transport failure tears down the MCP process and temporary directory; the next
call starts fresh. `/cleanup`, envd SIGTERM, and sandbox destruction also clean up. Stdio SDK
shutdown escalates from close to TERM/KILL; pod deletion is the final process boundary.

Calls are sequential, with concurrent calls rejected at envd. Action/navigation timeouts are
10/30 seconds, MCP calls 40 seconds, total signal deadline 45 seconds (shutdown can add SDK
termination grace), and idle process expiry 5 minutes. More than 8 tabs observed after an action
resets the session; this is a post-action guard, not a hard instantaneous popup/resource quota.
WORK container CPU/memory and lifetime limits remain authoritative. Output files are evicted
at 16 MiB. The SDK stdio framing buffer is capped at 4 MB; parsed responses above 4 MB also reset the session.
Model results retain at most 32 KiB of text and one image of at most 2.8 million base64
characters; larger images are omitted explicitly. SDK framing remains upstream-owned.
Web content is untrusted; no auth/CAPTCHA bypass, purchases or bookings are supported.

## Verification

`npm run verify` exercises the existing suite plus official MCP schema discovery, real model
registration, sandbox-only routing, text/image forwarding, sanitized stdio setup, state reuse,
cleanup, cancellation, tool/proxy validation and tab limits. Session lifecycle tests mock the
SDK process. HTTP envd tests use a fake browser capability, not Chromium.

In the development sandbox, downloading the pinned browser succeeded, and a real stdio MCP
`browser_navigate` request reached Chromium launch. Launch failed due to missing
`libglib-2.0.so.0`; the non-root sandbox cannot install OS packages. No successful JavaScript
navigation, image build, egress isolation or Kubernetes sandbox launch is claimed. Before
enabling, build the image and verify a controlled JS page, persistence, screenshots, cancellation,
and private/metadata/redirect/rebinding denials under the actual enforced proxy/network policy.
