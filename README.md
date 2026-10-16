# Kaeno

A small persistent host for [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable). No tools, execution environment, network ingress, or job orchestration are installed by default. Requires Node.js 24+ and a **single process per SQLite database**; Pi Durable's SQLite storage does not coordinate concurrent writers across processes.

This is a minimal replacement, not a compatibility migration of the previous application. Start with a fresh database. Keep the previous release available to drain its pending work; legacy Telegram, Kubernetes, artifact, HTTP and WORK/CHAT features are intentionally absent.

## Quick start

```sh
npm install
OPENAI_API_KEY=... npm start -- ./kaeno.sqlite main
# Optional, grants filesystem/process access to the model:
KAENO_LOCAL_CODING=1 OPENAI_API_KEY=... npm start -- ./kaeno.sqlite main
```

The CLI uses OpenAI `gpt-4.1` by default (`KAENO_MODEL` overrides). Enter an empty line to exit. The database and named conversation survive restart. This CLI only prints final text; applications can subscribe to the native conversation watch for streaming.

## Embed and extend

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { openWorkspace } from "./src/index.ts";
import { localCoding } from "./src/local.ts";

const models = createModels();
models.setProvider(openaiProvider());
const echo = defineTool({
  name: "echo",
  description: "Echo text",
  parameters: Type.Object({ text: Type.String() }),
  execute: async ({ text }) => ({ content: [{ type: "text", text }] }),
});
const workspace = await openWorkspace({
  database: "./kaeno.sqlite",
  models,
  agent: { model: { provider: "openai", modelId: "gpt-4.1" } },
  extensions: [
    { definition: defineExtension({ name: "echo", tools: [echo] }) },
    // localCoding, // explicit opt-in for read/write/edit/bash + NodeExecutionEnv
  ],
});
try {
  const chat = await workspace.conversation("main");
  const submission = await chat.submit(
    { type: "input", content: "Hello" },
    BACKGROUND_CONTEXT,
  );
  console.log(await submission.wait(BACKGROUND_CONTEXT));
  // chat.submit({ type: "input", content: "Correction", whenBusy: "steer" }, BACKGROUND_CONTEXT);
  // chat.abort(...), chat.reset(...), chat.fork(...), chat.watch(...)
} finally {
  await workspace.close();
}
```

`openWorkspace` installs native Pi Durable definitions **before** opening the harness. Named conversations, including their initial agent, are created in one atomic commit in a session document. The host returns native `Conversation` handles: use their `submit`, `abort`, `reset`, `fork`, `watch`, `configure` and `commit` operations directly. `workspace.harness` is a trusted host API for custom services/tasks. Extensions can also provide **one** execution-environment factory and an optional `start(workspace)` returning an async stop function (for example, a future ingress adapter). Startup checks every live task record, including waiting parents, and requires an installed definition with exactly the saved version. This minimal host does not run task migrations: drain with matching code or perform a deliberate offline upgrade. Reinstall task definitions before reopening; do not remove them while work is pending. Startup failures unwind started services; close stops ingress in reverse order before closing the harness, even if a stop fails.

### Service and execution seams

A channel adapter starts and stops as an ordinary extension service:

```ts
const channel = {
  definition: defineExtension({ name: "my-channel" }),
  async start(workspace) {
    // Start an authenticated ingress here. Each incoming message resolves
    // workspace.conversation(channelKey) and calls its native submit().
    // Keep stable requestId values for retried messages.
    const stopIngress = await startMyIngress(workspace);
    return async () => {
      await stopIngress();
    }; // stop and join callbacks
  },
};
```

`startMyIngress` above is your adapter, not a built-in Kaeno function. A Kubernetes adapter instead supplies `env(target, context)`, returning an implementation of Pi Durable's `ExecutionEnv`. It can install durable provision/cleanup tasks in `definition.tasks` and store its bindings using native documents. No Kubernetes types or pod policy belong in this core. Only one environment provider may be installed; that provider can route by conversation itself. Services start before Kaeno explicitly resumes recovered tasks. Construct execution dependencies before calling `openWorkspace`; `start` is for ingress, not initialization required by task handlers. Native submit/wait APIs can start scheduling themselves, so ingress that submits during startup can trigger recovery before all services start; startup is not a transaction and cannot undo effects. A service that throws during its own startup must clean up its partial resources; Kaeno unwinds the services that already returned stop functions.

Native `abort()` only stops foreground work unless its background option is set; `reset()` changes model context, not application-specific resource ownership. The legacy epoch/provenance and work-cancellation protocol is not retained. An ingress extension must authenticate and authorize its own clients; privileged effect extensions own their idempotency and recovery policies. A database commit does not make an external effect exactly-once. Closing a view is not cancellation.

Extensions are **fully trusted native code**, not sandboxed plugins. Tools can be offered to the model and may perform arbitrary side effects; `localCoding` in particular grants local execution. There is no dynamic loader or hot reload. Pi Durable handles task checkpoints, submissions, watches, and recovery; no Kaeno command layer is involved. The `agent` option initializes _new_ named conversations only; reopen preserves the existing agent. See the Pi Durable README for native API and recovery semantics.

Run `npm run verify` for typecheck, lint, format, and real SQLite/faux-model tests.
