import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  RemoteExecutionEnv,
  SandboxWorkEnvironment,
  type ConfiguredExecution,
  type ExecutionProvider,
} from "../../extensions/execution/index.ts";
import type { ExecutionConfiguration } from "./configuration.ts";

/** Resolve a configured name against trusted providers installed by the application. */
export async function loadExecution(
  config: ExecutionConfiguration,
  databaseFile: string,
  providers: readonly ExecutionProvider[],
): Promise<ConfiguredExecution> {
  const installed = new Map<string, ExecutionProvider>();
  for (const provider of providers) {
    if (installed.has(provider.name)) {
      throw new Error(`Duplicate execution provider "${provider.name}"`);
    }
    installed.set(provider.name, provider);
  }
  const provider = installed.get(config.provider);
  if (!provider) {
    throw new Error(
      `Unknown execution provider "${config.provider}". Installed: ${[...installed.keys()].join(", ") || "(none)"}.`,
    );
  }
  return provider.loadConfiguration(config.configFile, {
    defaultNamespace: createHash("sha256")
      .update(resolve(databaseFile))
      .digest("hex")
      .slice(0, 16),
    createSandboxEnvironment: (options) => new SandboxWorkEnvironment(options),
    createEnvironment: ({ url, token, id, cwd }) =>
      new RemoteExecutionEnv(url, token, id, cwd, fetch),
  });
}
