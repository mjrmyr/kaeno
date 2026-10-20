// mcp.json: owner-declared servers. Host placement only (see Placement). Zod at the file
// boundary; nothing past this module sees raw JSON.

import type { CredentialStore } from "@earendil-works/pi-ai";
import { defineExtension } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { AgentExtension } from "../contributions/index.ts";
import { readLock } from "./contract.ts";
import { mcpTools, serverIdSchema, type McpServer } from "./server.ts";

/**
 * {
 *   "servers": {
 *     "linear": {
 *       "url": "https://mcp.linear.app/mcp",
 *       "auth": { "oauth": true },                      // or { "headerFiles": {...} } or omitted
 *       "tools": { "read": ["list_issues", "get_issue"], "write": ["create_comment"] }
 *     }
 *   }
 * }
 *
 * - No `retired` list: removing a tool (or a whole server) from this file turns its lock pin
 *   into a tombstone automatically (contract.ts reconcile). A removed server whose pins remain
 *   in mcp.lock.json stays installed as `kaeno-mcp-<id>` with every tool retired.
 * - No `placement`, no `command`: owner config cannot run binaries anywhere.
 * - No `roles`: role policy is DERIVED below from `class` and placement, never hand-written.
 */
const configurationSchema = z
  .object({
    servers: z.record(
      serverIdSchema,
      z
        .object({
          url: z.string().url(),
          auth: z
            .union([
              z.object({ oauth: z.literal(true) }).strict(),
              z
                .object({
                  headerFiles: z.record(z.string().min(1), z.string().min(1)),
                })
                .strict(),
            ])
            .optional(),
          tools: z
            .object({
              read: z.array(z.string().min(1)).default([]),
              write: z.array(z.string().min(1)).default([]),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

/** Structurally a host ContributionSelector; extensions cannot import host types. */
type Selector = AgentExtension | { readonly tools: readonly string[] };

/**
 * Everything the host needs, with the role rules encoded HERE instead of in main.ts, so a host
 * cannot get them subtly wrong by copying the nearest example:
 *
 *   worker.available    every server extension (tombstones included: frozen WORK plans must fit)
 *   worker.defaults     live tools only (tombstones never reach a new agent)
 *   assistant.available live READ tools only (CHAT: no write tools, no tombstones; a profile
 *                       may still select them explicitly)
 *   assistant.defaults  none (context budget: a default would put every server's tools in
 *                       every CHAT prompt)
 */
export interface McpInstallation {
  readonly extensions: readonly AgentExtension[];
  readonly policy: {
    readonly assistant: {
      readonly available: readonly Selector[];
      readonly defaults: readonly Selector[];
    };
    readonly worker: {
      readonly available: readonly Selector[];
      readonly defaults: readonly Selector[];
    };
  };
}

/**
 * Offline. Reads mcp.json and its sibling mcp.lock.json, builds one `kaeno-mcp-<id>` extension per
 * server in EITHER file (config-only -> fail "run lock"; lock-only -> fully retired server).
 * No bind, no start, no cleanup: there is no per-conversation or per-process MCP state.
 */
export async function loadMcpConfiguration(
  configFile: string,
  dependencies: { readonly credentials: CredentialStore },
): Promise<McpInstallation> {
  // TODO:
  // const config = configurationSchema.parse(JSON.parse(await readFile(configFile)));
  // const lock = await readLock(lockFileFor(configFile));
  // for each id in union(config.servers, lock): build McpServer {
  //   placement: { kind: "host", url, credentials: oauth ? { kind: "oauth", providerId: `mcp:${id}`, store }
  //                 : headerFiles ? { kind: "headerFiles", files: resolved relative to configFile } : { kind: "none" } },
  //   tools: [...read.map(class read), ...write.map(class write)],   // a name in both -> fail
  //   pinned: lock.get(id), source: `the ${id} MCP server` }
  // const set = mcpTools(server);
  // extension = { runtime: { durable: defineExtension({ name: `kaeno-mcp-${id}`, tools: set.tools }),
  //                            readOnlyTools: set.readOnlyTools } };
  // return { extensions, policy: derived per the table on McpInstallation };
  void [configurationSchema, readLock, mcpTools, defineExtension];
  void [configFile, dependencies];
  throw new Error("not implemented");
}

/** `/x/mcp.json` -> `/x/mcp.lock.json`. Derived, never configured. */
export function lockFileFor(configFile: string): string {
  void configFile;
  throw new Error("not implemented");
}

export type { McpServer };
