import { createRequire } from "node:module";
import { join } from "node:path";
import type { WorkServerRecipe } from "../mcp/index.ts";

// No arbitrary code, upload, installation, downloads or page-defined WebMCP tools.
export const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_wait_for",
  "browser_take_screenshot",
  "browser_close",
] as const;

const cli = join(
  createRequire(import.meta.url).resolve("@playwright/mcp/package.json"),
  "..",
  "cli.js",
);

/** Official Playwright MCP as a stdio child of envd, one isolated browser per WORK. */
export const browserRecipe: WorkServerRecipe = {
  id: "browser",
  tools: BROWSER_TOOLS,
  spawn: (directory) => ({
    command: process.execPath,
    args: [
      cli,
      "--headless",
      "--browser",
      "chromium",
      "--isolated",
      // Owner-approved: restricted WORK pod is the outer boundary, not renderer isolation.
      "--no-sandbox",
      "--no-webmcp",
      "--block-service-workers",
      "--codegen",
      "none",
      "--timeout-action",
      "10000",
      "--timeout-navigation",
      "30000",
      "--idle-timeout",
      "300000",
      "--output-max-size",
      "16777216",
    ],
    env: {
      HOME: directory,
      TMPDIR: directory,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      // Override the SDK's default inherited POSIX identity/shell variables too.
      LOGNAME: "agent",
      USER: "agent",
      SHELL: "/bin/sh",
      TERM: "dumb",
      PLAYWRIGHT_BROWSERS_PATH:
        process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/ms-playwright",
    },
  }),
  limits: {
    connectMs: 15_000,
    callMs: 40_000,
    overallMs: 45_000,
    responseBytes: 4_000_000,
  },
  // Upstream close initializes a browser even after launch failed. Reset locally instead.
  intercept: (name) => (name === "browser_close" ? "close" : undefined),
  async afterCall(probe): Promise<void> {
    const tabs = await probe.call("browser_tabs", { action: "list" }, 5000);
    if ((JSON.stringify(tabs).match(/- \d+:/g) ?? []).length > 8) {
      throw new Error("Browser exceeded 8 tabs; session reset");
    }
  },
};
