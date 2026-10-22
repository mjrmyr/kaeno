/** MCP stays a native extension, not a core tool registry or generic proxy. */
export { loadMcpConfiguration, type McpInstallation } from "./configuration.ts";
export { mcpTools, type McpServer } from "./server.ts";
export {
  WorkMcpHost,
  type SessionProbe,
  type WorkServerRecipe,
} from "./work.ts";
export { workMcpTools, type WorkMcpInstallation } from "./work-tools.ts";
