// `npm run mcp -- lock [--config <file>] [--repoint <server>]...` (package.json: "mcp": "node --env-file-if-exists=.env scripts/mcp.ts")
// Same shape as scripts/auth.ts: an owner command on the host, not a runtime path.
//
// Prints the LockReport: added / changed / removed / unlisted per server. Exit 1 and an
// untouched lock on any failure. Restart Kaeno to apply a new lock.

import { parseArgs } from "node:util";
import { lockMcpConfiguration } from "../src/extensions/mcp/index.ts";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      repoint: { type: "string", multiple: true },
    },
  });
  if (positionals.join(" ") !== "lock") {
    throw new Error(
      "Usage: npm run mcp -- lock [--config <file>] [--repoint <server>]...",
    );
  }
  const configFile = values.config ?? process.env.KAENO_MCP_CONFIG;
  if (!configFile) {
    throw new Error("Set KAENO_MCP_CONFIG or pass --config");
  }
  void lockMcpConfiguration;
  throw new Error("not implemented");
}
await main();
