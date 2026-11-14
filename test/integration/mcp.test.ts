import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  loadMcpConfiguration,
  type McpInstallation,
} from "../../src/extensions/mcp/index.ts";
import { openKaeno } from "../../src/core/application/index.ts";
import { loadEnvironment } from "../../src/host/composition/index.ts";
import { conversationId, taskId } from "../mocks/identifiers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface FixtureState {
  description: string;
  schema: {
    type: "object";
    properties: { query: { type: string } };
    additionalProperties: boolean;
  };
  initialized: number;
  deleted: number;
  listed: number;
  calls: string[];
  headers: (string | undefined)[];
  capabilities: unknown[];
  openStreams: number;
  requestClosed: number;
  mode: string;
  failInitialize: boolean;
  redirect: string;
  cycle: boolean;
  missing: boolean;
  release(): void;
  result?: CallToolResult;
  rejectAuth: boolean;
  outputSchema: boolean;
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-mcp-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const configFile = join(directory, "mcp.json");
  const headerFile = join(directory, "authorization");
  await writeFile(headerFile, "Bearer fixture-secret");
  const state: FixtureState = {
    description: "Reviewed read contract",
    schema: {
      type: "object" as const,
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
    initialized: 0,
    deleted: 0,
    listed: 0,
    calls: [],
    headers: [],
    capabilities: [],
    openStreams: 0,
    requestClosed: 0,
    mode: "normal",
    failInitialize: false,
    redirect: "",
    cycle: false,
    missing: false,
    release: () => {},
    result: undefined,
    rejectAuth: false,
    outputSchema: false,
  };
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers: Server[] = [];
  const http = createServer(async (request, response) => {
    try {
      if (state.redirect) {
        response.writeHead(307, { location: state.redirect });
        response.end();
        return;
      }
      state.headers.push(request.headers.authorization);
      if (state.rejectAuth) {
        response.writeHead(401);
        response.end("fixture-secret unauthorized");
        return;
      }
      if (request.method === "DELETE") {
        state.deleted++;
      }
      if (request.method === "GET") {
        state.openStreams++;
        response.on("close", () => {
          state.openStreams--;
        });
      }
      const chunks: Buffer[] = [];
      if (request.method === "POST") {
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
      }
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      let transport = transports.get(String(request.headers["mcp-session-id"]));
      if (body?.method === "initialize") {
        state.initialized++;
        state.capabilities.push(body.params.capabilities);
        if (state.failInitialize) {
          response.writeHead(500);
          response.end("fixture-secret upstream failure");
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: false,
          onsessioninitialized: (id) => {
            if (transport) {
              transports.set(id, transport);
            }
          },
        });
        const server = new Server(
          { name: "fixture", version: "1" },
          {
            capabilities: { tools: {} },
            instructions: "UNTRUSTED INITIALIZATION INSTRUCTIONS",
          },
        );
        servers.push(server);
        server.setRequestHandler(ListToolsRequestSchema, async (request) => {
          state.listed++;
          const tools: Tool[] = state.missing
            ? []
            : [
                {
                  name: "read",
                  description: state.description,
                  inputSchema: state.schema,
                  ...(state.outputSchema
                    ? {
                        outputSchema: {
                          type: "object" as const,
                          $ref: "https://never-fetch.example/schema",
                        },
                      }
                    : {}),
                  annotations: {
                    readOnlyHint: true,
                    idempotentHint: true,
                    destructiveHint: false,
                  },
                },
                {
                  name: "write",
                  description: "Write",
                  inputSchema: { type: "object" },
                },
              ];
          if (!request.params?.cursor) {
            return {
              tools: [
                {
                  name: "unlisted",
                  description: "Unlisted",
                  inputSchema: { type: "object" },
                },
              ],
              nextCursor: "second",
            };
          }
          return { tools, ...(state.cycle ? { nextCursor: "second" } : {}) };
        });
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          state.calls.push(request.params.name);
          response.on("close", () => {
            state.requestClosed++;
          });
          if (state.mode === "slow") {
            await new Promise<void>((resolve) => {
              state.release = resolve;
            });
          }
          if (state.mode === "throw") {
            throw new Error("fixture-secret secret exception");
          }
          if (state.mode === "huge") {
            return {
              content: [
                { type: "text", text: "x".repeat(4 * 1024 * 1024 + 1) },
              ],
            };
          }
          return (
            state.result ?? {
              isError: false,
              content: [
                {
                  type: "text",
                  text: `Bearer fixture-secret ${request.params.arguments?.query ?? "OK"}`,
                },
              ],
            }
          );
        });
        await server.connect(transport);
      }
      if (!transport) {
        response.writeHead(404);
        response.end();
        return;
      }
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing fixture address");
  }
  const endpoint = `http://127.0.0.1:${address.port}/mcp?resource=fixture`;
  cleanups.push(async () => {
    state.release();
    for (const server of servers) {
      await server.close();
    }
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  });
  async function configure(
    tools: unknown[] = [
      { upstream: "read", readOnly: true },
      { upstream: "write" },
    ],
    url = endpoint,
  ): Promise<void> {
    await writeFile(
      configFile,
      JSON.stringify({
        servers: {
          demo: {
            url,
            auth: { headerFiles: { Authorization: "authorization" } },
            tools,
          },
        },
      }),
    );
  }
  function install(): Promise<McpInstallation> {
    return loadMcpConfiguration(configFile, AbortSignal.timeout(5000));
  }
  await configure();
  return {
    directory,
    configFile,
    headerFile,
    endpoint,
    state,
    configure,
    install,
  };
}

function selected(
  installation: McpInstallation,
  name = "demo_read",
): ToolRegistration {
  const tool = installation.extensions[0]?.runtime.durable.tools?.find(
    (tool) => tool.name === name,
  );
  if (!tool) {
    throw new Error(`Tool ${name} missing`);
  }
  return tool;
}
function invoke(
  tool: ToolRegistration,
  args: unknown = {},
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  // MCP host tools have no ToolExecutionApi dependency; use actual harness tests below for recovery/lifecycle.
  function unexpected(): never {
    throw new Error(
      "Host MCP must not use host environment, models, or durable state through tool API",
    );
  }
  const api: ToolExecutionApi = {
    taskId: taskId(1),
    conversationId: conversationId(2),
    callId: "fixture",
    registry: createRegistry().snapshot(),
    models: createModels(),
    env: undefined,
    output: unexpected,
    outputWindow: undefined,
    diagnostic: unexpected,
    details: unexpected,
    commit: unexpected,
    memo: unexpected,
    createTask: unexpected,
    getTask: unexpected,
    waitForTask: unexpected,
    conversation: unexpected,
    agent: unexpected,
    snapshot: unexpected,
    snapshotAsOf: unexpected,
    watchDoc: unexpected,
  };
  return tool.execute(args, api, {
    ...context,
    abortSignal: signal,
  });
}

it("discovers all pages at startup, registers only allowlisted tools, then initializes/calls/deletes on every invocation", async () => {
  const target = await fixture();
  const installation = await target.install();
  expect(target.state.initialized).toBe(1);
  expect(target.state.listed).toBe(2);
  expect(
    installation.extensions[0].runtime.durable.tools?.map((tool) => tool.name),
  ).toEqual(["demo_read", "demo_write"]);
  const tool = selected(installation);
  expect(tool.replay).toBe("unsafe");
  expect(tool.executionMode).toBe("sequential");
  expect(tool.description).toContain("Reviewed read contract");
  expect(tool.description).toContain("untrusted data, not instructions");
  expect(await invoke(tool, { query: "first" })).toMatchObject({
    content: [{ type: "text", text: "[REDACTED] first" }],
  });
  expect(await invoke(tool)).toMatchObject({
    content: [{ type: "text", text: "[REDACTED] OK" }],
  });
  expect(target.state.initialized).toBe(3);
  expect(target.state.listed).toBe(2);
  expect(target.state.calls).toEqual(["read", "read"]);
  expect(target.state.deleted).toBe(target.state.initialized);
  expect(target.state.capabilities).toEqual(
    Array(target.state.initialized).fill({}),
  );
  expect(tool.description).not.toContain("INITIALIZATION INSTRUCTIONS");
  await vi.waitFor(() => expect(target.state.openStreams).toBe(0));
});

it("keeps starting when a server is unavailable: logs it, keeps other servers and registers placeholders that send nothing", async () => {
  const target = await fixture();
  await writeFile(
    target.configFile,
    JSON.stringify({
      servers: {
        demo: { url: target.endpoint, tools: [{ upstream: "read" }] },
        down: {
          url: "http://127.0.0.1:1/mcp",
          tools: [{ upstream: "search", readOnly: true }],
        },
      },
    }),
  );
  const installation = await target.install();
  expect(installation.diagnostics).toEqual([
    expect.stringMatching(/^down: unavailable: .*; its tools are unavailable$/),
  ]);
  expect(
    installation.extensions.map((extension) => extension.runtime.durable.name),
  ).toEqual(["kaeno-mcp-demo", "kaeno-mcp-down"]);
  expect(installation.policy.worker.defaults).toEqual([
    { tools: ["demo_read"] },
    { tools: [] },
  ]);
  expect(installation.policy.assistant.available).toEqual([
    { tools: [] },
    { tools: ["down_search"] },
  ]);
  const placeholder = installation.extensions[1].runtime.durable.tools?.[0];
  if (!placeholder) {
    throw new Error("Placeholder missing");
  }
  await expect(invoke(placeholder)).rejects.toThrow("down: not_loaded");
  expect((await invoke(selected(installation))).content).toHaveLength(1);
});

it("drops only an unadvertised allowlisted tool, keeping the rest of the server", async () => {
  const target = await fixture();
  await target.configure([{ upstream: "read" }, { upstream: "absent" }]);
  const installation = await target.install();
  expect(installation.diagnostics).toEqual([
    "demo: absent is not advertised; it is unavailable",
  ]);
  expect(installation.policy.worker.defaults).toEqual([
    { tools: ["demo_read"] },
  ]);
  const before = target.state.initialized;
  await expect(invoke(selected(installation, "demo_absent"))).rejects.toThrow(
    "demo: not_loaded",
  );
  expect(target.state.initialized).toBe(before);
});

it("derives role policy and independent classification; upstream hints cannot grant replay/concurrency", async () => {
  const target = await fixture();
  await target.configure([
    { upstream: "read", readOnly: true },
    { upstream: "write", replay: "safe", executionMode: "parallel" },
  ]);
  const installation = await target.install();
  expect(selected(installation).replay).toBe("unsafe");
  expect(selected(installation).executionMode).toBe("sequential");
  expect(selected(installation, "demo_write").replay).toBe("safe");
  expect(selected(installation, "demo_write").executionMode).toBe("parallel");
  expect(installation.extensions[0].runtime.readOnlyTools).toEqual([
    "demo_read",
  ]);
  expect(installation.policy.assistant).toEqual({
    available: [{ tools: ["demo_read"] }],
    defaults: [],
  });
  expect(installation.policy.worker.available).toEqual(installation.extensions);
  expect(installation.policy.worker.defaults).toEqual([
    { tools: ["demo_read", "demo_write"] },
  ]);
});

it("rotates header files on every call and returns redacted, bounded output without exposing host process environment", async () => {
  const target = await fixture();
  const installation = await target.install();
  await invoke(selected(installation));
  await writeFile(target.headerFile, "Bearer rotated-token\n");
  target.state.result = {
    isError: true,
    content: [{ type: "text", text: "rotated-token " + "z".repeat(50_000) }],
  };
  const result = await invoke(selected(installation));
  expect(target.state.headers.at(-1)).toBe("Bearer rotated-token");
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain("rotated-token");
  expect(JSON.stringify(result)).toContain("truncated at 32 KiB");
  expect(
    target.state.capabilities.every(
      (capabilities) => JSON.stringify(capabilities) === "{}",
    ),
  ).toBe(true);
  target.state.failInitialize = true;
  await expect(invoke(selected(installation))).rejects.toThrow(
    "demo: unavailable",
  );
});

it("self-disposes failed initialize and call errors without leaking upstream diagnostics; later calls reconnect", async () => {
  const target = await fixture();
  const installation = await target.install();
  target.state.failInitialize = true;
  await expect(invoke(selected(installation))).rejects.toThrow(
    "demo: unavailable",
  );
  target.state.failInitialize = false;
  target.state.mode = "throw";
  await expect(invoke(selected(installation))).rejects.toThrow(
    "demo: unavailable",
  );
  target.state.mode = "normal";
  expect((await invoke(selected(installation))).content).toHaveLength(1);
  expect(target.state.calls).toHaveLength(2);
  await vi.waitFor(() => expect(target.state.openStreams).toBe(0));
});

it("aborts and closes an active transport before a later invocation creates a fresh session", async () => {
  const target = await fixture();
  const installation = await target.install();
  const controller = new AbortController();
  target.state.mode = "slow";
  const pending = invoke(selected(installation), {}, controller.signal);
  const outcome = pending.catch((error: unknown) => error);
  await vi.waitFor(() => expect(target.state.calls).toHaveLength(1));
  controller.abort();
  expect(await outcome).toMatchObject({
    message: expect.stringContaining("demo: cancelled"),
  });
  await vi.waitFor(() => expect(target.state.openStreams).toBe(0));
  target.state.release();
  target.state.mode = "normal";
  const before = target.state.initialized;
  await invoke(selected(installation));
  expect(target.state.initialized).toBe(before + 1);
  expect(target.state.calls).toEqual(["read", "read"]);
});

it("enforces the 4 MiB wire cap, closes the session, and does not retry a possibly executed tool", async () => {
  const target = await fixture();
  const installation = await target.install();
  target.state.mode = "huge";
  await expect(invoke(selected(installation))).rejects.toThrow("demo: limit");
  expect(target.state.calls).toEqual(["read"]);
  await vi.waitFor(() => expect(target.state.openStreams).toBe(0));
  target.state.mode = "normal";
  await invoke(selected(installation));
  expect(target.state.calls).toEqual(["read", "read"]);
});

it("refuses redirects, cyclic pagination, invalid credentials and unsupported config", async () => {
  const target = await fixture();
  const installation = await target.install();
  target.state.redirect = target.endpoint.replace("/mcp?", "/unreviewed?");
  await expect(invoke(selected(installation))).rejects.toThrow(
    "demo: unavailable",
  );
  target.state.redirect = "";
  target.state.cycle = true;
  expect((await target.install()).diagnostics).toEqual([
    expect.stringContaining("demo: protocol"),
  ]);
  target.state.cycle = false;
  await writeFile(target.headerFile, "bad\r\nheader");
  await expect(invoke(selected(installation))).rejects.toThrow(
    "demo: auth_required",
  );
  for (const extra of [
    { auth: { oauth: true } },
    { command: "env" },
    { placement: "work" },
    { url: "https://user:secret@example.com" },
  ]) {
    await writeFile(
      target.configFile,
      JSON.stringify({
        servers: { demo: { url: target.endpoint, tools: [], ...extra } },
      }),
    );
    await expect(loadMcpConfiguration(target.configFile)).rejects.toThrow(
      "Invalid MCP configuration",
    );
  }
});

it("runs through the durable harness, recovers saved tools after restart and refuses startup once the owner removes them", async () => {
  const target = await fixture();
  const installed = await target.install();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("demo_read", { query: "durable" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("DONE")]),
  ]);
  const path = join(target.directory, "saved.sqlite");
  const extension = installed.extensions[0].runtime;
  const options = {
    models,
    assistant: {
      model: { provider: "faux", modelId: "faux-1" },
      tools: ["demo_read"],
      instructions: "Use the assigned fixture tools.",
    },
  };
  const core = await openKaeno({
    ...options,
    storage: await openNodeSqliteStorage(path),
    extensions: [extension],
  });
  let savedId;
  try {
    const chat = await core.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: "faux", modelId: "faux-1" },
          extensions: [extension.durable],
          tools: extension.durable.tools,
        },
      },
      context,
    );
    savedId = chat.id;
    const submitted = await chat.submit(
      { type: "input", content: "Read fixture" },
      context,
    );
    await submitted.wait(context);
    expect(target.state.calls).toEqual(["read"]);
    // A positive extension reference remains load-bearing even when this second chat has tools: [].
    for (const selection of [
      [extension.durable],
      { add: [extension.durable], remove: [] },
    ]) {
      await core.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { extensions: selection, tools: [] },
        },
        context,
      );
    }
  } finally {
    await core.close();
  }
  // The server being down at restart still recovers, through placeholders.
  target.state.failInitialize = true;
  const restarted = await target.install();
  target.state.failInitialize = false;
  expect(restarted.diagnostics).toHaveLength(1);
  const reopened = await openKaeno({
    ...options,
    storage: await openNodeSqliteStorage(path),
    extensions: restarted.extensions.map((extension) => extension.runtime),
  });
  try {
    if (!savedId) {
      throw new Error("Saved conversation missing");
    }
    const chat = await reopened.harness.conversation(savedId, context);
    if (!chat) {
      throw new Error("Saved conversation missing");
    }
    const agent = await chat.agent(context);
    expect(agent.tools.some((tool) => tool.name === "demo_read")).toBe(true);
  } finally {
    await reopened.close();
  }
  // Removing a server that saved conversations reference is refused by core recovery.
  await writeFile(target.configFile, '{"servers":{}}');
  const removed = await target.install();
  await expect(
    openKaeno({
      ...options,
      storage: await openNodeSqliteStorage(path),
      extensions: removed.extensions.map((extension) => extension.runtime),
      assistant: { ...options.assistant, tools: [] },
    }),
  ).rejects.toThrow(/kaeno-mcp-demo/);
});

it("harness close aborts an in-flight MCP invocation and reverse cleanup can finish without upstream completion", async () => {
  const target = await fixture();
  const installed = await target.install();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("demo_read", {})], {
      stopReason: "toolUse",
    }),
  ]);
  const core = await openKaeno({
    storage: await openNodeSqliteStorage(
      join(target.directory, "close.sqlite"),
    ),
    models,
    assistant: {
      model: { provider: "faux", modelId: "faux-1" },
      tools: ["demo_read"],
      instructions: "Use the assigned fixture tools.",
    },
    extensions: installed.extensions.map((extension) => extension.runtime),
  });
  target.state.mode = "slow";
  try {
    const chat = await core.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: "faux", modelId: "faux-1" },
          extensions: [installed.extensions[0].runtime.durable],
          tools: installed.extensions[0].runtime.durable.tools,
        },
      },
      context,
    );
    await chat.submit({ type: "input", content: "start" }, context);
    await vi.waitFor(() => expect(target.state.calls).toEqual(["read"]));
    await core.close();
    await vi.waitFor(() => expect(target.state.openStreams).toBe(0));
    expect(target.state.calls).toEqual(["read"]);
  } finally {
    target.state.release();
    await core.close();
  }
});

it.each([
  "https://user:secret@example.com/mcp",
  "https://example.com/mcp#fragment",
  "https://example.com/mcp#",
  "https://example.com/mcp?access_token=secret",
  "https://example.com/mcp?api%5Fkey=secret",
  "https://example.com/mcp?authorization=secret",
  "https://example.com/mcp?session=secret",
  "http://example.com/mcp",
  "file:///etc/passwd",
  "not a url",
])(
  "rejects unsafe/credential-bearing endpoint at the config boundary without echo: %s",
  async (endpoint) => {
    const target = await fixture();
    await target.configure(undefined, endpoint);
    const diagnostic = await loadMcpConfiguration(target.configFile).catch(
      (error: unknown) => error,
    );
    expect(diagnostic).toMatchObject({
      message: expect.stringContaining("Invalid MCP configuration"),
    });
    expect(String(diagnostic)).not.toContain("secret");
    expect(target.state.initialized).toBe(0);
  },
);

it("bounds UTF-8 text, keeps at most one bounded image, omits resources/audio, preserves isError and ignores output schemas", async () => {
  const target = await fixture();
  const installed = await target.install();
  target.state.outputSchema = true;
  target.state.result = {
    isError: true,
    content: [
      { type: "image", data: "YQ==", mimeType: "image/png" },
      { type: "image", data: "YQ==", mimeType: "image/png" },
      { type: "image", data: "a".repeat(2_800_004), mimeType: "image/png" },
      {
        type: "resource_link",
        uri: "https://never-fetch.example/resource",
        name: "resource",
      },
      {
        type: "resource",
        resource: { uri: "file:///secret", text: "not included" },
      },
      { type: "audio", data: "YQ==", mimeType: "audio/wav" },
      { type: "text", text: "fixture-secret " + "€".repeat(20_000) },
      { type: "text", text: "tail" },
    ],
  };
  const result = await invoke(selected(installed));
  const output = JSON.stringify(result);
  expect(output).not.toContain("fixture-secret");
  expect(output).not.toContain("never-fetch");
  expect(output).not.toContain("not included");
  expect(output).not.toContain("�");
  expect(output).toContain("resource omitted");
  expect(output).toContain("audio omitted");
  expect(output).toContain("truncated at 32 KiB");
  expect(result.isError).toBe(true);
  expect(result.content?.filter((part) => part.type === "image")).toHaveLength(
    1,
  );
  const texts = (result.content ?? []).filter(
    (part) =>
      part.type === "text" && !part.text.startsWith("[MCP text truncated"),
  );
  expect(
    Buffer.byteLength(
      texts.map((part) => (part.type === "text" ? part.text : "")).join(""),
    ),
  ).toBeLessThanOrEqual(32_768);
  target.state.result = {
    content: [],
    structuredContent: { value: "fixture-secret", long: "x".repeat(50_000) },
  };
  const structured = JSON.stringify(await invoke(selected(installed)));
  expect(structured).not.toContain("fixture-secret");
  expect(structured).toContain("truncated");
  target.state.result = {
    content: [{ type: "text", text: "kept" }],
    structuredContent: { ignored: "not included" },
  };
  expect((await invoke(selected(installed))).content).toEqual([
    { type: "text", text: "kept" },
  ]);
});

it("drops a server with oversized advertising or credential echoes in advertised contracts", async () => {
  const target = await fixture();
  target.state.description = "x".repeat(4097);
  expect((await target.install()).diagnostics).toEqual([
    expect.stringContaining("demo: protocol"),
  ]);
  target.state.description = 'prefix secret"with\\escape suffix';
  await writeFile(target.headerFile, 'Bearer secret"with\\escape');
  const echoed = await target.install();
  expect(echoed.diagnostics).toEqual([
    expect.stringContaining("demo: protocol"),
  ]);
  expect(
    JSON.stringify(echoed.extensions[0].runtime.durable.tools),
  ).not.toContain("secret");
});

it("fails closed on rejected credentials and oversized arguments, never retrying or dispatching the called tool", async () => {
  const target = await fixture();
  const installed = await target.install();
  target.state.rejectAuth = true;
  const before = target.state.initialized;
  await expect(invoke(selected(installed))).rejects.toThrow(
    "demo: auth_required",
  );
  expect(target.state.initialized).toBe(before);
  target.state.rejectAuth = false;
  await expect(
    invoke(selected(installed), { query: "x".repeat(1_048_576) }),
  ).rejects.toThrow("demo: limit");
  expect(target.state.calls).toEqual([]);
});

it("uses the SDK 60-second call deadline and disposes without replay (controlled clock, real HTTP/MCP)", async () => {
  const target = await fixture();
  const installed = await target.install();
  target.state.mode = "slow";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const outcome = invoke(selected(installed)).catch(
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(target.state.calls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await outcome).toMatchObject({
      message: expect.stringContaining("demo: timeout"),
    });
    expect(target.state.calls).toEqual(["read"]);
  } finally {
    vi.useRealTimers();
    target.state.release();
  }
  await vi.waitFor(() => expect(target.state.openStreams).toBe(0));
});

it("failed harness startup closes the MCP lifecycle without starting any network resources", async () => {
  const target = await fixture();
  const installed = await target.install();
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const before = target.state.initialized;
  await expect(
    openKaeno({
      storage: await openNodeSqliteStorage(
        join(target.directory, "failed.sqlite"),
      ),
      models,
      assistant: {
        model: { provider: "faux", modelId: "faux-1" },
        instructions: "fixture",
        tools: [],
      },
      extensions: [
        ...installed.extensions.map((extension) => extension.runtime),
        {
          durable: defineExtension({ name: "test-failing-start" }),
          async start() {
            throw new Error("failed later extension start");
          },
        },
      ],
    }),
  ).rejects.toThrow("failed later extension start");
  await expect(invoke(selected(installed))).rejects.toThrow("demo: cancelled");
  expect(target.state.initialized).toBe(before);
});

it("composes actual assistant/worker policy; tools removed from the config leave the WORK ceiling", async () => {
  const target = await fixture();
  let installed = await target.install();
  const configFile = join(target.directory, "environment.json");
  await writeFile(
    configFile,
    JSON.stringify({
      sourceDirectory: "sources",
    }),
  );
  async function compose() {
    return loadEnvironment({
      configFile,
      extensions: installed.extensions,
      policy: (base) => ({
        assistant: {
          available: [
            ...base.assistant.available,
            ...installed.policy.assistant.available,
          ],
          defaults: [
            ...base.assistant.defaults,
            ...installed.policy.assistant.defaults,
            ...installed.policy.assistant.available,
          ],
        },
        worker: {
          available: [
            ...base.worker.available,
            ...installed.policy.worker.available,
          ],
          defaults: [
            ...base.worker.defaults,
            ...installed.policy.worker.defaults,
          ],
        },
      }),
    });
  }
  let configuration = await compose();
  expect(configuration.assistant.tools).toContain("demo_read");
  expect(configuration.assistant.tools).not.toContain("demo_write");
  expect(configuration.work.setup.tools).toContain("demo_write");
  await target.configure([{ upstream: "read", readOnly: true }]);
  installed = await target.install();
  configuration = await compose();
  expect(configuration.work.tools).not.toContain("demo_write");
  expect(configuration.work.setup.tools).not.toContain("demo_write");
  expect(configuration.assistant.tools).not.toContain("demo_write");
});
