import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { loadDockerConfiguration } from "../../extensions/docker/index.ts";
import {
  RemoteExecutionEnv,
  type ConfiguredExecution,
  type ExecutionConfigurationLoader,
} from "../../extensions/execution/index.ts";
import { loadKubernetesConfiguration } from "../../extensions/kubernetes/index.ts";
import type { ExecutionConfiguration } from "./configuration.ts";

// Static installation, not plugin discovery. Adding a provider requires a compatible loader.
const loaders: Record<
  ExecutionConfiguration["provider"],
  ExecutionConfigurationLoader
> = {
  docker: loadDockerConfiguration,
  kubernetes: loadKubernetesConfiguration,
};

/** Select trusted installed code; provider configuration and construction belong to that code. */
export async function loadExecution(
  config: ExecutionConfiguration,
  databaseFile: string,
): Promise<ConfiguredExecution> {
  return loaders[config.provider](config.configFile, {
    defaultNamespace: createHash("sha256")
      .update(resolve(databaseFile))
      .digest("hex")
      .slice(0, 16),
    createEnvironment: ({ url, token, id, cwd }) =>
      new RemoteExecutionEnv(url, token, id, cwd, fetch),
  });
}
