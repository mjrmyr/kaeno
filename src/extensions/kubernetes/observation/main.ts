import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { KubernetesObserver } from "./collector.ts";
import { observerConfigurationSchema, credentials } from "./configuration.ts";
import { observerHandler } from "./server.ts";
import { readJson } from "./transport.ts";

try {
  const path = resolve(
    process.env.KAENO_OBSERVER_CONFIG ?? "/etc/kaeno-observer/config.json",
  );
  const config = observerConfigurationSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  const transport = await credentials(
    dirname(path),
    config.api,
    config.tokenFile,
    config.caFile,
  );
  function readClientToken() {
    return readFile(resolve(dirname(path), config.clientTokenFile), "utf8");
  }
  if ((await readClientToken()).trim().length < 32) {
    throw new Error("Invalid credential");
  }
  const observer = new KubernetesObserver(
    {
      namespaces: config.namespaces,
      includeNodes: config.includeNodes,
      staleAfterMs: config.staleAfterMs,
    },
    (path, signal) => readJson(transport, path, 4 * 1024 * 1024, signal),
  );
  const abort = new AbortController();
  const server = createServer(observerHandler(observer, readClientToken));
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  function stop() {
    abort.abort();
    server.close();
    server.closeAllConnections();
  }
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  while (!abort.signal.aborted) {
    await observer.poll(abort.signal);
    await delay(config.pollIntervalMs, undefined, {
      signal: abort.signal,
    }).catch(() => {});
  }
} catch {
  // Configuration and upstream errors may contain raw credentials or objects.
  console.error(
    "Kubernetes observer failed; check configuration and connectivity locally",
  );
  process.exitCode = 1;
}
