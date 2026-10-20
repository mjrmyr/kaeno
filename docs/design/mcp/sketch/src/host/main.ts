// EXCERPT of src/host/main.ts after the change. Only the MCP lines are new.

import { loadMcpConfiguration } from "../extensions/mcp/index.ts";
// ...existing imports...

const browser = await browserExtension();
const githubExtensions = [/* unchanged */];
// Offline: reads mcp.json + mcp.lock.json; no server is contacted at startup.
const mcp = process.env.KAENO_MCP_CONFIG
  ? await loadMcpConfiguration(process.env.KAENO_MCP_CONFIG)
  : [];
// Derived, not listed: read tools are exactly what each server extension declares read-only.
const mcpReads = {
  tools: mcp.flatMap((server) => server.runtime.readOnlyTools ?? []),
};

const configuration = await loadEnvironment({
  extensions: [...githubExtensions, browser, ...mcp],
  policy: (base) => ({
    assistant: {
      // CHAT may look things up when a profile asks; not by default, so CHAT conversations do
      // not all come to depend on every MCP extension.
      available: [...base.assistant.available, ...githubExtensions, mcpReads],
      defaults: [...base.assistant.defaults, ...githubExtensions],
    },
    worker: {
      // Whole-server selectors in the ceiling (tombstones included: frozen WORK plans must fit).
      // Defaults use `live`, derived from the same registrations minus tombstones.
      available: [
        ...base.worker.available,
        ...githubExtensions,
        browser,
        ...mcp,
      ],
      defaults: [
        ...base.worker.defaults,
        ...githubExtensions,
        browser,
        ...mcp.map((server) => server.live),
      ],
    },
  }),
  // ...unchanged...
});

declare function browserExtension(): Promise<never>;
declare function loadEnvironment(options: unknown): Promise<unknown>;
