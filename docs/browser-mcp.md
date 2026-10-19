# WORK browser tools over MCP

Proxy-free follow-up to PR27's official MCP integration. No proxy service, new environment
variable or deployment change is introduced. Chromium renderer sandboxing is explicitly
disabled with owner approval; pod security settings are unchanged.

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
removal; no vendored seccomp policy or general MCP framework.
The runtime smoke command and researched deployment alternatives are documented in
[browser-runtime-gate.md](browser-runtime-gate.md).
Boundary discipline: validate the envd request and MCP result at their entry points.

The host always registers the extension; schema discovery does not launch Chromium.
Worker defaults include the discovered tools; agents with explicit `tools:` lists must select
browser tools explicitly. The assistant does not receive them by default. Execution without
`RemoteExecutionEnv` fails; it never launches a browser on the host.

The 11 selected upstream tools are navigate, navigate_back, snapshot, click, type, fill_form,
select_option, press_key, wait_for, take_screenshot and close (all `browser_` prefixed).
No run-code, evaluate, uploads, browser installation, storage export or page-defined WebMCP.
Tools retain upstream JSON schemas. MCP text errors and screenshot image blocks reach the
model as actual tool results, not a skill or bash-script convention.

## Existing WORK network boundary and runtime prerequisites

Browser traffic uses the WORK's existing network directly, just like other WORK processes.
There is no proxy argument, proxy session state, Chromium proxy flag, or separate browser
network policy. Reuse the deployed WORK NetworkPolicy; this change does not modify it or
make homelab/Myriad infrastructure changes.

With an enforcing CNI, the WORK policy blocks its **configured** private/LAN, tailnet and
link-local IPv4 ranges and leaves off-pod IPv6 default-denied when no IPv6 allow rule exists.
This is not a claim of perfect public-only networking. The repository's example
[`cluster.yaml`](../src/extensions/kubernetes/cluster.yaml) excludes RFC1918, 127/8 and
169.254/16 from its IPv4 allow rule; it does **not** include tailnet 100.64/10 or every
cluster/node/reserved range. Check the actual deployed exclusions and DNS exceptions rather
than assuming the example covers your LAN/tailnet. The local [microsandbox](microsandbox.md)
backend applies microsandbox's own egress policy instead; Kubernetes policy guarantees do not
apply there.

Pod loopback is **not isolated** by NetworkPolicy, even with 127/8 in an ipBlock exclusion.
Node traffic and CNI-specific exceptions can also escape the expected policy boundary.
Websites can attempt to contact loopback services, including envd. Envd bearer authentication
protects its operational routes (`/healthz` is unauthenticated); hiding its token from the
browser environment is not a substitute for route authentication or OS process isolation.
Do not infer redirect, DNS-rebinding or metadata denial from URL validation or browser flags.
Verify the actual pod/runtime network behavior before relying on it for untrusted pages.

Chromium is launched with explicit **`--no-sandbox`**, an owner-approved security tradeoff
for the existing restricted ephemeral WORK pod. This removes Chromium renderer isolation;
container/pod isolation is the outer boundary, **not equivalent protection**. A compromised
renderer may access WORK files, same-UID processes, network/loopback and potentially the
envd token. Sanitized environment variables do not prevent same-identity process access.
The image remains non-root; Kubernetes `RuntimeDefault`, dropped capabilities,
read-only root and `allowPrivilegeEscalation:false` are unchanged. No custom node profiles,
privileges, network changes, new services or environment variables are introduced.
See the [deployment decision](browser-runtime-gate.md) for official-source alternatives,
residual risks and runtime verification limits. There is no automatic fallback.

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
This sanitizes inherited environment variables; it is **not OS process isolation** from
other processes under the same WORK identity.

The envd singleton matters: remote environment objects are recreated per tool call. Keying
sessions by transient RPC client ID would silently lose state. WORKs have separate envd
pods/containers, so siblings cannot share the browser. State persists across calls, not WORK
completion, server restart or idle expiry. Closing the browser tears down the MCP process locally; it never calls upstream close,
which can initialize/relaunch Chromium even after a failed launch. Repeated close is a no-op.
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
cleanup, cancellation, tool validation, proxy-free requests, explicit worker tool selection
and tab limits. Session lifecycle tests mock the
SDK process. HTTP envd tests use a fake browser capability, not Chromium.

`npm run browser:smoke` exercises the real BrowserSession against a loopback fixture:
JavaScript, cross-navigation session persistence, screenshot and direct close. It keeps
the explicitly approved `--no-sandbox` policy; it never changes pod security or retries
with extra privileges. A launch failure is a failed gate.
Run it in the candidate WORK image/pod. Unit tests alone do not prove browser startup,
real process cleanup, CNI enforcement or private-network isolation. Before release, verify
those properties and sibling-session isolation/cancellation in the actual cluster.
