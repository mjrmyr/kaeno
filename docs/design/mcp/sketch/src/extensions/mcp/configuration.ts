import { z } from "zod";
import type { McpToolContract } from "./tools.ts";

// ---------------------------------------------------------------------------------------------
// File boundary. Both files are owner-controlled host files (like ~/.kaeno/github.json).
// zod parses them here; nothing past this module sees raw JSON.
// ---------------------------------------------------------------------------------------------

/** Lowercase, no underscore: `<server>_<tool>` splits unambiguously and stays short. */
/** Native integration namespaces; a configured server must not shadow their tool prefixes. */
const RESERVED: ReadonlySet<string> = new Set([
  "github",
  "browser",
  "work",
  "mcp",
  "kaeno",
]);
const serverName = z
  .string()
  .regex(/^[a-z][a-z0-9]{0,15}$/)
  .refine((name) => !RESERVED.has(name), "reserved server name");
/** Upstream MCP names allow `.`; provider tool-name rules do not. Checked on the joined name. */
const KAENO_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * mcp.json (KAENO_MCP_CONFIG). Example: examples/mcp.json.
 *
 * - `url`: https, or http only for a loopback host. The model never chooses a URL. Its origin is
 *   stable per server name: `lock` refuses to re-pin another origin without `--repoint <server>`.
 * - `headerFiles`: header name -> file whose trimmed contents are the header value
 *   (e.g. "Bearer lin_api_..."). Paths resolve relative to mcp.json. Secrets can only be given
 *   as files, so they cannot be pasted into the config, the lock, a prompt or a binding.
 * - `tools.read` / `tools.write`: the allowlist AND the classification, in one place. A tool is
 *   offered only if listed; every listed tool is in exactly one class; there is no wildcard and
 *   no default class to forget.
 * - `tools.retired`: tombstones. Recovery (core/durable/recovery.ts) walks every conversation and
 *   requires each once-selected tool and extension to stay installed, so a tool is never deleted:
 *   it is retired. A retired tool keeps its pinned registration and stays inside the worker
 *   ceiling (frozen WORK plans must still fit it, core/work/plan.ts), is never in a `live`
 *   default selector, and every call returns an error without connecting.
 * - A whole server is retired with `{ "retired": true }` (no url, no secrets): all of its locked
 *   tools become tombstones and `kaeno-mcp-<server>` stays installed for recovery.
 */
export const configurationSchema = z
  .object({
    servers: z.record(
      serverName,
      z.union([
        z
          .object({
            url: z.string().url(),
            headerFiles: z
              .record(z.string().min(1), z.string().min(1))
              .default({}),
            tools: z
              .object({
                read: z.array(z.string().min(1)).default([]),
                write: z.array(z.string().min(1)).default([]),
                retired: z.array(z.string().min(1)).default([]),
              })
              .strict(),
          })
          .strict(),
        z.object({ retired: z.literal(true) }).strict(),
      ]),
    ),
  })
  .strict();

/**
 * mcp.lock.json, written only by `npm run mcp -- lock`, next to mcp.json. Holds the reviewed
 * upstream contracts. Keyed by upstream tool name. Carries `url` so a re-pointed server cannot
 * reuse a lock pinned against another endpoint. Does not repeat the read/write classification
 * (single source of truth: mcp.json).
 */
export const lockSchema = z
  .object({
    version: z.literal(1),
    servers: z.record(
      serverName,
      z
        .object({
          url: z.string(),
          tools: z.record(
            z.string(),
            z.object({
              description: z.string().max(4096),
              inputSchema: z.record(z.string(), z.unknown()),
            }),
          ),
        })
        .strict(),
    ),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Domain types.
// ---------------------------------------------------------------------------------------------

export interface RemoteTool {
  /** Kaeno-visible: `${server}_${upstream}`. */
  readonly name: string;
  readonly upstream: string;
  /**
   * `retired`: registered for recovery only. Not in `readOnlyTools`, not in the server's `live`
   * selector (remote.ts), and `execute` fails without connecting.
   */
  readonly kind: "read" | "write" | "retired";
  readonly contract: McpToolContract;
}

/** One configured remote server, fully resolved and reconciled with its lock entry. */
export interface RemoteServer {
  readonly name: string;
  /** Absent only for a retired server; then every tool has kind "retired". */
  readonly url?: URL;
  /** Header name -> absolute secret file path. Read per connection (rotation without restart). */
  readonly headerFiles: ReadonlyMap<string, string>;
  readonly tools: readonly RemoteTool[];
}

/** Allowlist intent from mcp.json before contracts are attached (what `lock` needs). */
export type ServerIntent =
  | {
      readonly name: string;
      readonly retired: false;
      readonly url: URL;
      readonly headerFiles: ReadonlyMap<string, string>;
      readonly read: readonly string[];
      readonly write: readonly string[];
      readonly retiredTools: readonly string[];
    }
  | { readonly name: string; readonly retired: true };

/**
 * Parse mcp.json. Fails on: a URL that is not https (or loopback http), a tool in more than one
 * of read/write/retired, duplicate tool names,
 * a joined name that violates KAENO_TOOL_NAME, an unreadable header file (existence only;
 * contents are read per call).
 */
export async function readIntents(configFile: string): Promise<ServerIntent[]> {
  void configFile;
  void KAENO_TOOL_NAME;
  throw new Error("not implemented");
}

/** `/x/mcp.json` -> `/x/mcp.lock.json`. Derived, never configured. */
export function lockFileFor(configFile: string): string {
  void configFile;
  throw new Error("not implemented");
}

/**
 * Pure. Attach pinned contracts to intents. Fails closed, listing every problem at once, when:
 * - a configured server has no lock entry, or its lock `url` differs from the config `url`;
 * - an allowlisted or retired tool has no pinned contract (tombstones need their pin);
 * - the lock pins a tool that is no longer allowlisted, or a server no longer configured
 *   (stale lock = the owner changed config without re-locking).
 * Every message ends with "run `npm run mcp -- lock`".
 *
 * Never consults the network: whether the upstream still has the tool is a call-time fact.
 */
export function reconcile(
  intents: readonly ServerIntent[],
  lock: z.infer<typeof lockSchema>,
): RemoteServer[] {
  void intents;
  void lock;
  throw new Error("not implemented");
}
