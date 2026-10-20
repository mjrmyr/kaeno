// Work placement: runs INSIDE envd (one envd per WORK sandbox). This is BrowserSession with the
// browser taken out: lazy stdio spawn, sanitized env, temp HOME, single-flight, deadlines,
// response cap, reset-on-any-failure, idle expiry, cleanup. Server-specific behaviour lives in
// a recipe owned by the server's own feature (src/extensions/browser/recipe.ts).

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";

/** Read-only view a recipe gets of its live session, for guards that need hidden tools. */
export interface SessionProbe {
  /** Call any upstream tool, including non-allowlisted ones (Browser's `browser_tabs`). */
  call(
    name: string,
    args: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<CallToolResult>;
}

/**
 * Code-declared, image-baked description of one sandbox stdio server. Declared by the feature
 * that owns the server; composed into envd by src/host/envd.ts. Owner config cannot add one:
 * the binary must be in the image and its lock must be produced by code review.
 */
export interface WorkServerRecipe {
  readonly id: string;
  /**
   * Upstream names envd will forward. The SAME constant the feature uses for its host-side
   * ToolPolicy list (single source; envd re-checks because the host is not trusted to have).
   */
  readonly tools: readonly string[];
  /** `<package>@<version>` resolved from the installed package; part of the lock origin. */
  readonly version: string;
  /** contractDigest of this feature's committed lock, computed from the file in THIS image. */
  readonly digest: string;
  /**
   * Command line for a fresh session. `directory` is a new temp dir that becomes cwd, HOME and
   * TMPDIR. The returned env is the child's WHOLE env (the host adds nothing, the SDK's default
   * inherited variables are overridden): no envd token, no SSH key, no provider credentials.
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
    /** Serialized response above this resets the session (and is the stdio framing cap). */
    readonly responseBytes: number;
    readonly idleMs: number;
  };
  /**
   * Handle a call locally instead of upstream. `close` is the generic "reset this session"
   * (Browser maps `browser_close` to it because upstream close relaunches Chromium, #34).
   */
  intercept?(name: string): "close" | undefined;
  /** Post-success guard; throw to fail the call AND reset the session (Browser: > 8 tabs). */
  afterCall?(probe: SessionProbe, result: CallToolResult): Promise<void>;
}

const workCallSchema = z
  .object({
    server: z.string(),
    /** contractDigest of the host's pins; must equal the digest of this image's lock. */
    digest: z.string(),
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * envd's single MCP capability (replaces the `browser` constructor slot of EnvironmentServer).
 * Shape-compatible with that slot: `{ call(input, signal), close() }`.
 *
 * State: Map<recipe id, Session>. One owner (this object, one per envd = one per WORK); the
 * transient per-tool-call RemoteExecutionEnv client ids never key anything (they would lose
 * state). Sessions are never durable: a sandbox restart starts fresh, a host restart does not
 * touch them (the sandbox is adopted, envd keeps running).
 *
 * Invariants:
 *   - single-flight per server; a concurrent call is rejected ("busy"), not queued
 *     (Browser's current behaviour; queueing would hide model ordering bugs);
 *   - any error, cancel, deadline, oversize or guard failure closes that server's session:
 *     a cancelled command may still be mutating state, so it is never reused;
 *   - when the host's request goes away mid-call (host crash), envd aborts it -> reset. The
 *     durable side settles that call as "interrupted, may have partially run" (replay unsafe);
 *   - `close()` (envd /cleanup, SIGTERM) closes every session; sandbox deletion is the final
 *     process boundary.
 */
export class WorkMcpHost {
  private readonly recipes: ReadonlyMap<string, WorkServerRecipe>;
  private readonly sessions = new Map<
    string,
    { client: Client; directory: string; busy: boolean; lastUsed: number }
  >();

  constructor(recipes: readonly WorkServerRecipe[]) {
    this.recipes = new Map(recipes.map((recipe) => [recipe.id, recipe]));
    // TODO: idle reaper: setInterval(unref) closing sessions idle > recipe.limits.idleMs
  }

  /** envd `/mcp` route body. Validates server + allowlist before anything is spawned. */
  async call(input: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    // TODO:
    // const { server, name, arguments: args } = workCallSchema.parse(input);
    // const recipe = this.recipes.get(server) ?? throw "unknown work server";
    // if (digest !== recipe.digest) throw toolError(server, "image_skew", "sandbox image differs from host; start a new WORK");
    // if (!recipe.tools.includes(name)) throw "tool not allowed";
    // single-flight check; deadline = AbortSignal.any([signal, timeout(overallMs)])
    // if (recipe.intercept?.(name) === "close") { await this.closeOne(server); return { content: [] }; }
    // session = existing ?? spawn(recipe)   (StdioClientTransport, stderr ignored, maxBufferSize)
    // result = client.callTool(...callMs); size check; if (!isError) await recipe.afterCall?.(probe, result)
    // catch -> closeOne(server); rethrow.  finally -> busy=false, lastUsed=now
    void [workCallSchema, input, signal];
    throw new Error("not implemented");
  }

  async close(): Promise<void> {
    // TODO: close every session (each in try/finally rm -rf its directory), errors aggregated
    throw new Error("not implemented");
  }
}
