/** A stateful stdio MCP server for WORK MCP tests. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

let count = 0;
const server = new Server(
  { name: "fixture", version: "1" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ["count", "env", "hidden"].map((name) => ({
    name,
    description: `Fixture ${name}`,
    inputSchema: { type: "object" as const },
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const text =
    request.params.name === "env"
      ? JSON.stringify(Object.keys(process.env).sort())
      : String(++count);
  return { content: [{ type: "text" as const, text }] };
});
await server.connect(new StdioServerTransport());
