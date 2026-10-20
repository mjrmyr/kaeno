// Contract pinning: the ONE lock format, for code-declared servers (committed next to their
// extension: src/extensions/browser/mcp.lock.json) and for
// owner-declared servers (~/.kaeno/mcp.lock.json next to mcp.json). Startup only reads locks.
// Nothing contacts an MCP server at startup, including Browser (whose in-process Playwright
// discovery moves from host startup into `npm run mcp -- lock`).

import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer, ServerId } from "./server.ts";

/** A reviewed upstream tool contract. A domain type: annotations/title/outputSchema/_meta dropped. */
export interface PinnedTool {
  readonly description: string;
  /** JSON Schema, `type: "object"`, <= 32 KiB serialized. Opaque beyond that; Type.Unsafe'd. */
  readonly inputSchema: { readonly type: "object" } & Readonly<
    Record<string, unknown>
  >;
}

/**
 * One server's lock entry. `origin` ties the pins to an endpoint: an https origin for host
 * servers, `work:<recipe>@<package version>` for work servers. Reconcile fails when the declared
 * placement's origin differs (a re-pointed server never silently reuses old pins).
 */
export interface PinnedServer {
  readonly origin: string;
  /** Keyed by upstream name. Superset of the allowlist: extra entries are tombstones. */
  readonly tools: ReadonlyMap<string, PinnedTool>;
}

const pinnedToolSchema = z
  .object({
    description: z.string().max(4096),
    inputSchema: z.object({ type: z.literal("object") }).catchall(z.unknown()),
  })
  .strict();

/** On-disk shape. Byte-stable (sorted keys) so `git diff` is the review. */
export const lockFileSchema = z
  .object({
    version: z.literal(1),
    servers: z.record(
      z.string(),
      z
        .object({
          origin: z.string(),
          tools: z.record(z.string(), pinnedToolSchema),
        })
        .strict(),
    ),
  })
  .strict();

/** Parse a lock file into domain values. The only reader of any lock. */
export async function readLock(
  path: string,
): Promise<ReadonlyMap<string, PinnedServer>> {
  // TODO: lockFileSchema.parse(JSON.parse(await readFile(path, "utf8"))) -> Map of PinnedServer
  void [readFile, path];
  throw new Error("not implemented");
}

/** One tool after reconciling the allowlist with the lock. */
export interface ResolvedTool {
  readonly name: string;
  readonly upstream: string;
  readonly pinned: PinnedTool;
  readonly status: "live" | "retired";
  /** Live tools only; a tombstone has no class (it is never readOnly, never replayed as safe). */
  readonly class?: "read" | "write";
}

/**
 * Pure. allowlist x lock -> resolved tools. Derivation, not sync:
 *
 *   live    = allowlisted AND pinned
 *   retired = pinned AND NOT allowlisted       (tombstone; registered for recovery only)
 *   error   = allowlisted AND NOT pinned       ("run `npm run mcp -- lock`")
 *
 * Also fails (listing every problem at once) on: origin mismatch; a joined name outside
 * `^[A-Za-z0-9_-]{1,64}$`; two upstream tools mapping to one Kaeno name.
 *
 * Why tombstones are derived: recovery (core/durable/recovery.ts) walks every conversation,
 * idle ones included, and requires each positively selected tool name to stay registered in
 * its extension. Deleting a tool from the allowlist must therefore never delete its
 * registration; it must turn it into an error-returning stub. Making that the automatic
 * consequence of "pinned but not allowed" means the owner cannot forget it.
 */
export function reconcile(server: McpServer): readonly ResolvedTool[] {
  void [server];
  throw new Error("not implemented");
}

/**
 * Lock key of a placement; reconcile compares it with PinnedServer.origin.
 *   host -> the URL's origin (`https://mcp.linear.app`)
 *   work -> `work:<recipe>@<package version>`
 */
export function originOf(server: Pick<McpServer, "placement">): string {
  void server;
  throw new Error("not implemented");
}

/**
 * sha256 over the canonical JSON of the pinned contracts of a work server's allowlisted tools.
 * The host sends it with every `/mcp` call; envd's WorkMcpHost compares it with the digest of
 * the lock baked into ITS image and refuses a mismatch as `image_skew`. This covers sandboxes
 * adopted from an older image after a host upgrade (#42 adoption): the model is never told one
 * contract while the sandbox runs another. A package bump changes the origin AND, if the
 * contract moved, the digest.
 */
export function contractDigest(
  server: Pick<McpServer, "pinned" | "tools">,
): string {
  void server;
  throw new Error("not implemented");
}

export type { ServerId };
