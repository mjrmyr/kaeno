import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openKaeno } from "./application/index.ts";
import { ApiServer } from "./api/index.ts";
import { loadConfig } from "./config/index.ts";

const config = await loadConfig(
  process.env.KAENO_CONFIG ?? "/etc/kaeno/config.json",
);
const token = process.env.KAENO_TOKEN?.trim();
const port = Number(process.env.PORT ?? 8080);
if (token && token.length < 32) {
  throw new Error("KAENO_TOKEN must contain at least 32 characters");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Invalid PORT");
}
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
  if (token) {
    const current = new ApiServer(core, token).server;
    server = current;
    await new Promise<void>((resolve, reject) => {
      current.once("error", reject);
      current.listen(port, () => {
        current.removeListener("error", reject);
        resolve();
      });
    });
    console.log(`kaeno listening on :${port}`);
  } else {
    console.log("kaeno running (HTTP disabled: KAENO_TOKEN is unset)");
  }
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
