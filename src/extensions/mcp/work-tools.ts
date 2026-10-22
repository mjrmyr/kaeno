import type { AgentExtension } from "../contributions/index.ts";
import type { ToolContract } from "./contract.ts";
import { mcpTools, workCall } from "./server.ts";
import { discoverWork, type WorkServerRecipe } from "./work.ts";

export interface WorkMcpInstallation {
  extension: AgentExtension;
  /** Worker defaults: tools that loaded. The worker ceiling is the whole extension. */
  live: { tools: string[] };
  diagnostics: string[];
}

/**
 * Registers a WORK-placed server. Discovery lists tools from a short-lived local process
 * (Playwright does not launch Chromium for that); every call runs in the WORK sandbox. A
 * failed discovery logs a diagnostic and registers placeholders, like a host server.
 */
export async function workMcpTools(
  recipe: WorkServerRecipe,
  options: { extensionName?: string; guidance?: string } = {},
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<WorkMcpInstallation> {
  const diagnostics: string[] = [];
  let advertised = new Map<string, ToolContract>();
  try {
    advertised = await discoverWork(recipe, signal);
  } catch {
    diagnostics.push(
      `${recipe.id}: unavailable at startup; its tools are unavailable`,
    );
  }
  const set = mcpTools({
    id: recipe.id,
    tools: recipe.tools.map((upstream) => ({ upstream })),
    advertised,
    call: workCall(recipe.id),
    ...options,
  });
  if (!diagnostics.length) {
    diagnostics.push(
      ...set.unavailable.map(
        (name) => `${recipe.id}: ${name} is not advertised; it is unavailable`,
      ),
    );
  }
  return { extension: set.extension, live: set.live, diagnostics };
}
