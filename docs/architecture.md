# A durable core, ordinary extensions

Kaeno is a personal, self-hosted assistant. Extensibility means understandable source-level composition, not a plugin marketplace or another workflow engine.

## Ownership

- **pi-durable** owns storage, transactions, task scheduling, replay and native extension definitions.
- **Threads and turns** own conversation identity, immutable input provenance, receipt deduplication, control epochs, submission fences, result suppression and replayable replies.
- **Agents** bind explicit model/tool/instruction configurations. WORK's role configurations are separate from the generic binding operation.
- **WORK** owns delegation, frozen policy, parent/child authorization, supervision and cancellation trees.
- **Sandboxes** own physical resources, capacity admission and cleanup. Never bypass the shared admission owner.
- **Channels** authenticate external input and translate protocols. Telegram's offset and turn admission remain in the same native transaction.
- **Application** explicitly constructs dependencies and installs native definitions before opening the harness. There is no runtime module discovery or hot installation.

Features import one another through their public `index.ts`; only application composition constructs another feature. `npm run architecture:check` enforces these boundaries.

## Minimal configuration

Set `work: false` to run a conversational assistant without Kubernetes, a sandbox image or a skill-cache mount:

```json
{
  "work": false,
  "agent": "assistant",
  "templates": {
    "assistant": {
      "description": "Personal assistant",
      "model": "openai/gpt-4.1",
      "instructions": "Answer clearly and honestly."
    }
  }
}
```

The default remains WORK-enabled for existing deployments; those configurations require `sandboxResources`. Disabling new WORK is **not** a way to discard unfinished WORK or its saved bindings. Keep the compatible WORK deployment until its durable dependencies have settled; startup checks intentionally reject missing recovery code.

## Adding an ordinary native feature

1. Add a feature folder with an explicit `index.ts`. Export a factory or class that takes consumer-owned capabilities, not a service locator.
2. Define tools, documents and tasks with pi-durable's native definitions. Choose stable, namespaced durable identities; do not reuse an identity for an incompatible meaning.
3. Supply tool/instruction configuration explicitly. Do not mutate a running registry to install new native code.
4. Wire concrete dependencies in `src/application/`. Services start after compatibility inspection; stop admission and join service callbacks before closing the harness.
5. Add a real restart test and tests for cancellation, retry and any external effects. Keep code required by persisted work installed until that work and its cleanup obligations settle.

For a tiny stateful tool, the shape is an ordinary native definition, not a new extension SDK:

```ts
// Illustrative: imports and domain validation omitted.
const Note = defineDoc({
  kind: "personal.note",
  version: 1,
  scope: "conversation",
  initial: () => ({ text: "" }),
});
const extension = defineExtension({
  name: "personal-notes",
  tools: [readNote, saveNote],
});
```

`saveNote` must resolve authority from the actual admitted turn, reject result-turn mutation, and recheck its origin fence inside the transaction writing `Note`. The assistant tool-policy wrapper is a default-deny first boundary, **not** a substitute for that transactional check. A read tool is read-only because trusted code actually limits its effects, not because its name or model prompt says so. Select assistant policy for assistant conversations, not worker conversations with delegated parent/child rules.

Generic activity results retain their originating request, epoch and route. Native feature callbacks are trusted; do not expose result admission as an unauthenticated network input or let model parameters fabricate an origin.

## Reliability contract

- Admit request identity, provenance, receipt and task together. Retry retention is bounded; this is not an indefinite exactly-once promise.
- Stop/reset commits a fence before old input can proceed. Suppression precedes durable cancellation. Reset may preserve independent work while preventing its old results entering fresh context.
- A pending send can be suppressed. A durably claimed send may complete after reset, and crash recovery can duplicate delivery.
- Creating a durable task and reserving capacity must share admission. A parent holding capacity must not wait indefinitely for a child's slot.
- Collect evidence before deleting a sandbox; release capacity only after physical disappearance. Failed evidence capture must not permanently block cleanup.
- Closing the process does not mean cancelling durable background work.

External network calls are not transactional with SQLite. Record an intent, use provider idempotency where available, and reconcile uncertain outcomes rather than blindly replaying unsafe operations.

## Upgrades and recovery

1. Stop new ingress and join service callbacks, then close the harness.
2. Take a **consistent** SQLite backup and preserve referenced skill trees, images and evidence as appropriate. Do not blindly copy a live SQLite file: WAL and active writers matter. Use a supported backup method or a verified closed/checkpointed database procedure.
3. Deploy a fixed release with all required handlers. `Harness.open` reconciles persisted task state and is not read-only, so back up **before** opening new code.
4. Run compatibility inspection before conversation refresh, scheduling or ingress. Missing task definitions, incompatible saved versions, and missing saved extension/tool references produce actionable errors.
5. Resume only when compatible. Retain compatible handlers, drain, or migrate deliberately. A version change needs a decision about old live state, not a ritual migration when none is needed.

Restoring an old binary against newly migrated state is not necessarily rollback. Fix forward or restore the coordinated data/code backup; that loses subsequent state and cannot undo external effects. Do not blindly abort missing-code tasks to clear diagnostics: their abort cleanup may not execute. Restore cleanup code or use an explicit resource-specific reconciler.

## Kaeno writing its own extensions

Routine scripts and skills run through existing WORK with its configured authority and frozen bindings. Existing WORK environments may contain GitHub/SSH credentials; scope those credentials deliberately. They are not an untrusted-code sandbox.

Native code is a release of the fork: Kaeno can author a branch, tests and a diff; an owner-controlled release policy accepts and deploys it. That may be manual review or deliberately configured CI automation. Ordinary runtime actions do not require a new approval each time. Passing tests or being model-written does not itself confer host trust.

Native imports have full process authority, including environment secrets, database access and infrastructure credentials. Interfaces and architecture checks prevent maintenance mistakes, not malicious JavaScript. Unattended execution of code the owner explicitly distrusts would justify a separately verified restricted runner for a concrete use case; a catalog, broker, per-invocation grant platform and plugin VM are not prerequisites for this design.

## Verification

Run `npm run verify` before releasing. Focused integration coverage includes startup compatibility, minimal no-WORK reopen, generic result authority, existing WORK blueprints, stop/reset races, replay, sandbox admission and teardown ordering.
