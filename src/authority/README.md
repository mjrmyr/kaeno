# CHAT tool authority

`assistantToolPolicy(getHarness, tools, readOnlyNames)` produces the native
`kaeno-tool-authority` extension. Every selected tool is mutating unless its name
is explicitly listed as read-only. Duplicate tool names fail construction.
Authority comes from core `activeTurn` provenance, never model arguments or text.
Read-only tools can run on admitted result turns.

## Composition integration

Install the extension in the native registry, then select it **only for CHAT**.
At `chatAgentConfiguration` in `src/agents/agent-roles.ts`, pass the complete final
CHAT tool array (including `read_skill` when present) to the policy and include
its extension in CHAT's `extensions`. Explicit read names on today's surface are
`list_work`, `inspect_work`, and `read_skill`. Do not select the policy in
`workAgentConfiguration`: child/delegated authorization remains owned by WORK.
The registry installation belongs alongside other extensions in
`src/application/kaeno.ts`. These composition files are intentionally not edited
by this scoped implementation.

Native wrappers target known names; there is no global unknown-tool hook. Rebuild
this policy from the complete selected tool surface whenever composing CHAT, so
new tools default to mutation rather than silently escaping the boundary. Install
and select matching definitions of the stable extension name.

## Effect admission still owns atomicity

Immediately before invoking a mutation, the wrapper resolves the actual active
submission and receipt through `activeTurn`, requires `source.kind === "user"`,
and rechecks `TurnLedger` for the origin epoch and absence of control. Missing or
unadmitted provenance fails closed.

This check cannot make a later external effect atomic. Durable mutation code
must carry the trusted origin into its actual effect-admission commit and
recheck epoch/control there (for example via `TurnCoordinator.isOriginFenced`).
Commit a durable effect intent there before dispatching external work, with the
owner's replay/idempotency strategy. Do not replace those checks with this wrapper
or interpret its admission as a reusable authorization token.
