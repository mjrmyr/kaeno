import type { SandboxLimits, SandboxProvider } from "./sandbox-provider.ts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type {
  KaenoExtension,
  WorkEnvironment,
} from "../../core/application/index.ts";

/** Runtime capabilities produced by an execution extension's validated configuration. */
export interface ConfiguredExecution {
  readonly environment: WorkEnvironment;
  readonly extensions: readonly KaenoExtension[];
}

/** Host-supplied dependencies, not provider-specific configuration. */
export interface ExecutionConfigurationContext {
  /** Stable application namespace, used when the provider file does not specify one. */
  readonly defaultNamespace: string;
  createSandboxEnvironment(options: {
    sandbox: SandboxProvider;
    image: string;
    limits: SandboxLimits;
  }): WorkEnvironment;
  createEnvironment(input: {
    url: string;
    token: string;
    id: string;
    cwd: string;
  }): ExecutionEnv;
}

/** Each extension owns reading, strict validation, defaults and construction for its file. */
export type ExecutionConfigurationLoader = (
  path: string,
  context: ExecutionConfigurationContext,
) => Promise<ConfiguredExecution>;
