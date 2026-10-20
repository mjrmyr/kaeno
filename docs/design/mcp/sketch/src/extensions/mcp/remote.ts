// Host placement: the only Streamable HTTP code in Kaeno. Used by tool calls and by `lock`.

import type { Context } from "@earendil-works/chord";
import type { JsonObject, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { HostCredentials, Placement, ServerId } from "./server.ts";
import { toolError } from "./results.ts";

/**
 * Connect, initialize, call one tool, DELETE the session, close.
 *
 * Invariant: no host MCP session outlives one tool call. Session state lives where the WORK
 * lives (work placement), never on the host. Consequences, all intended:
 *   - host restart / durable replay loses nothing (a replayed `read` simply reconnects);
 *   - no pool, no idle reaper, no `start` hook, no per-conversation session doc;
 *   - credentials are resolved per call, so rotation never needs a restart.
 * Servers whose tools only work inside one long session are unsupported on the host; if they
 * are worth having, they are a work recipe. A per-conversation session POOL may come later as a
 * measured handshake optimization only: it must never be relied on for state, because restart,
 * eviction and idle expiry would drop that state silently.
 *
 * Drift check (the lock pins what the model is TOLD; this checks what the server DOES): the
 * first call per server per process also runs `tools/list` (all pages) on the same connection
 * and caches, per tool, whether the live {description, inputSchema} still equals the pin. A
 * drifted tool fails closed with toolError("drift", "contract changed upstream; review with
 * `npm run mcp -- lock`"). Undrifted tools keep working. The cache is process-local and never
 * durable; a restart re-checks.
 *
 * Client capabilities `{}`: no sampling (a server never spends Kaeno's model), no elicitation
 * (never asks a human mid-WORK), no roots. Server->client requests get method-not-found.
 * `initialize.instructions`, logging, progress and listChanged are ignored.
 * Redirects: same-origin only (credentials never follow to another origin). Response bodies
 * capped at 4 MB. Deadlines: connect 15 s, call 60 s; `context.abortSignal` -> notifications/cancelled.
 */
export async function callRemote(
  server: ServerId,
  placement: Extract<Placement, { kind: "host" }>,
  call: {
    readonly name: string;
    readonly tool: string;
    readonly arguments: JsonObject;
  },
  api: ToolExecutionApi,
  context: Context,
): Promise<{ result: unknown; redact: (text: string) => string }> {
  // TODO:
  // const { headers, secrets } = await resolveCredentials(server, placement.credentials, call, api, context);
  // const redact = redactor(secrets);
  // const client = await connect(placement.url, headers, context.abortSignal);
  // try {
  //   return { result: await client.callTool({ name: call.tool, arguments: call.arguments }, undefined,
  //     { signal: context.abortSignal, timeout: 60_000 }), redact };
  // } catch (error) {
  //   throw toolError(server, classify(error), detail(error), redact);   // never headers/bodies
  // } finally {
  //   await terminateQuietly(client); // best-effort DELETE + close
  // }
  void [server, placement, call, api, context, toolError];
  throw new Error("not implemented");
}

/**
 * Per-call credential resolution. One switch, three sources: none | (see HostCredentials):
 *   headerFiles -> read every file now (rotation without restart)
 *   oauth       -> store.modify(providerId, refreshIfNeeded): refresh under the store's
 *                  cross-process lock when expiring within 60 s, so two concurrent calls never
 *                  both spend a rotating refresh token. Kaeno OWNS refresh: the SDK transport
 *                  gets a static Authorization header for this one connection and NO
 *                  authProvider, so the SDK's reactive 401 path can never call saveTokens
 *                  outside `modify`. A 401 -> one forced refresh under `modify`, one reconnect;
 *                  still 401 or refresh fails -> toolError("auth_required"). Never redirects to
 *                  an authorization page at runtime.
 */
async function resolveCredentials(
  server: ServerId,
  credentials: HostCredentials,
  call: {
    readonly name: string;
    readonly tool: string;
    readonly arguments: JsonObject;
  },
  api: ToolExecutionApi,
  context: Context,
): Promise<{
  headers: Readonly<Record<string, string>>;
  secrets: readonly string[];
}> {
  void [server, credentials, call, api, context];
  throw new Error("not implemented");
}

/** Shared with lock.ts: list tools (all pages) through the same connector and credentials. */
export async function connect(
  url: URL,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<Client> {
  void [url, headers, signal, resolveCredentials];
  throw new Error("not implemented");
}
