import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createConnection } from "@playwright/mcp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";

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
export const browserRequest = z.object({
  name: z.enum(BROWSER_TOOLS),
  arguments: z.record(z.string(), z.unknown()),
});

/** Schema discovery only: the official server does not launch Chromium until a browser call. */
export async function discoverBrowserTools(): Promise<Tool[]> {
  const server = await createConnection({ webmcp: false });
  const client = new Client({ name: "kaeno-discovery", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(remote);
    await client.connect(local);
    const { tools } = await client.listTools();
    return BROWSER_TOOLS.map((name) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new Error(`Pinned Playwright MCP lacks ${name}`);
      }
      return tool;
    });
  } finally {
    await client.close();
    await server.close();
  }
}

/** Owned by envd (one envd per WORK), never by the host or a transient remote-env client. */
export class BrowserSession {
  private client?: Client;
  private directory?: string;
  private busy = false;

  async call(value: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const input = browserRequest.parse(value);
    if (this.busy) {
      throw new Error("Browser session is busy; calls must be sequential");
    }
    this.busy = true;
    const deadline = AbortSignal.timeout(45_000);
    const cancellation = signal
      ? AbortSignal.any([signal, deadline])
      : deadline;
    try {
      cancellation.throwIfAborted();
      if (!this.client) {
        this.directory = await mkdtemp(join(tmpdir(), "kaeno-browser-"));
        const transport = new StdioClientTransport({
          command: process.execPath,
          maxBufferSize: 4_000_000,
          args: [
            join(
              createRequire(import.meta.url).resolve(
                "@playwright/mcp/package.json",
              ),
              "..",
              "cli.js",
            ),
            "--headless",
            "--browser",
            "chromium",
            "--isolated",
            "--sandbox",
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
          cwd: this.directory,
          env: {
            HOME: this.directory,
            TMPDIR: this.directory,
            PATH: "/usr/local/bin:/usr/bin:/bin",
            // Override the SDK's default inherited POSIX identity/shell variables too.
            LOGNAME: "agent",
            USER: "agent",
            SHELL: "/bin/sh",
            TERM: "dumb",
            PLAYWRIGHT_BROWSERS_PATH:
              process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/ms-playwright",
          },
          stderr: "ignore",
        });
        this.client = new Client({
          name: "kaeno-browser-client",
          version: "1",
        });
        await this.client.connect(transport, {
          signal: cancellation,
          timeout: 15_000,
        });
      }
      const result = await this.client.callTool(
        { name: input.name, arguments: input.arguments },
        undefined,
        { signal: cancellation, timeout: 40_000 },
      );
      if (JSON.stringify(result).length > 4_000_000) {
        throw new Error("Browser response exceeds 4 MB; session reset");
      }
      if (input.name === "browser_close" || result.isError) {
        return CallToolResultSchema.parse(result);
      }
      const tabs = await this.client.callTool(
        { name: "browser_tabs", arguments: { action: "list" } },
        undefined,
        { signal: cancellation, timeout: 5000 },
      );
      const tabText = JSON.stringify(tabs);
      if ((tabText.match(/- \d+:/g) ?? []).length > 8) {
        throw new Error("Browser exceeded 8 tabs; session reset");
      }
      return CallToolResultSchema.parse(result);
    } catch (error) {
      // A cancelled command may still be mutating the page. Never reuse that session.
      await this.close();
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    try {
      await client?.close();
    } finally {
      if (this.directory) {
        await rm(this.directory, { recursive: true, force: true });
      }
      this.directory = undefined;
    }
  }
}
