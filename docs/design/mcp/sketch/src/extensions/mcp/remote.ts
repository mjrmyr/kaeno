import type { Context } from "@earendil-works/chord";
import { defineExtension, type JsonObject } from "@earendil-works/pi-durable";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AgentExtension } from "../contributions/index.ts";
import {
  lockFileFor,
  readIntents,
  reconcile,
  type RemoteServer,
} from "./configuration.ts";
import { mcpToolRegistration, toolError } from "./tools.ts";

/**
 * One configured server. The object itself is the whole-server selector and belongs in role
 * `available` (it includes tombstones, which frozen WORK plans need inside the ceiling).
 * `live` is derived from the same registrations, minus tombstones, and belongs in `defaults`.
 */
export type McpServerExtension = AgentExtension & {
  /** Structurally a `{ tools }` ContributionSelector; extensions may not import host types. */
  readonly live: { readonly tools: readonly string[] };
};

/**
 * Install every server in mcp.json as its own extension, offline: reads mcp.json and
 * mcp.lock.json, reconciles them, builds tools. No connection is made.
 *
 * One AgentExtension per server, because each server is independently:
 *   - a policy unit: `worker.available: [linear]` vs `{ tools: ["linear_get_issue"] }`;
 *   - a recovery unit: removing `notion` from config fails closed only if saved work uses notion tools;
 *   - a readOnlyTools owner (core requires readOnly names to be owned by the declaring extension).
 *
 * Durable extension name: `kaeno-mcp-<server>`, forever (recovery requires it; retire, never
 * rename). No `bind`, no `start`, no cleanup: there is no per-conversation state, no long-lived
 * connection, nothing to reconcile after restart. Origin stability is enforced by `lock`.
 */
export async function loadMcpConfiguration(
  configFile: string,
): Promise<McpServerExtension[]> {
  // TODO:
  // const servers = reconcile(await readIntents(configFile), lockSchema.parse(JSON.parse(await readFile(lockFileFor(configFile)))));
  // return servers.map(serverExtension);
  void [readIntents, reconcile, lockFileFor];
  void configFile;
  throw new Error("not implemented");
}

function serverExtension(server: RemoteServer): McpServerExtension {
  // TODO:
  // const tools = server.tools.map((tool) => mcpToolRegistration({
  //   name: tool.name,
  //   contract: tool.contract,
  //   replay: tool.kind === "read" ? "safe" : "unsafe",
  //   // Writes keep their round sequential so the model's ordering is the execution order.
  //   executionMode: tool.kind === "read" ? undefined : "sequential",
  //   source: `the ${server.name} MCP server`,
  //   call: tool.kind === "retired" || !server.url
  //     ? () => { throw toolError(server.name, "retired", `${tool.name} was retired by the owner`); }
  //     : (args, _api, context) => callOnce(server, tool.upstream, args, context),
  // }));
  // return {
  //   runtime: {
  //     durable: defineExtension({ name: `kaeno-mcp-${server.name}`, tools }),
  //     readOnlyTools: server.tools.filter((t) => t.kind === "read").map((t) => t.name),
  //   },
  //   live: { tools: server.tools.filter((t) => t.kind !== "retired").map((t) => t.name) },
  // };
  void [defineExtension, mcpToolRegistration, toolError];
  void server;
  throw new Error("not implemented");
}

/**
 * Connect, initialize, call one tool, terminate. Placement: the Kaeno host process, for CHAT and
 * WORK alike (`api.env` is ignored). Credentials therefore never enter a WORK sandbox.
 *
 * Invariant: no MCP session outlives one tool call. Consequences, all intentional:
 *   - no state is shared between conversations, WORKs or sibling workers;
 *   - a restart loses nothing (a durable replay would have broken session continuity anyway);
 *   - concurrent calls are independent; no locks, no pool, no idle reaper.
 * Servers whose tools only make sense inside a long session are unsupported in v1.
 *
 * Cancellation: `context.abortSignal` is passed to connect and callTool (the SDK sends
 * notifications/cancelled). Deadlines: connect 15 s, call 60 s.
 */
async function callOnce(
  server: RemoteServer,
  upstream: string,
  args: JsonObject,
  context: Context,
): Promise<unknown> {
  // TODO:
  // const { client, secrets } = await openRemote(server, context.abortSignal);
  // try {
  //   const raw = await client.callTool({ name: upstream, arguments: args }, undefined,
  //     { signal: context.abortSignal, timeout: 60_000 });
  //   return { raw, redact: redactor(secrets) };  // tools.ts bounds, then redacts every secret value
  // } catch (error) {
  //   // kind (timeout|cancelled|unavailable|protocol) + <=500 chars of body text, never headers,
  //   // secret values replaced with [redacted].
  //   throw toolError(server.name, classify(error), detail(error), redactor(secrets));
  // } finally {
  //   await client.transport?.terminateSession?.().catch(() => {}); // best-effort DELETE
  //   await client.close();
  // }
  void [server, upstream, args, context];
  throw new Error("not implemented");
}

/**
 * The single Streamable HTTP connector, shared by tool calls and `lock`.
 *
 * - Client capabilities: `{}`. Advertising no sampling/elicitation/roots means a compliant
 *   server never asks Kaeno for model access or human input. Any server->client request is
 *   answered with method-not-found by the SDK default.
 * - No `authProvider`: a 401 is an error, never an OAuth redirect flow.
 * - SDK default `redirectPolicy: "same-origin"`: header secrets are not sent to another origin.
 * - `fetch` wrapper caps each response body at 4 MB (stream aborted beyond it).
 * - Header values are read from `headerFiles` on every call and returned as `secrets` so results
 *   and errors can be redacted against exactly the values sent.
 * - Server notifications (listChanged, logging, progress) are ignored.
 */
export async function openRemote(
  server: {
    readonly name: string;
    readonly url: URL;
    readonly headerFiles: ReadonlyMap<string, string>;
  },
  signal: AbortSignal,
): Promise<{ client: Client; secrets: readonly string[] }> {
  void [server, signal];
  throw new Error("not implemented");
}
