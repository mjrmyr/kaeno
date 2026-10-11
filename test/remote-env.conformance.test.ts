import { describe, expect, it, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
