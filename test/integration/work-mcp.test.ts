import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type {
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  EnvironmentServer,
  RemoteExecutionEnv,
} from "../../src/extensions/execution/index.ts";
import {
  WorkMcpHost,
  workMcpTools,
  type WorkServerRecipe,
} from "../../src/extensions/mcp/index.ts";
import { conversationId, taskId } from "../mocks/identifiers.ts";

const recipe: WorkServerRecipe = {
  id: "fixture",
  tools: ["count", "env"],
  spawn: (directory) => ({
    command: process.execPath,
    args: [resolve("test/mocks/stdio-mcp-server.ts")],
    env: { HOME: directory, PATH: "/usr/local/bin:/usr/bin:/bin" },
  }),
  limits: {
    connectMs: 10_000,
    callMs: 10_000,
    overallMs: 15_000,
    responseBytes: 1_000_000,
  },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function sandbox(): Promise<() => RemoteExecutionEnv> {
  const mcp = new WorkMcpHost([recipe]);
  const server = new EnvironmentServer(
    "token",
    (cwd) => new NodeExecutionEnv({ cwd }),
    process.cwd(),
    mcp,
  ).server;
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(async () => {
    await mcp.close();
    await new Promise<void>((done, fail) =>
      server.close((error) => (error ? fail(error) : done())),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address");
  }
  // Every tool call gets a transient client, like the WORK runtime.
  return () =>
    new RemoteExecutionEnv(
      `http://127.0.0.1:${address.port}`,
      "token",
      "work",
      process.cwd(),
      fetch,
    );
}

function tool(tools: readonly ToolRegistration[], name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`Missing ${name}`);
  }
  return found;
}

it("discovers on the host, then keeps one sandbox session per WORK across transient clients", async () => {
  const installed = await workMcpTools(recipe);
  expect(installed.diagnostics).toEqual([]);
  expect(installed.live).toEqual({ tools: ["fixture_count", "fixture_env"] });
  const tools = installed.extension.runtime.durable.tools ?? [];
  expect(tools.map((registration) => registration.name)).toEqual([
    "fixture_count",
    "fixture_env",
  ]);
  const remote = await sandbox();
  const count = tool(tools, "fixture_count");
  for (const expected of ["1", "2"]) {
    expect(await count.execute({}, api(remote()), context)).toEqual({
      content: [{ type: "text", text: expected }],
      isError: undefined,
    });
  }
  await remote().cleanup(context);
  expect(await count.execute({}, api(remote()), context)).toMatchObject({
    content: [{ text: "1" }],
  });
});

it("gives the server only the recipe environment, never the envd token", async () => {
  process.env.KAENO_ENV_TOKEN = "must-not-leak";
  cleanups.push(async () => {
    delete process.env.KAENO_ENV_TOKEN;
  });
  const remote = await sandbox();
  expect(
    JSON.stringify(
      await remote().mcp(
        { server: "fixture", name: "env", arguments: {} },
        context,
      ),
    ),
  ).not.toContain("KAENO_ENV_TOKEN");
});

it("re-checks the allowlist and server in envd, and refuses host execution", async () => {
  const remote = await sandbox();
  await expect(
    remote().mcp({ server: "fixture", name: "hidden", arguments: {} }, context),
  ).rejects.toThrow("tool not allowed");
  await expect(
    remote().mcp({ server: "other", name: "count", arguments: {} }, context),
  ).rejects.toThrow("Unknown WORK MCP server");
  const installed = await workMcpTools(recipe);
  await expect(
    tool(
      installed.extension.runtime.durable.tools ?? [],
      "fixture_count",
    ).execute({}, api(undefined), context),
  ).rejects.toThrow("host execution is forbidden");
});

it("registers placeholders and a diagnostic when discovery fails", async () => {
  const installed = await workMcpTools({
    ...recipe,
    spawn: (directory) => ({
      ...recipe.spawn(directory),
      command: "/nonexistent/mcp-server",
    }),
  });
  expect(installed.diagnostics).toEqual([
    "fixture: unavailable at startup; its tools are unavailable",
  ]);
  expect(installed.live).toEqual({ tools: [] });
  const remote = await sandbox();
  await expect(
    tool(
      installed.extension.runtime.durable.tools ?? [],
      "fixture_count",
    ).execute({}, api(remote()), context),
  ).rejects.toThrow("fixture: not_loaded");
});

function api(env: ToolExecutionApi["env"]): ToolExecutionApi {
  async function unexpected(): Promise<never> {
    throw new Error("Unexpected tool API operation");
  }
  return {
    env,
    taskId: taskId(1),
    conversationId: conversationId(1),
    callId: "work-mcp-test",
    get registry(): never {
      throw new Error("Unexpected registry");
    },
    get models(): never {
      throw new Error("Unexpected models");
    },
    outputWindow: undefined,
    agent: unexpected,
    output: () => {},
    diagnostic: () => {},
    details: unexpected,
    commit: unexpected,
    memo: unexpected,
    createTask: unexpected,
    getTask: unexpected,
    waitForTask: unexpected,
    conversation: unexpected,
    watchDoc: unexpected,
    snapshot: unexpected,
    snapshotAsOf: unexpected,
  };
}
