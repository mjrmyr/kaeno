# Conversation tool authority

`assistantToolPolicy(getHarness, tools, readOnlyNames)` produces the native `kaeno-tool-authority` extension. The host passes the complete tool registration set so native wrappers can be installed; each conversation's resolved `tools` list separately determines which tools are offered. Every offered tool is mutating unless its name is explicitly classified read-only. Duplicate tool names fail composition.

Authority comes from active-turn provenance, never model arguments or prompt text. Read-only tools can run on admitted result turns. Mutation wrappers require an actual user-origin turn and a current, unfenced origin. Durable mutations must still recheck their origin fence in the transaction that admits their effect; a tool wrapper is not an atomic authorization token.

## Composition

- Install matching definitions of the stable policy extension before `Harness.open`.
- Select the policy alongside the native owners of a conversation's explicitly selected tools.
- Never use an extension's installed tools as an implicit assistant/worker selection. In particular, `tools: []` remains empty.
- WORK's `start_work` is mutating; its effect handler rechecks the active CHAT origin in the admission transaction. Child WORK selection comes from its frozen plan and remains within core's delegation/depth rules.
- Skills and other bindings are data, not tool grants. An extension-owned binding can be validated by its installed owner; it cannot add a tool or bypass this policy.

Native wrappers target known names; there is no global unknown-tool hook. Rebuild policy from the installed registration set, then configure the exact selected tool names for each conversation.
