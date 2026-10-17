import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { z } from "zod";
import { createWorkExtensions, openKaeno } from "./application/index.ts";
import { ApiServer } from "./api/index.ts";
import { loadConfig } from "./config/index.ts";
import { RemoteExecutionEnv } from "./execution/index.ts";
import { DockerSandboxProvider } from "./sandbox/index.ts";
import { loadWorkConfig } from "./work/index.ts";

const config = await loadConfig(
  process.env.KAENO_CONFIG ?? "/etc/kaeno/config.json",
);
const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.PORT ?? 8080);
const workConfig = process.env.KAENO_WORK_CONFIG
  ? await loadWorkConfig(process.env.KAENO_WORK_CONFIG)
  : {
      maxDepth: 1,
      templates: {
        worker: {
          name: "worker",
          description: "General-purpose local coding and research worker",
          model: config.model,
          instructions: config.instructions,
          delegates: [],
          skills: [],
        },
      },
    };
const limits = {
  cpus: z.coerce
    .number()
    .positive()
    .parse(process.env.KAENO_WORK_CPUS ?? 1),
  memoryBytes: z.coerce
    .number()
    .int()
    .positive()
    .parse(process.env.KAENO_WORK_MEMORY_BYTES ?? 1_073_741_824),
};
const extensions = createWorkExtensions({
  config: workConfig,
  sandbox: new DockerSandboxProvider({
    apiHost: process.env.KAENO_SANDBOX_API_HOST ?? "127.0.0.1",
    createEnvironment: ({ url, token, id, cwd, fetch }) =>
      new RemoteExecutionEnv(url, token, id, cwd, fetch),
  }),
  sandboxImage: process.env.KAENO_SANDBOX_IMAGE ?? "kaeno:local",
  sandboxLimits: limits,
  maxConcurrent: z.coerce
    .number()
    .int()
    .positive()
    .parse(process.env.KAENO_WORK_MAX_CONCURRENT ?? 4),
});
const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
models.setProvider(openrouterProvider());
const core = await openKaeno({
  storage: await openNodeSqliteStorage(
    process.env.KAENO_DB ?? "/data/kaeno.sqlite",
  ),
  models,
  assistant: config,
  extensions,
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
