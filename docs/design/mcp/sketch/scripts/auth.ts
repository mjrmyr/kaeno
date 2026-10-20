// EXCERPT: scripts/auth.ts gains one subcommand.
//   npm run auth -- login openai [--output <file>]                     (unchanged)
//   npm run auth -- login mcp <id> [--config <mcp.json>] [--output <file>]
// The mcp branch reads the server URL from mcp.json, then calls
//   loginMcp(config, id, new FileCredentialStore(path), promptForRedirect, signal)
// which stores `mcp:<id>` in the same auth.json the host already reads. Kaeno never opens an
// authorization URL at runtime; an expired-and-unrefreshable token is a tool error naming this command.
export {};
