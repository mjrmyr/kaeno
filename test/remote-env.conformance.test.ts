import { describe, expect, it, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { createEnvServer } from "../src/envd.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";

const token = "t".repeat(40);
const server = createEnvServer({ token });
await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => new Promise<void>(ok => server.close(() => ok())));

registerEnvConformance({ describe, expect, it }, "RemoteExecutionEnv over envd", async use => {
  const cwd = await mkdtemp(join(tmpdir(), "kaeno-envd-"));
  const env = new RemoteExecutionEnv({ url, token, id: "test-pod", cwd });
  try { await use(env); } finally { await env.cleanup(BACKGROUND_CONTEXT); await rm(cwd, { recursive: true, force: true }); }
});

it.each([true, false])("bounds a cancelled request when envd never responds (cleanup=%s)", async cleanup => {
  const stuck = createServer(() => {});
  await new Promise<void>(r => stuck.listen(0, "127.0.0.1", r));
  const env = new RemoteExecutionEnv({ url: `http://127.0.0.1:${(stuck.address() as AddressInfo).port}`, token, id: "stuck", cwd: "/workspace" });
  try {
    const start = Date.now();
    const context = withAbortSignal(AbortSignal.timeout(50), BACKGROUND_CONTEXT);
    await expect(cleanup ? env.cleanup(context) : env.exists("/workspace", context)).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(cleanup ? 2000 : 8000);
  } finally { stuck.closeAllConnections(); await new Promise<void>(r => stuck.close(() => r())); }
}, 10_000);
