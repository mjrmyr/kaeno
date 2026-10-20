// src/extensions/mcp: Kaeno's tool plane. Module map (only this file is importable):
//
//   server.ts         McpServer / Placement / HostCredentials / ToolPolicy and `mcpTools`, the
//                     single MCP -> durable projection. The only branch on placement.
//   contract.ts       the one lock format; pure `reconcile` (allowlist x lock -> live | retired).
//   results.ts        untrusted-output bounding, redaction, failure taxonomy.
//   remote.ts         host placement: Streamable HTTP, connect-per-call, per-call credentials.
//   work.ts           work placement: WorkMcpHost, composed into envd (runs in the sandbox).
//   configuration.ts  mcp.json -> one `kaeno-mcp-<id>` extension per owner-declared server,
//                     plus the derived role policy (McpInstallation).
//   lock.ts           owner/dev commands: `lock` and OAuth `login`.
//
// Call chains:
//   host:  server.ts execute -> remote.ts callRemote -> SDK
//   work:  server.ts execute -> RemoteExecutionEnv.mcp -> envd /mcp -> work.ts WorkMcpHost -> SDK
//
// Consumers: host/main.ts (loadMcpConfiguration), host/envd.ts (WorkMcpHost), browser
// (mcpTools + its own McpServer value), scripts/mcp.ts and scripts/auth.ts.

export {
  mcpTools,
  serverIdSchema,
  type McpServer,
  type McpToolSet,
  type Placement,
  type HostCredentials,
  type ToolPolicy,
  type ServerId,
} from "./server.ts";
export {
  readLock,
  contractDigest,
  type PinnedServer,
  type PinnedTool,
} from "./contract.ts";
export {
  loadMcpConfiguration,
  lockFileFor,
  type McpInstallation,
} from "./configuration.ts";
export {
  WorkMcpHost,
  type WorkServerRecipe,
  type SessionProbe,
} from "./work.ts";
export { lockMcp, loginMcp, type LockTarget, type LockReport } from "./lock.ts";
