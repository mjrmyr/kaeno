import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { loadDockerConfiguration } from "../../extensions/docker/index.ts";
import {
  RemoteExecutionEnv,
  SandboxWorkEnvironment,
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
  // Do not load the native SDK on Docker/Kubernetes-only hosts.
  microsandbox: async (path, context) => {
    const { loadMicrosandboxConfiguration } =
      await import("../../extensions/microsandbox/index.ts");
    return loadMicrosandboxConfiguration(path, context);
  },
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
    createSandboxEnvironment: (options) => new SandboxWorkEnvironment(options),
    createEnvironment: ({ url, token, id, cwd }) =>
      new RemoteExecutionEnv(url, token, id, cwd, fetch),
  });
}
