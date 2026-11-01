import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it, vi } from "vitest";
import { openKaeno } from "../../src/core/application/index.ts";
import { ApiServer } from "../../src/extensions/api/index.ts";
async function port(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No address");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const ended = once(child, "exit");
  if (child.pid) {
    process.kill(-child.pid, "SIGTERM");
  }
  const timer = setTimeout(() => {
    if (child.pid) {
      process.kill(-child.pid, "SIGKILL");
    }
  }, 6000);
  await ended;
  clearTimeout(timer);
}
function launch(env: NodeJS.ProcessEnv): {
  child: ChildProcess;
  output: () => string;
} {
  // Exercise the exact documented root command, not a static preview server.
  const child = spawn("npm", ["run", "ui"], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let text = "";
  child.stdout?.on("data", (chunk) => {
    text += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    text += String(chunk);
  });
  return { child, output: () => text };
}
async function ready(url: string, output: () => string): Promise<void> {
  await vi.waitFor(
    async () => {
      try {
        expect((await fetch(url)).status).toBe(200);
      } catch {
        throw new Error(output());
      }
    },
    { timeout: 15000, interval: 100 },
  );
}
it("root ui command proxies turns, replies and stop to a real SQLite Kaeno backend with explicit faux model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-ui-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxText("Verified upstream response")]),
  ]);
  const core = await openKaeno({
    storage: await openNodeSqliteStorage(join(directory, "core.sqlite")),
    models,
    assistant: {
      model: { provider: "faux", modelId: "faux-1" },
      instructions: "Be helpful",
    },
  });
  const api = new ApiServer(core).server;
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  if (!address || typeof address === "string") {
    throw new Error("No address");
  }
  const uiPort = await port();
  const base = `http://127.0.0.1:${uiPort}`;
  const launcher = launch({
    KAENO_UI_PORT: String(uiPort),
    KAENO_UI_API_URL: `http://127.0.0.1:${address.port}`,
  });
  try {
    await ready(base, launcher.output);
    expect(await (await fetch(base)).text()).toContain("/main.ts");
    const asset = await fetch(`${base}/main.ts`);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await (await fetch(`${base}/v1/threads`)).json()).toEqual([]);
    const turn = await fetch(`${base}/v1/threads/ui-integration/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello", requestId: "ui-integration-1" }),
    });
    expect(turn.status).toBe(202);
    await vi.waitFor(
      async () => {
        expect(
          await (
            await fetch(`${base}/v1/threads/ui-integration/replies`)
          ).json(),
        ).toMatchObject({
          replies: [{ text: "Verified upstream response" }],
          next: 1,
        });
      },
      { timeout: 5000 },
    );
    expect(await (await fetch(`${base}/v1/threads`)).json()).toMatchObject([
      { key: "ui-integration" },
    ]);
    expect(
      (
        await fetch(`${base}/v1/threads/ui-integration/stop`, {
          method: "POST",
        })
      ).status,
    ).toBe(202);
    // There is deliberately no token-based auth on the real API; the UI must not invent one.
    expect(
      (
        await fetch(`${base}/v1/threads`, {
          headers: { authorization: "Bearer ignored" },
        })
      ).status,
    ).toBe(200);
  } finally {
    await terminate(launcher.child);
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 25000);
it("root ui command starts and stops the actual host, with configured local definitions and no nested install", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-ui-host-"));
  const backendPort = await port();
  const uiPort = await port();
  await mkdir(join(directory, "agents"));
  await writeFile(
    join(directory, "agents/assistant.md"),
    "---\nname: assistant\ndescription: Test assistant\nmodel: openai/gpt-4.1\n---\nBe helpful.\n",
  );
  const config = join(directory, "config.json");
  await writeFile(join(directory, "docker.json"), "{}");
  await writeFile(
    config,
    JSON.stringify({
      sourceDirectory: "./sources",
      localDefinitions: { agents: [{ alias: "local", directory: "./agents" }] },
      kaeno: "local:assistant",
      workers: [],
    }),
  );
  const launcher = launch({
    KAENO_UI_API_URL: "",
    KAENO_CONFIG: config,
    KAENO_DATA_DIR: join(directory, "data"),
    PORT: String(backendPort),
    KAENO_UI_PORT: String(uiPort),
  });
  try {
    await ready(`http://127.0.0.1:${uiPort}/healthz`, launcher.output);
    expect(
      await (await fetch(`http://127.0.0.1:${uiPort}/v1/threads`)).json(),
    ).toEqual([]);
    expect(launcher.output()).toContain("(managed backend)");
  } finally {
    await terminate(launcher.child);
    await rm(directory, { recursive: true, force: true });
  }
  await vi.waitFor(
    async () => {
      await expect(
        fetch(`http://127.0.0.1:${backendPort}/healthz`),
      ).rejects.toThrow();
    },
    { timeout: 5000 },
  );
}, 25000);
