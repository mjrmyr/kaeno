// Owner/developer commands. The only code paths that discover tools or perform OAuth login.

import type { CredentialStore } from "@earendil-works/pi-ai";
import type { PinnedTool } from "./contract.ts";
import type { McpServer } from "./server.ts";

/**
 * How `lock` lists a server's tools. Host servers: through remote.ts `connect` with the same
 * credential resolution as calls. Work servers: the declaring feature
 * supplies an in-process discovery (Browser: @playwright/mcp createConnection + InMemoryTransport,
 * exactly today's discoverBrowserTools, which never launches Chromium).
 */
/** A server as declared, before its pins exist (lock produces `pinned`). */
export type LockTarget =
  | { readonly server: Omit<McpServer, "pinned">; readonly discover?: never }
  | {
      readonly server: Omit<McpServer, "pinned">;
      readonly discover: (
        signal: AbortSignal,
      ) => Promise<ReadonlyMap<string, PinnedTool>>;
    };

export interface LockReport {
  readonly lockFile: string;
  readonly servers: readonly {
    readonly id: string;
    readonly added: readonly string[];
    /** description or schema changed since the previous pin: the review point ("rug pull"). */
    readonly changed: readonly string[];
    /** previously allowlisted, now not: kept as tombstones, NOT dropped. */
    readonly retired: readonly string[];
    /** upstream has them, allowlist does not (helps write the allowlist). */
    readonly unlisted: readonly string[];
    /** e.g. "create_comment listed read; upstream readOnlyHint=false". Advisory only. */
    readonly warnings: readonly string[];
  }[];
}

/**
 * `npm run mcp -- lock [--config mcp.json | --builtin] [--repoint <id>] [--forget <id>/<tool>]`
 *
 * For every target: list tools (all pages), pin allowlisted ones, CARRY FORWARD every previous
 * pin that is no longer allowlisted (tombstone), write atomically (temp + rename), sorted keys.
 * All-or-nothing: any failure writes nothing.
 *
 * Fails on: unreachable server; allowlisted tool missing upstream (a tombstoned previous pin
 * does not satisfy an allowlist entry); description > 4 KiB or schema > 32 KiB or not an object;
 * origin change without `--repoint <id>`.
 *
 * `--builtin` regenerates the committed locks of code-declared servers (browser) and is
 * a developer action reviewed in a PR; owners only ever lock mcp.json.
 * `--forget <id>/<tool>` drops a tombstone. It opens the database read-only (KAENO_DATABASE) and
 * refuses while any conversation's `pi.agent.tools` or any saved WORK plan still names the tool;
 * the owner's word is not enough, because recovery is what breaks if they are wrong.
 */
export async function lockMcp(
  lockFile: string,
  targets: readonly LockTarget[],
  options: {
    readonly repoint: readonly string[];
    readonly forget: readonly string[];
    readonly signal: AbortSignal;
  },
): Promise<LockReport> {
  void [lockFile, targets, options];
  throw new Error("not implemented");
}

/**
 * `npm run auth -- login mcp <id>`: MCP authorization for one configured server.
 * Protected-resource metadata discovery -> authorization server metadata -> dynamic client
 * registration (or a preconfigured client id) -> PKCE authorization code with a loopback
 * redirect or a paste-the-code fallback for a headless host -> tokens bound to the server URL
 * (resource indicator). Stored in the host CredentialStore under `mcp:<id>` as
 * `{ type: "oauth", access, refresh, expires, client, resource }` (the oauth variant already
 * passes extra fields through). The only place Kaeno opens an authorization URL.
 *
 * Schema gap (host/auth/credentials.ts): the oauth variant requires `refresh: min(1)` and a
 * finite `expires`. Servers that issue no refresh token cannot be stored today. Implementation
 * step: relax `refresh` to optional for `mcp:*` entries (re-login on expiry) in the host schema;
 * do not smuggle them into `api_key`, which is not passthrough.
 *
 * Kubernetes: `--output <file>` writes a seed, but `importSeed` REPLACES the whole document
 * (credentials.ts importSeed), resetting model providers' rotated refresh tokens to stale seed
 * copies. Before MCP logins ship through KAENO_AUTH_SEED_FILE, importSeed must merge by
 * provider id (seeded entries win only when the seed entry changed).
 */
export async function loginMcp(
  configFile: string,
  id: string,
  credentials: CredentialStore,
  prompt: (url: URL) => Promise<string>,
  signal: AbortSignal,
): Promise<void> {
  void [configFile, id, credentials, prompt, signal];
  throw new Error("not implemented");
}
