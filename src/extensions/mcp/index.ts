/** MCP stays a native extension, not a core tool registry or generic proxy. */
export { loadMcpConfiguration, type McpInstallation } from "./configuration.ts";
export { mcpTools, type McpServer } from "./server.ts";
