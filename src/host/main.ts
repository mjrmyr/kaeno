import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { watchEvents, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { z } from "zod";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { openKaeno } from "../core/application/index.ts";
import { DEFAULT_AUTH_FILE, FileCredentialStore } from "./auth/index.ts";
import { loadEnvironment } from "./composition/index.ts";
import { loadGitHubConfiguration } from "../extensions/github/index.ts";
import { parseModelRef } from "../extensions/agents/index.ts";
import { ApiServer } from "../extensions/api/index.ts";
import { RemoteExecutionEnv } from "../extensions/execution/index.ts";
import { loadKubernetesConfiguration } from "../extensions/kubernetes/index.ts";
import {
  MicrosandboxEngine,
  MicrosandboxSandboxProvider,
  SandboxWorkEnvironment,
} from "../extensions/microsandbox/index.ts";

import { browserExtension } from "../extensions/browser/index.ts";

const browser = await browserExtension();
const browserTools = browser.durable.tools?.map((tool) => tool.name) ?? [];
const github: Partial<Awaited<ReturnType<typeof loadGitHubConfiguration>>> =
  process.env.KAENO_GITHUB_CONFIG
    ? await loadGitHubConfiguration(process.env.KAENO_GITHUB_CONFIG)
    : {};
const configuration = await loadEnvironment({
  ...github,
  extensions: [...(github.extensions ?? []), browser],
  tools: github.tools,
  workerTools: browserTools,
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

if (configuration.work) {
  if (process.env.KAENO_KUBERNETES_CONFIG) {
    const kubernetes = await loadKubernetesConfiguration(
      process.env.KAENO_KUBERNETES_CONFIG,
      ({ url, token, id, cwd }) =>
        new RemoteExecutionEnv(url, token, id, cwd, fetch),
    );
    configuration.extensions.push(kubernetes.extension);
    configuration.work.environment = kubernetes.environment;
  } else {
    configuration.work.environment = new SandboxWorkEnvironment({
      sandbox: new MicrosandboxSandboxProvider({
        engine: new MicrosandboxEngine(),
        namespace:
          process.env.KAENO_SANDBOX_NAMESPACE ??
          createHash("sha256")
            .update(resolve(process.env.KAENO_DB ?? "/data/kaeno.sqlite"))
            .digest("hex")
            .slice(0, 16),
        createEnvironment: ({ url, token, id, cwd, fetch }) =>
          new RemoteExecutionEnv(url, token, id, cwd, fetch),
      }),
      image: process.env.KAENO_SANDBOX_IMAGE ?? "kaeno:local",
      limits: {
        cpus: z.coerce
          .number()
          .positive()
          .parse(process.env.KAENO_WORK_CPUS ?? 1),
        memoryBytes: z.coerce
          .number()
          .int()
          .positive()
          .parse(process.env.KAENO_WORK_MEMORY_BYTES ?? 1_073_741_824),
      },
    });
  }
}
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
const core = await openKaeno({
  storage: await openNodeSqliteStorage(
    process.env.KAENO_DB ?? "/data/kaeno.sqlite",
  ),
  models,
  assistant: configuration.assistant,
  extensions: configuration.extensions,
  work: configuration.work,
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
      await core.close();
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

  const current = new ApiServer(core).server;
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
