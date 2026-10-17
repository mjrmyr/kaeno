# Kaeno

A small, self-hosted durable assistant core. Conversations survive restarts; tools, background tasks, channels and execution environments come from explicitly installed extensions.

The CLI includes Docker-backed WORK orchestration. [Worker configuration](docs/work.md) defines the agents Kaeno can choose from; every configured worker is available directly.

**Not included:** Telegram, Kubernetes, skill repository integration, or a plugin marketplace.

## Run

Node.js 24 or newer:

```sh
npm ci
cat > config.json <<'JSON'
{
  "model": "openai/gpt-4.1",
  "instructions": "You are my personal assistant. Answer clearly."
}
JSON
export OPENAI_API_KEY=...
export KAENO_CONFIG="$PWD/config.json"
export KAENO_DB="$PWD/kaeno.sqlite"
export KAENO_TOKEN="$(openssl rand -hex 32)"
npm start
```

The optional HTTP adapter listens on `PORT` (default `8080`) when `KAENO_TOKEN` is set. Without it, no HTTP listener starts. The CLI supports `openai`, `anthropic` and `openrouter`; embedding accepts a native model registry with any configured provider.

```sh
curl -N http://localhost:8080/v1/threads/personal/turn \
  -H "Authorization: Bearer $KAENO_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello","requestId":"request-0001"}'
```

The API also provides thread listing, reply cursors, stop and reset. Disconnecting a client does not cancel an admitted turn. See `src/api/api.ts` for the intentionally small protocol.

## Plug in capabilities

The embedding entry point is `openKaeno` in `src/application/index.ts`. Extensions use pi-durable's native definitions; there is no loader or alternate task runtime.

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openKaeno } from "./src/application/index.ts";

const echo = defineTool({
  name: "echo",
  description: "Echo supplied text without side effects",
  parameters: Type.Object({ text: Type.String() }),
  execute: async ({ text }) => ({ content: [{ type: "text", text }] }),
});

const core = await openKaeno({
  storage, // a native storage adapter, e.g. openNodeSqliteStorage(path)
  models, // a configured native model registry
  assistant: {
    model: { provider: "openai", modelId: "gpt-4.1" },
    instructions: "Use your tools when useful.",
  },
  extensions: [
    {
      durable: defineExtension({ name: "personal-echo", tools: [echo] }),
      readOnlyTools: [echo.name],
    },
  ],
});

// Later, after stopping input and joining your own services:
await core.close();
```

An extension can also supply:

- **Native tasks, sections, hooks and wrappers** through `durable`.
- **`environment`**, a native execution-environment provider—enough to attach an execution backend later without adding Kubernetes policy to the core.
- **`delivery: { channel, send, typing? }`**, for origin-bound durable replies.
- **`start(core, signal)`**, for a channel listener or reconciler; return an async cleanup function. Abort signals stop ingress first; Harness then quiesces durable invocations, and reverse-order cleanup disposes extension resources. Cleanup must not access the closed harness.

A channel uses `core.threads` and `core.turns`; it can advance its own cursor and admit a user turn inside the **same native transaction**. A task can report via `admitActivityResult`. Extensions own their resources and native abort handlers; stop suppresses results and requests background activity cancellation. `test/integration/extensions.test.ts` demonstrates tasks, documents, tools, delivery, execution, transactional ingress, cleanup and SQLite reopen together.

Native extensions are trusted process code. Every assistant tool defaults to mutating unless explicitly marked read-only. Result turns cannot invoke mutations; mutation implementations must additionally recheck the origin fence inside the transaction admitting their effect. This is not a sandbox for malicious code.

## Reliability and scope

The core keeps durable input receipts, provenance, stop/reset fences, causal results, reply replay, startup compatibility checks and managed shutdown. It intentionally does not implement every capability itself.

Use a **fresh database** for this core-only version. It is a deliberate removal of the old product, not a migration of its WORK/Telegram state. Startup refuses missing saved definitions rather than silently deleting work. Preserve your old release and a consistent backup if you need to finish old workloads.

Definitions stay fixed until restart. Take a consistent SQLite backup **before** opening a new release; opening the harness writes recovery reconciliation state. Restoring old code alone is not rollback. External side effects are not transactional with SQLite; deliveries can duplicate after a crash.

[Architecture and extension contract](docs/architecture.md)

```sh
npm run verify
```
