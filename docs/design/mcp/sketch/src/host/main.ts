// EXCERPT of src/host/main.ts after the change. Only MCP-related lines differ.
import { loadMcpConfiguration } from "../extensions/mcp/index.ts";
import { browserExtension } from "../extensions/browser/index.ts";
import { DEFAULT_AUTH_FILE, FileCredentialStore } from "./auth/index.ts";
// ...existing imports (GitHub wiring unchanged)...

// Moved up (was after loadEnvironment): the same host credential store now serves model
// providers AND MCP OAuth (`mcp:<id>`). The seed import moves up with it.
const credentials = new FileCredentialStore(
  process.env.KAENO_AUTH_FILE ?? DEFAULT_AUTH_FILE,
);
const browser = await browserExtension(); // offline now: reads browser/mcp.lock.json
// Offline: mcp.json + mcp.lock.json; one `kaeno-mcp-<id>` extension per server (retired too).
const mcp = process.env.KAENO_MCP_CONFIG
  ? await loadMcpConfiguration(process.env.KAENO_MCP_CONFIG, { credentials })
  : undefined;

const configuration = await loadEnvironment({
  extensions: [...githubExtensions, browser, ...(mcp?.extensions ?? [])],
  // MCP's role rules come from the feature (McpInstallation.policy); the host only spreads them.
  policy: (base) => ({
    assistant: {
      available: [
        ...base.assistant.available,
        ...githubExtensions,
        ...(mcp?.policy.assistant.available ?? []),
      ],
      defaults: [...base.assistant.defaults, ...githubExtensions],
    },
    worker: {
      available: [
        ...base.worker.available,
        ...githubExtensions,
        browser,
        ...(mcp?.policy.worker.available ?? []),
      ],
      defaults: [
        ...base.worker.defaults,
        ...githubExtensions,
        browser,
        ...(mcp?.policy.worker.defaults ?? []),
      ],
    },
  }),
  // ...unchanged...
});

declare const githubExtensions: readonly unknown[];
declare function loadEnvironment(options: unknown): Promise<unknown>;
