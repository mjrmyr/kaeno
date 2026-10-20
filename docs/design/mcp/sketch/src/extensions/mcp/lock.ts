import {
  lockFileFor,
  readIntents,
  type ServerIntent,
} from "./configuration.ts";
import { openRemote } from "./remote.ts";
import type { McpToolContract } from "./tools.ts";

/** What changed relative to the previous lock, per server, for the owner to review. */
export interface LockReport {
  readonly lockFile: string;
  readonly servers: readonly {
    readonly name: string;
    readonly added: readonly string[];
    /** Description or inputSchema differs from the previous pin: review before restarting. */
    readonly changed: readonly string[];
    readonly removed: readonly string[];
    /** Upstream tools that exist but are not allowlisted (to help write the allowlist). */
    readonly unlisted: readonly string[];
    /** Pins carried forward unchanged because the owner retired them (never re-fetched). */
    readonly retired: readonly string[];
    /**
     * Owner classification vs upstream annotations, e.g. "get_x listed as read but upstream
     * says destructiveHint". Advisory only: annotations are server claims and never decide policy.
     */
    readonly warnings: readonly string[];
  }[];
}

/**
 * Owner-run, never at startup. For every server in mcp.json: connect, page through tools/list,
 * select the allowlisted tools, pin `{ description, inputSchema }`, write mcp.lock.json.
 *
 * Tombstones: retired tools (and every tool of a retired server) keep their previous pin without
 * contacting upstream; a retired server is never connected to.
 *
 * All-or-nothing: any failure writes nothing and leaves the previous lock in force. Failures:
 * - unreachable server; allowlisted tool missing upstream;
 * - oversize description > 4 KiB or schema > 32 KiB JSON; schema not `type: "object"`;
 * - a previously pinned tool that is neither allowlisted nor retired ("retire it; saved
 *   conversations may reference it" — recovery walks every conversation);
 * - a retired tool with no previous pin (nothing to keep registered);
 * - a server whose url origin differs from its previous pin, unless `repoint` names it
 *   (the owner states that saved work under this name will follow the new origin). Idempotent: unchanged upstreams produce byte-identical output
 * (sorted keys), written atomically (temp file + rename).
 *
 * The lock is the defence against tool-description drift ("rug pull"): a server can change what
 * it advertises, but Kaeno's model only sees it after the owner re-locks and restarts.
 */
export async function lockMcpConfiguration(
  configFile: string,
  options: {
    readonly repoint?: readonly string[];
    readonly signal: AbortSignal;
  },
): Promise<LockReport> {
  // TODO:
  // const intents = await readIntents(configFile);
  // const pinned = {};
  // const previous = await readPreviousLock(lockFileFor(configFile));   // may be absent
  // for (const intent of intents) {
  //   if (intent.retired) { pinned[intent.name] = previous.servers[intent.name] ?? fail(); continue; }
  //   guardOrigin(intent, previous, options.repoint);
  //   pinned[intent.name] = { url: intent.url.href,
  //     tools: { ...carryRetired(intent, previous), ...(await pin(intent, options.signal)) } };
  //   assertNothingDropped(intent, previous);   // pure; the tombstone rule
  // }
  // diff against previous lock if present (for the report only)
  // atomic write lockFileFor(configFile)
  void [readIntents, lockFileFor, openRemote, configFile, options];
  throw new Error("not implemented");
}

async function pin(
  intent: Extract<ServerIntent, { retired: false }>,
  signal: AbortSignal,
): Promise<Record<string, McpToolContract>> {
  // TODO: listTools with cursor pagination; `description ?? name`; reject missing allowlisted names.
  void [intent, signal];
  throw new Error("not implemented");
}
