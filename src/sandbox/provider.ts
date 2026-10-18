import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** Stable work-owned identity persisted so a sandbox can be adopted after restart. */
export interface SandboxIdentity {
  id: string;
  token: string;
  image: string;
}

export interface SandboxLimits {
  /** Fractional CPU cores, for example 1.5. */
  cpus: number;
  /** Memory limit in bytes. */
  memoryBytes: number;
}

export interface SandboxOptions {
  cwd: string;
  limits: SandboxLimits;
}

/**
 * Work depends on this lifecycle, not on Docker/Kubernetes concepts. Implementations
 * must make ensure idempotent and remove safe to repeat; reconcile removes resources
 * that no longer correspond to active work.
 */
export interface SandboxProvider {
  ensure(
    sandbox: SandboxIdentity,
    options: SandboxOptions,
    signal?: AbortSignal,
  ): Promise<void>;
  executionEnvironment(
    sandbox: SandboxIdentity,
    cwd: string,
  ): Promise<ExecutionEnv>;
  remove(sandbox: SandboxIdentity): Promise<void>;
  reconcile(active: readonly SandboxIdentity[]): Promise<void>;
}
