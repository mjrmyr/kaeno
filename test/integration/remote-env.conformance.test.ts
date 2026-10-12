import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RemoteExecutionEnv } from "../../src/execution/index.ts";
import { createEnvServer } from "./composition.ts";
import { serverPort } from "./values.ts";
const token = "t".repeat(40);
const server = createEnvServer({ token });
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${serverPort(server)}`;
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));
registerEnvConformance(
  { describe, expect, it },
  "RemoteExecutionEnv over envd",
  async (use) => {
    const cwd = await mkdtemp(join(tmpdir(), "kaeno-envd-"));
    const env = new RemoteExecutionEnv(url, token, "test-pod", cwd, fetch);
    try {
      await use(env);
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
it.each([true, false])(
  "bounds a cancelled request when envd never responds (cleanup=%s)",
  async (cleanup) => {
    const stuck = createServer(() => {});
    await new Promise<void>((resolve) => stuck.listen(0, "127.0.0.1", resolve));
    const env = new RemoteExecutionEnv(
      `http://127.0.0.1:${serverPort(stuck)}`,
      token,
      "stuck",
      "/workspace",
      fetch,
    );
    try {
      const start = Date.now();
      const context = withAbortSignal(
        AbortSignal.timeout(50),
        BACKGROUND_CONTEXT,
      );
      await expect(
        cleanup ? env.cleanup(context) : env.exists("/workspace", context),
      ).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(cleanup ? 2000 : 8000);
    } finally {
      stuck.closeAllConnections();
      await new Promise<void>((resolve) => stuck.close(() => resolve()));
    }
  },
  10000,
);
