import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { watchEvents, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { z } from "zod";
import { openKaeno } from "../core/application/index.ts";
import { DEFAULT_AUTH_FILE, FileCredentialStore } from "./auth/index.ts";
import { loadEnvironment, loadExecution } from "./composition/index.ts";
import { openDataDirectory } from "./storage/index.ts";
import {
  githubExtension,
  loadGitHubConfiguration,
} from "../extensions/github/index.ts";
import { parseModelRef } from "../extensions/agents/index.ts";
import { ApiServer } from "../extensions/api/index.ts";
import { loadTelegram } from "../extensions/telegram/index.ts";

import { loadMcpConfiguration } from "../extensions/mcp/index.ts";
import { memoryExtension, MemoryStore } from "../extensions/memory/index.ts";
import { Routines, RoutineStore } from "../extensions/routines/index.ts";
import { browserExtension } from "../extensions/browser/index.ts";
import { dockerExecutionProvider } from "../extensions/docker/index.ts";
import { kubernetesExecutionProvider } from "../extensions/kubernetes/index.ts";
import { microsandboxExecutionProvider } from "../extensions/microsandbox/index.ts";

const data = await openDataDirectory(process.env.KAENO_DATA_DIR ?? "/data");
const memory = new MemoryStore(data.kaeno);
// Owner memory belongs to the assistant only: workers get the facts they need in their brief.
const memoryTools = { runtime: memoryExtension(memory) };
const routines = new Routines(new RoutineStore(data.kaeno), (error) =>
  console.error("routines:", error),
);
// Kaeno may list routines; only the owner creates, changes or runs them.
const routineTools = { runtime: routines.extension() };
const mcp = process.env.KAENO_MCP_CONFIG
  ? await loadMcpConfiguration(process.env.KAENO_MCP_CONFIG)
  : undefined;
for (const diagnostic of mcp?.diagnostics ?? []) {
  console.error(`mcp: ${diagnostic}`);
}
const browser = await browserExtension();
for (const diagnostic of browser.diagnostics) {
  console.error(`mcp: ${diagnostic}`);
}
const githubExtensions = [
  process.env.KAENO_GITHUB_CONFIG
    ? await loadGitHubConfiguration(process.env.KAENO_GITHUB_CONFIG)
    : githubExtension(),
];
const configuration = await loadEnvironment({
  extensions: [
    ...githubExtensions,
    browser.extension,
    memoryTools,
    routineTools,
    ...(mcp?.extensions ?? []),
  ],
  policy: (base) => ({
    assistant: {
      available: [
        ...base.assistant.available,
        ...githubExtensions,
        memoryTools,
        routineTools,
        ...(mcp?.policy.assistant.available ?? []),
      ],
      defaults: [
        ...base.assistant.defaults,
        ...githubExtensions,
        memoryTools,
        routineTools,
      ],
    },
    worker: {
      available: [
        ...base.worker.available,
        ...githubExtensions,
        browser.extension,
        ...(mcp?.policy.worker.available ?? []),
      ],
      defaults: [
        ...base.worker.defaults,
        ...githubExtensions,
        browser.live,
        ...(mcp?.policy.worker.defaults ?? []),
      ],
    },
  }),
  configFile: process.env.KAENO_CONFIG ?? ".kaeno/config.json",
  sourceMode: z
    .enum(["refresh", "offline"])
    .parse(process.env.KAENO_SOURCE_MODE ?? "refresh"),
  defaultModel: process.env.KAENO_DEFAULT_MODEL
    ? parseModelRef(process.env.KAENO_DEFAULT_MODEL)
    : undefined,
  maxDepth: z.coerce
    .number()
    .int()
    .min(1)
    .max(8)
    .parse(process.env.KAENO_WORK_MAX_DEPTH ?? 2),
  maxConcurrent: z.coerce
    .number()
    .int()
    .positive()
    .parse(process.env.KAENO_WORK_MAX_CONCURRENT ?? 4),
});
for (const diagnostic of configuration.diagnostics) {
  console.error(`configuration: ${diagnostic.location}: ${diagnostic.message}`);
}
const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.PORT ?? 8080);

const execution = await loadExecution(
  configuration.execution,
  data.durableFile,
  [
    dockerExecutionProvider,
    kubernetesExecutionProvider,
    microsandboxExecutionProvider,
  ],
);
const credentials = new FileCredentialStore(
  process.env.KAENO_AUTH_FILE ?? DEFAULT_AUTH_FILE,
);
if (process.env.KAENO_AUTH_SEED_FILE) {
  console.log(
    `credential seed: ${await credentials.importSeed(process.env.KAENO_AUTH_SEED_FILE)}`,
  );
}
const models = createModels({ credentials });
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
models.setProvider(openrouterProvider());
const telegram = await loadTelegram(process.env);
const core = await openKaeno({
  storage: await openNodeSqliteStorage(data.durableFile),
  models,
  assistant: configuration.assistant,
  extensions: [
    ...configuration.extensions,
    ...execution.extensions,
    ...(telegram ? [telegram] : []),
  ],
  work: { ...configuration.work, environment: execution.environment },
  onReport: (error) => console.error("harness:", error),
});
let server: ApiServer["server"] | undefined;
let closing: Promise<void> | undefined;
function close(): Promise<void> {
  closing ??= (async () => {
    try {
      const current = server;
      if (current?.listening) {
        const stopped = new Promise<void>((resolve, reject) =>
          current.close((error) => (error ? reject(error) : resolve())),
        );
        current.closeAllConnections();
        await stopped;
      }
    } finally {
      try {
        await core.close();
      } finally {
        data.kaeno.close();
      }
    }
  })();
  return closing;
}
try {
  const trace = await core.harness.watchTaskGraph(BACKGROUND_CONTEXT);
  let previous = trace.value.tasks;
  const observed = new Set<ConversationId>();
  console.log("assistant tools:", configuration.assistant.tools ?? []);
  trace.start(async ({ tasks }) => {
    for (const task of Object.values(tasks)) {
      if (!observed.has(task.conversationId)) {
        const events = await watchEvents(
          core.harness,
          task.conversationId,
          BACKGROUND_CONTEXT,
        );
        observed.add(task.conversationId);
        events.start(async (batch) => {
          for (const event of batch) {
            if (
              event.type === "message_end" ||
              event.type.startsWith("tool_execution_") ||
              event.type.startsWith("auto_retry_") ||
              event.type === "task_failed" ||
              event.type.startsWith("compaction_")
            ) {
              console.log(
                `[conversation ${task.conversationId}]`,
                JSON.stringify(event),
              );
            }
          }
        });
      }
      const before = previous[task.id];
      if (
        JSON.stringify(before?.state) !== JSON.stringify(task.state) ||
        before?.abortRequested !== task.abortRequested
      ) {
        console.log(
          `[conversation ${task.conversationId}] ${task.kind} #${task.id}: ${JSON.stringify(task.state)}${task.abortRequested ? " abort-requested" : ""}`,
        );
      }
    }
    for (const task of Object.values(previous)) {
      if (!tasks[task.id]) {
        console.log(
          `[conversation ${task.conversationId}] ${task.kind} #${task.id}: no longer live`,
        );
      }
    }
    previous = tasks;
  });

  const current = new ApiServer(core, { memory, routines }).server;
  server = current;
  await new Promise<void>((resolve, reject) => {
    current.once("error", reject);
    current.listen(port, () => {
      current.removeListener("error", reject);
      resolve();
    });
  });

  console.log(`kaeno listening on :${port}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void close().then(
        () => process.exit(0),
        (error) => {
          console.error(error);
          process.exit(1);
        },
      );
    });
  }
} catch (error) {
  await close();
  throw error;
}
