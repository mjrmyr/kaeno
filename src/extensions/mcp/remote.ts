import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { z } from "zod";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { toolContractSchema, type ToolContract } from "./contract.ts";
import {
  boundResult,
  McpError,
  redactor,
  toolError,
  type McpFailure,
} from "./results.ts";

export interface HostServer {
  readonly id: string;
  readonly endpoint: string;
  /** Host-only paths. No process environment, credential store or sandbox forwarding. */
  readonly headerFiles: Readonly<Record<string, string>>;
}
const WIRE_LIMIT = 4 * 1024 * 1024;

async function credentials(
  server: HostServer,
): Promise<{ headers: Headers; redact: (value: string) => string }> {
  const headers = new Headers();
  const secrets: string[] = [];
  try {
    for (const [name, path] of Object.entries(server.headerFiles)) {
      const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      let value: string;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 8192) {
          throw new McpError("auth_required");
        }
        const buffer = Buffer.alloc(8193);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 8192) {
          throw new McpError("auth_required");
        }
        value = buffer.subarray(0, bytesRead).toString("utf8").trim();
      } finally {
        await file.close();
      }
      if (
        !value ||
        /[\r\n]/.test(value) ||
        value.includes(String.fromCharCode(0))
      ) {
        throw new McpError("auth_required");
      }
      headers.set(name, value);
      secrets.push(value);
    }
  } catch {
    throw new McpError("auth_required");
  }
  return { headers, redact: redactor(secrets) };
}

/** A fresh transport every invocation, with no SDK reconnect/replay and no authProvider. */
async function connected<T>(
  server: HostServer,
  signal: AbortSignal,
  operation: (
    client: Client,
    redact: (value: string) => string,
    signal: AbortSignal,
  ) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(75_000);
  const stopped = new AbortController();
  const combined = AbortSignal.any([signal, timeout, stopped.signal]);
  const client = new Client(
    { name: "kaeno-mcp", version: "1" },
    { capabilities: {} },
  );
  let transport: StreamableHTTPClientTransport | undefined;
  let wireBytes = 0;
  let failure: McpError | undefined;
  // Close the stateful transport immediately on cancel, not just notifications/cancelled.
  function abort() {
    void client.close().catch(() => {});
  }
  combined.addEventListener("abort", abort, { once: true });
  try {
    combined.throwIfAborted();
    const { headers, redact } = await credentials(server);
    combined.throwIfAborted();
    transport = new StreamableHTTPClientTransport(new URL(server.endpoint), {
      requestInit: { headers, redirect: "error" },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: async (input, init) => {
        // No redirect, even same-origin: the reviewed path/resource is the destination.
        const response = await fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([
            combined,
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          throw new McpError("auth_required");
        }
        const length = Number(response.headers.get("content-length"));
        if (length > WIRE_LIMIT - wireBytes) {
          await response.body?.cancel();
          failure = new McpError("limit");
          stopped.abort();
          throw failure;
        }
        if (!response.body) {
          return response;
        }
        const reader = response.body.getReader();
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const next = await reader.read();
                if (next.done) {
                  controller.close();
                  reader.releaseLock();
                  return;
                }
                wireBytes += next.value.byteLength;
                if (wireBytes > WIRE_LIMIT) {
                  failure = new McpError("limit");
                  controller.error(failure);
                  await reader.cancel();
                  stopped.abort();
                  return;
                }
                controller.enqueue(next.value);
              } catch (error) {
                controller.error(error);
              }
            },
            async cancel(reason) {
              await reader.cancel(reason);
            },
          }),
          {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          },
        );
      },
    });
    await client.connect(transport, { signal: combined, timeout: 15_000 });
    return await operation(client, redact, combined);
  } catch (error) {
    // Never forward arbitrary SDK diagnostics: they can contain URLs, bodies and credentials.
    let kind: McpFailure = "unavailable";
    if (failure) {
      kind = failure.kind;
    } else if (signal.aborted) {
      kind = "cancelled";
    } else if (timeout.aborted) {
      kind = "timeout";
    } else if (error instanceof McpError) {
      kind = error.kind;
    } else if (error instanceof UnauthorizedError) {
      kind = "auth_required";
    } else if (
      error instanceof Error &&
      "code" in error &&
      error.code === -32001
    ) {
      kind = "timeout";
    }
    throw toolError(server.id, kind);
  } finally {
    combined.removeEventListener("abort", abort);
    // Termination is best effort and bounded. Local sockets always close, including failed initialize.
    if (transport?.sessionId && !combined.aborted) {
      await Promise.race([
        transport.terminateSession().catch(() => {}),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500);
          timer.unref();
        }),
      ]);
    }
    stopped.abort();
    await client.close().catch(() => {});
    await transport?.close().catch(() => {});
  }
}

/** Startup discovery: all pages, with finite pagination and duplicate/cursor-cycle rejection. */
export async function advertised(
  client: Client,
  signal: AbortSignal,
  redact: (value: string) => string,
): Promise<Map<string, ToolContract>> {
  const tools = new Map<string, ToolContract>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursors.size >= 256) {
      throw new McpError("limit");
    }
    // Low-level SDK request intentionally avoids listTools' output-schema compiler/cache.
    // Only reviewed inputSchema/description form the supported advertised contract.
    const page = await client.request(
      { method: "tools/list", params: cursor ? { cursor } : {} },
      ListToolsResultSchema,
      { signal, timeout: 15_000 },
    );
    for (const tool of page.tools) {
      if (tools.has(tool.name)) {
        throw new McpError("protocol");
      }
      const parsed = toolContractSchema.safeParse({
        description: tool.description ?? tool.name,
        inputSchema: tool.inputSchema,
      });
      if (!parsed.success) {
        throw new McpError("protocol");
      }
      // A server may echo its credentials in advertising. Never show those to a model.
      const contract = JSON.stringify(parsed.data);
      if (redact(contract) !== contract) {
        throw new McpError("protocol");
      }
      tools.set(tool.name, parsed.data);
      if (tools.size > 1024) {
        throw new McpError("limit");
      }
    }
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (!cursor || cursors.has(cursor)) {
        throw new McpError("protocol");
      }
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return tools;
}

export function discoverRemote(
  server: HostServer,
  signal: AbortSignal,
): Promise<Map<string, ToolContract>> {
  return connected(server, signal, (client, redact, current) =>
    advertised(client, current, redact),
  );
}

export function callRemote(
  server: HostServer,
  tool: string,
  args: unknown,
  signal: AbortSignal,
): Promise<ToolExecutionResult> {
  return connected(server, signal, async (client, redact, current) => {
    if (Buffer.byteLength(JSON.stringify(args)) > 1_048_576) {
      throw new McpError("limit");
    }
    const input = z.record(z.string(), z.unknown()).safeParse(args);
    if (!input.success) {
      throw new McpError("protocol");
    }
    const result = await client.request(
      { method: "tools/call", params: { name: tool, arguments: input.data } },
      CallToolResultSchema,
      { signal: current, timeout: 60_000 },
    );
    try {
      return boundResult(result, redact);
    } catch {
      throw new McpError("protocol");
    }
  });
}
