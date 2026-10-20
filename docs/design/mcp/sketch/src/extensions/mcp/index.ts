// Module map (src/extensions/mcp/, 5 files, everything else private to the feature):
//
//   index.ts          public surface: three functions + two types. Nothing else is importable.
//   configuration.ts  mcp.json + mcp.lock.json: zod at the file boundary -> domain types; pure
//                     reconcile(config, lock) that fails closed on any disagreement.
//   remote.ts         the only code that speaks Streamable HTTP: connect-per-call client, header
//                     files, response cap; builds one AgentExtension per configured server.
//   tools.ts          the shared MCP -> durable tool adapter: projection, CallToolResult parsing,
//                     bounding, redaction, untrusted-output note, toolError. Used by remote.ts
//                     AND by browser.
//   lock.ts           owner-run discovery: lists upstream tools, pins allowlisted contracts,
//                     carries tombstones forward, guards origin changes (--repoint).
//
// Call chain for a model tool call (3 files): tools.ts registration.execute -> remote.ts call ->
// SDK. For the browser: tools.ts registration.execute -> browser call -> envd (unchanged).
//
// Startup never touches the network: loadMcpConfiguration reads two local files.

export { loadMcpConfiguration, type McpServerExtension } from "./remote.ts";
export { lockMcpConfiguration, type LockReport } from "./lock.ts";
export { mcpToolRegistration, type McpToolContract } from "./tools.ts";
