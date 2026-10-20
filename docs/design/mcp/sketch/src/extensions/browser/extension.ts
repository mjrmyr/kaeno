// AFTER: Browser stays a native extension. It loses its private copy of the MCP projection and
// result bounding (≈55 lines incl. its zod resultSchema) and uses the shared adapter instead.
// session.ts, the envd `/browser` route, `RemoteExecutionEnv.browser`, BROWSER_TOOLS, the
// sandbox-only rule and the section are unchanged.

import { defineExtension, section } from "@earendil-works/pi-durable";
import type { AgentExtension } from "../contributions/index.ts";
import { RemoteExecutionEnv } from "../execution/index.ts";
import { mcpToolRegistration } from "../mcp/index.ts";
import { discoverBrowserTools } from "./session.ts";

/** Register WORK-only browser tools; execution stays inside the WORK network boundary. */
export async function browserExtension(): Promise<AgentExtension> {
  // In-process discovery; the contract is pinned by package-lock (@playwright/mcp 0.0.83)
  // plus the BROWSER_TOOLS allowlist — the in-process analogue of mcp.lock.json.
  const discovered = await discoverBrowserTools();
  const tools = discovered.map((tool) =>
    mcpToolRegistration({
      name: tool.name, // upstream names are already `browser_`-namespaced
      contract: {
        description: tool.description ?? tool.name,
        inputSchema: tool.inputSchema,
      },
      replay: "unsafe",
      executionMode: "sequential",
      source: "web pages",
      async call(args, api, context) {
        if (!(api.env instanceof RemoteExecutionEnv)) {
          throw new Error(
            "Browser MCP requires a WORK sandbox; host execution is forbidden",
          );
        }
        // Secret-free: no redactor needed.
        return {
          raw: await api.env.browser(
            { name: tool.name, arguments: args },
            context,
          ),
        };
      },
    }),
  );
  return {
    runtime: {
      durable: defineExtension({
        name: "kaeno-browser",
        tools,
        sections: [
          section(
            "browser",
            () =>
              "Browser tools use an isolated Playwright MCP session in this WORK sandbox. ... (unchanged)",
          ),
        ],
      }),
    },
  };
}
