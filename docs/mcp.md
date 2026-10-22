# Owner-configured MCP tools — production phase 1

This implements **host HTTP** MCP tools. MCP is an extension: ordinary
`AgentExtension.runtime.durable.tools`, ordinary selectors and native recovery.
There is no MCP registry in core, generic `mcp_call`, new selector, definition reader,
credential broker or change to GitHub's App/token/checkout/publish path.

## What ships, and what does not

| Area                | This phase                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host transport      | Streamable HTTP (JSON or SSE responses), fresh initialize/list/call/DELETE/close per call. No host session reuse or automatic retry.                                                           |
| Host authentication | None, or host-only `headerFiles`, re-read each call.                                                                                                                                           |
| Contracts           | All-page discovery at startup; allowlisted tools register with the advertised description and input schema. No lock file or review command.                                                    |
| Policy              | Independent owner `readOnly`, `replay`, `executionMode`; defaults false / unsafe / sequential.                                                                                                 |
| Removal             | Removing a tool or server unregisters it. Native recovery refuses startup while saved conversations still reference it.                                                                        |
| Lifecycle           | Tool cancellation and harness shutdown abort/close active transports; extension cleanup joins outstanding calls. Discovery closes its connection before startup continues.                     |
| WORK use            | Workers can select the **host HTTP tools**. Calls still run on the host; credentials never enter `api.env` or a sandbox. Sandbox-run servers are [WORK MCP](#work-mcp-servers-in-the-sandbox). |
| **Not implemented** | Owner-configured WORK servers, image digest, contract pinning/drift detection, OAuth login/refresh/seed changes, tool retirement, discovery report/annotation warnings.                        |

Browser is the first [WORK MCP server](#work-mcp-servers-in-the-sandbox); the old
`/browser` envd route is gone.

Resources, prompts, audio, tasks, sampling, elicitation, roots, legacy SSE transport,
progress/log forwarding, owner-configured executables, host stdio and work HTTP are
not supported. Content blocks for resources/links/audio become markers and are never
fetched. Output schemas and other upstream metadata do not become policy or compiled
validators. Initialization instructions are not added to prompts.

## Setup

Use owner-controlled files **on the host**, not in a WORK checkout or shared sandbox
mount. `mcp.json` is privileged network configuration, not agent input.

```json
{
  "servers": {
    "issues": {
      "url": "https://mcp.example.internal/mcp?resource=engineering",
      "auth": {
        "headerFiles": { "Authorization": "issues.authorization" }
      },
      "tools": [
        { "upstream": "get_issue", "readOnly": true },
        { "upstream": "create_comment" }
      ]
    }
  }
}
```

Use the vendor's actual endpoint and upstream tool names. Omit `auth` for an
unauthenticated server. Relative header file paths resolve next to the config, not
against the working directory. File contents are complete header values, for example
`Bearer ...`, with surrounding whitespace trimmed. Header names are limited to
`Authorization`, `X-Api-Key`, `Api-Key`, `X-Auth-Token` (case insensitive); cookies,
routing/MCP protocol headers and process environment injection are rejected.

```sh
mkdir -p ~/.kaeno && chmod 700 ~/.kaeno
# Create mcp.json from the example above, with your reviewed endpoint/tool names.
# Write the credential locally; never paste it into a model conversation.
printf 'Bearer REPLACE_LOCALLY\n' > ~/.kaeno/issues.authorization
chmod 600 ~/.kaeno/issues.authorization
KAENO_MCP_CONFIG="$HOME/.kaeno/mcp.json" npm start
```

Kaeno discovers all configured servers in parallel at startup (30 s budget). An invalid
`mcp.json` fails startup. A server that is unreachable, rejects credentials or returns
invalid advertising does **not**: Kaeno logs `mcp: <id>: ...` and keeps starting. Its
allowlisted tools, and any allowlisted tool a reachable server does not advertise, are
registered as placeholders: they keep saved conversations and profile selections valid,
are left out of worker defaults, and return `not_loaded` without sending a request.
Restart Kaeno once the server is back. Tools the server advertises but the config does
not list are never registered.
**Other features, notably definition sources, retain their existing startup behavior.**

Tools are named `<id>_<upstream>`, except already-prefixed upstream names stay unchanged.
Server IDs match `^[a-z][a-z0-9]{0,15}$`; derived names must fit 64 characters (`__proto__` is not an owner-configurable upstream name). Collisions
and duplicate allowlist entries are rejected. Owner extension names are `kaeno-mcp-<id>`.
Profiles can request `tools: [issues_get_issue, issues_create_comment]` within role policy.

The feature derives its policy, and `src/host/main.ts` composes it:

- Assistant availability: live `readOnly: true` tools only. No MCP assistant defaults.
  The assistant profile must explicitly request the read tools it needs.
- Worker availability: entire extensions. Worker defaults: all allowlisted tools.
- `readOnly` means result-turn permission, **not** safe replay or concurrent execution.
  `replay: "safe"` and `executionMode: "parallel"` are separate, explicit owner grants.
  Untrusted MCP annotations grant nothing.

## Contract and endpoint guarantees

Startup takes the description and object input schema from the server's advertising
(description at most 4096 characters, schema at most 32 KiB serialized). Calls do not
re-list tools: if the server changes a schema while Kaeno runs, the call goes through and
the server validates it. Restart Kaeno to pick up changed descriptions or schemas.
Review the server's advertised tools yourself before allowlisting them; nothing pins
their contracts or proves read-only behavior, replay safety, concurrency safety,
correct authorization or server honesty.

The endpoint is the complete normalized HTTP URL, including path and resource-selecting
query. Same-origin path/resource changes are mismatches, not equivalent endpoints.
HTTPS is required except on loopback (`localhost`, `127.0.0.1`, `[::1]`). Userinfo,
fragments and credential-like query keys are rejected without echoing the raw URL.
All redirects are refused, **including same-origin redirects**: credentials must go to
exactly the reviewed resource, a deliberate stricter choice than the design's origin rule.

Query detection is conservative, **not a universal secret detector**. Owners must review
all query values and path segments as credential-free; put secrets only in header files.
Private-address endpoints are permitted because this is privileged owner configuration.
This is not an SSRF boundary against a malicious owner or a DNS rebinding defense.

## WORK MCP: servers in the sandbox

Servers that act on a machine rather than call an API, such as a browser, run inside each
WORK sandbox instead of on the host. Each is a code-declared `WorkServerRecipe`
(`src/extensions/mcp/work.ts`) owned by its feature: an upstream tool allowlist, the stdio
command line and its whole environment, limits, and optional guards. The binary must be in
the WORK image, and the recipe has no credential field. Owner config cannot add one.

- **Startup:** the host lists the recipe's tools from a short-lived local process, then
  stops it (Playwright does not launch Chromium for that). Failure logs `mcp: <id>: ...`
  and registers placeholders, like a host server. Tools are worker-only.
- **Calls:** model → Kaeno → envd `/mcp` → `WorkMcpHost` → stdio child in the sandbox.
  envd re-checks the server and allowlist. Calls without a WORK sandbox are refused.
- **State:** one lazily started session per (WORK, server), owned by envd and kept across
  calls, so each WORK has its own browser. Calls are single-flight; a concurrent call is
  rejected. Any error, cancellation, deadline, oversize or guard failure discards the
  session. `/cleanup`, envd SIGTERM and sandbox deletion close it.
- **Results** use the same bounds as host tools (32 KiB text, one image).
- **Skew:** a host with this change cannot call an adopted sandbox running an older envd
  without `/mcp`; start a new WORK.

Adding a server: write a recipe in its feature, add it to `new WorkMcpHost([...])` in
`src/host/envd.ts`, register it with `workMcpTools(recipe)` in `src/host/main.ts`, and
install its binary in the `Dockerfile`. Browser (`src/extensions/browser/recipe.ts`) is
the reference.

## Removal and recovery

Delete tools or a whole server from `mcp.json` and restart. Unlike a server that is
merely down, a deleted entry gets no placeholder. Native recovery refuses to
start while saved conversations or frozen WORK plans still reference a removed tool or
extension; keep those entries in the config until that history is settled. Changing a
server's `url` keeps its tool names.

## Limits, failures and credentials

- Connect and individual list requests: 15 s. Tool call: 60 s. Whole invocation: 75 s.
  Best-effort DELETE is allowed up to another 500 ms; local transport closure is unconditional.
- Total response bytes across one connection: 4 MiB, counted while streaming (including
  SSE/JSON/discovery), not only after buffering a result. Discovery also caps 256 pages
  and 1024 tools and rejects duplicate names/cursor loops. Arguments: at most 1 MiB.
- Results: cumulative 32 KiB UTF-8 text plus a truncation marker; at most one image of
  at most 2,800,000 base64 characters (PNG/JPEG/GIF/WebP). Structured content becomes bounded
  JSON text only if no text block exists. `isError` is preserved; control/metadata is not.
- Known credential values (and bearer tokens without the scheme, including JSON-escaped
  spellings) are redacted in text. Credential echoes in advertised contracts are refused,
  not shown to models. Errors use fixed, short diagnostics, never raw SDK bodies/headers.
  This is exact-value redaction, not a DLP guarantee against transformed/encoded secrets,
  secret-containing images or a deliberately malicious server.
- Header files must be regular files, at most 8 KiB each, with nonempty, single-line values.
  No host executable is launched; no inherited process environment, model provider
  credentials, roots or host filesystem API is offered to MCP. Only configured headers
  and explicit tool arguments cross the network boundary.
- HTTP 401/403 fails `auth_required`; there is no runtime interactive login, OAuth refresh,
  reactive SDK `authProvider` or retry. Rotation takes effect on the next call.

Cancellation, timeout or transport failure can happen **after an effect ran upstream**.
Closing a session is not a rollback. We close the transport before returning and never
reuse it; unsafe calls are not silently retried. The model/owner must resolve uncertain
outcomes. Servers requiring continuity across calls are unsupported on the host.

## Verification

The implementation uses the existing native extension/composition/lifecycle seams and
does not depend on `definitionReaders`.

`src/extensions/mcp/contract.test.ts` checks native projection/policy/name/refusal rules.
`test/integration/mcp.test.ts` runs the real SDK client against a real loopback HTTP SDK
server (no external endpoints/credentials). It covers multi-page startup discovery,
startup failure on an unavailable server or missing tool, calls/reconnect, role policy,
rotation/redaction, failed initialize/call/start, cancellation, shutdown, controlled-clock
call deadline, wire/input/output limits, pagination/redirect/auth refusals and SQLite
recovery of saved tool and extension references.

Run `npm run verify`. These tests exercise production code; passing unrelated repository
or Browser tests alone is not evidence for the host MCP integration. No live cluster,
external MCP account or OAuth is verified. `test/integration/work-mcp.test.ts` runs a real
stdio fixture server through real envd: discovery, per-WORK state across transient
clients, cleanup, environment sanitization, allowlist/server re-checks, host refusal and
placeholders.
