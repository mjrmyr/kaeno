import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ToolContract } from "./contract.ts";
import { advertised } from "./remote.ts";

/** Calls a recipe guard can make on its live session, including tools the model cannot call. */
export interface SessionProbe {
  call(
    name: string,
    args: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<CallToolResult>;
}

/**
 * A stdio MCP server that runs inside each WORK sandbox, one session per WORK. Recipes are
 * code-declared by the feature that owns the server: its binary has to be in the image, and
 * the sandbox never receives credentials, so there is no auth field.
 */
export interface WorkServerRecipe {
  readonly id: string;
  /** Upstream tools envd forwards. The host registers the same list. */
  readonly tools: readonly string[];
  /**
   * Command line for a fresh session. `directory` is a new temp dir used as cwd. `env` is the
   * child's whole environment: no envd token, SSH key or provider credentials.
   */
  spawn(directory: string): {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  };
  readonly limits: {
    readonly connectMs: number;
    readonly callMs: number;
    readonly overallMs: number;
    /** A serialized response above this resets the session; also the stdio framing cap. */
    readonly responseBytes: number;
  };
  /** Handle a call locally: `close` resets this session instead of calling upstream. */
  intercept?(name: string): "close" | undefined;
  /** Post-success guard; throwing fails the call and resets the session. */
  afterCall?(probe: SessionProbe, result: CallToolResult): Promise<void>;
}

export const workCallSchema = z
  .object({
    server: z.string(),
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

interface Session {
  client: Client;
  directory: string;
}

async function connect(
  recipe: WorkServerRecipe,
  signal: AbortSignal,
): Promise<Session> {
  const directory = await mkdtemp(join(tmpdir(), `kaeno-${recipe.id}-`));
  try {
    const { command, args, env } = recipe.spawn(directory);
    const client = new Client({ name: "kaeno-work-mcp", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command,
        args: [...args],
        cwd: directory,
        env: { ...env },
        maxBufferSize: recipe.limits.responseBytes,
        stderr: "ignore",
      }),
      { signal, timeout: recipe.limits.connectMs },
    );
    return { client, directory };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function disconnect(session: Session | undefined): Promise<void> {
  try {
    await session?.client.close();
  } finally {
    if (session) {
      await rm(session.directory, { recursive: true, force: true });
    }
  }
}

/** Host startup only: lists the recipe's tools from a short-lived process, then stops it. */
export async function discoverWork(
  recipe: WorkServerRecipe,
  signal: AbortSignal,
): Promise<Map<string, ToolContract>> {
  const session = await connect(recipe, signal);
  try {
    return await advertised(session.client, signal, (text) => text);
  } finally {
    await disconnect(session);
  }
}

/**
 * envd's MCP capability (one envd per WORK): one lazily started session per recipe.
 * Calls are single-flight per server; a concurrent call is rejected, not queued. Any error,
 * cancellation, deadline, oversize or guard failure discards that session, because a
 * cancelled command may still be mutating state.
 */
export class WorkMcpHost {
  private readonly recipes: ReadonlyMap<string, WorkServerRecipe>;
  private readonly sessions = new Map<string, Session>();
  private readonly busy = new Set<string>();

  constructor(recipes: readonly WorkServerRecipe[]) {
    this.recipes = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  }

  async call(input: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const { server, name, arguments: args } = workCallSchema.parse(input);
    const recipe = this.recipes.get(server);
    if (!recipe) {
      throw new Error(`Unknown WORK MCP server: ${server}`);
    }
    // The host is not trusted to have checked the allowlist.
    if (!recipe.tools.includes(name)) {
      throw new Error(`${server}: tool not allowed: ${name}`);
    }
    if (this.busy.has(server)) {
      throw new Error(`${server}: session is busy; calls must be sequential`);
    }
    this.busy.add(server);
    const deadline = AbortSignal.timeout(recipe.limits.overallMs);
    const cancellation = signal
      ? AbortSignal.any([signal, deadline])
      : deadline;
    try {
      cancellation.throwIfAborted();
      if (recipe.intercept?.(name) === "close") {
        await this.closeOne(server);
        return { content: [] };
      }
      let session = this.sessions.get(server);
      if (!session) {
        session = await connect(recipe, cancellation);
        this.sessions.set(server, session);
      }
      const { client } = session;
      const result = CallToolResultSchema.parse(
        await client.callTool({ name, arguments: args }, undefined, {
          signal: cancellation,
          timeout: recipe.limits.callMs,
        }),
      );
      if (JSON.stringify(result).length > recipe.limits.responseBytes) {
        throw new Error(`${server}: response too large; session reset`);
      }
      if (!result.isError) {
        await recipe.afterCall?.(
          {
            call: async (probeName, probeArgs, timeoutMs) =>
              CallToolResultSchema.parse(
                await client.callTool(
                  { name: probeName, arguments: { ...probeArgs } },
                  undefined,
                  { signal: cancellation, timeout: timeoutMs },
                ),
              ),
          },
          result,
        );
      }
      return result;
    } catch (error) {
      await this.closeOne(server);
      throw error;
    } finally {
      this.busy.delete(server);
    }
  }

  private async closeOne(server: string): Promise<void> {
    const session = this.sessions.get(server);
    this.sessions.delete(server);
    await disconnect(session);
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.sessions.keys()].map((server) => this.closeOne(server)),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      throw failed.reason;
    }
  }
}
