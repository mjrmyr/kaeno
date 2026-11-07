import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { z } from "zod";
import type {
  SandboxIdentity,
  SandboxOptions,
  SandboxProvider,
} from "../execution/index.ts";

export const MANAGED_LABEL = "kaeno.io/managed-work";
const ID_LABEL = "kaeno.io/work-id";
const NAMESPACE_LABEL = "kaeno.io/namespace";
const IMAGE_LABEL = "kaeno.io/work-image";
const TOKEN_HASH_LABEL = "kaeno.io/token-sha256";

export interface WorkVm {
  name: string;
  running: boolean;
  labels: Record<string, string>;
  hostPort?: number;
}

/** microsandbox-specific boundary; kept behind SandboxProvider. */
export interface SandboxEngine {
  /** Stable local store identity, so changing MSB_HOME cannot silently retarget live work. */
  readonly target: string;
  inspect(name: string): Promise<WorkVm | undefined>;
  /** Boots a new VM and starts envd in it. */
  create(
    name: string,
    sandbox: SandboxIdentity,
    options: SandboxOptions,
    labels: Record<string, string>,
  ): Promise<void>;
  /** Boots a stopped VM. Processes do not survive a stop, so envd must be relaunched. */
  start(name: string): Promise<void>;
  /** Starts envd in a running VM. */
  launch(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  managed(): Promise<WorkVm[]>;
}

/** Local microVM implementation of the provider contract used by work orchestration. */
export class MicrosandboxSandboxProvider implements SandboxProvider {
  readonly identity: string;
  private readonly engine: SandboxEngine;
  private readonly fetch: typeof globalThis.fetch;
  private readonly namespace: string;
  private readonly readyTimeoutMs: number;
  private readonly createEnvironment: (input: {
    url: string;
    token: string;
    id: string;
    cwd: string;
    fetch: typeof globalThis.fetch;
  }) => ExecutionEnv;

  constructor(options: {
    engine: SandboxEngine;
    fetch?: typeof globalThis.fetch;
    /** Stable owner namespace; separate applications sharing a host must use distinct values. */
    namespace?: string;
    readyTimeoutMs?: number;
    createEnvironment(input: {
      url: string;
      token: string;
      id: string;
      cwd: string;
      fetch: typeof globalThis.fetch;
    }): ExecutionEnv;
  }) {
    this.engine = options.engine;
    this.fetch = options.fetch ?? fetch;
    this.createEnvironment = options.createEnvironment;
    this.namespace = z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/)
      .parse(options.namespace ?? "default");
    this.readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
    this.identity = JSON.stringify({
      provider: "microsandbox",
      namespace: this.namespace,
      target: this.engine.target,
    });
  }

  async ensure(
    sandbox: SandboxIdentity,
    options: SandboxOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    sandbox = this.scoped(sandbox);
    const name = vmName(sandbox.id);
    validateRequest(sandbox, options);
    let vm = await this.engine.inspect(name);
    let launched = false;
    if (!vm) {
      try {
        await this.engine.create(
          name,
          sandbox,
          options,
          labelsFor(sandbox, this.namespace),
        );
        launched = true;
      } catch (error) {
        // Another retry/process may have won the deterministic-name create race.
        vm = await this.engine.inspect(name);
        if (!vm) {
          throw error;
        }
      }
      vm ??= await this.engine.inspect(name);
    }
    if (
      !vm ||
      vm.labels[MANAGED_LABEL] !== "true" ||
      vm.labels[NAMESPACE_LABEL] !== this.namespace ||
      vm.labels[ID_LABEL] !== sandbox.id ||
      vm.labels[IMAGE_LABEL] !== sandbox.image ||
      vm.labels[TOKEN_HASH_LABEL] !== tokenHash(sandbox.token)
    ) {
      throw new Error(`microsandbox identity mismatch for ${sandbox.id}`);
    }
    if (!vm.running) {
      await this.engine.start(name);
      launched = false;
    }
    if (!launched && !(await this.healthy(name, signal))) {
      await this.engine.launch(name);
    }
    await this.waitUntilReady(name, signal);
  }

  async executionEnvironment(
    sandbox: SandboxIdentity,
    cwd: string,
  ): Promise<ExecutionEnv> {
    sandbox = this.scoped(sandbox);
    return this.createEnvironment({
      url: `http://127.0.0.1:${await this.portFor(sandbox.id)}`,
      token: sandbox.token,
      id: `microsandbox:${sandbox.id}`,
      cwd,
      fetch: this.fetch,
    });
  }

  async stop(sandbox: SandboxIdentity): Promise<void> {
    await this.engine.stop(vmName(this.scoped(sandbox).id));
  }

  async remove(sandbox: SandboxIdentity): Promise<void> {
    sandbox = this.scoped(sandbox);
    await this.engine.remove(vmName(sandbox.id));
  }

  async reconcile(active: readonly SandboxIdentity[]): Promise<void> {
    const keep = new Set(active.map((sandbox) => this.scoped(sandbox).id));
    for (const vm of await this.engine.managed()) {
      const id = vm.labels[ID_LABEL];
      if (
        vm.labels[NAMESPACE_LABEL] === this.namespace &&
        id &&
        !keep.has(id)
      ) {
        await this.engine.remove(vm.name);
      }
    }
  }

  private scoped(sandbox: SandboxIdentity): SandboxIdentity {
    return { ...sandbox, id: `${this.namespace}-${sandbox.id}` };
  }

  private async portFor(id: string): Promise<number> {
    const vm = await this.engine.inspect(vmName(id));
    if (!vm?.running || vm.hostPort === undefined) {
      throw new Error(
        `microsandbox ${id} is not running or has no published port`,
      );
    }
    return vm.hostPort;
  }

  private async healthy(name: string, signal?: AbortSignal): Promise<boolean> {
    const vm = await this.engine.inspect(name);
    if (!vm?.running || vm.hostPort === undefined) {
      return false;
    }
    try {
      const response = await this.fetch(
        `http://127.0.0.1:${vm.hostPort}/healthz`,
        {
          signal: AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(Math.min(this.readyTimeoutMs, 1000)),
          ]),
        },
      );
      return response.ok;
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }

  private async waitUntilReady(
    name: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const vm = await this.engine.inspect(name);
      if (!vm?.running) {
        throw new Error(`microsandbox ${name} stopped before becoming ready`);
      }
      if (await this.healthy(name, signal)) {
        return;
      }
      await delay(250, signal);
    }
    throw new Error(`microsandbox ${name} did not become ready`);
  }
}

function labelsFor(
  sandbox: SandboxIdentity,
  namespace: string,
): Record<string, string> {
  return {
    [MANAGED_LABEL]: "true",
    [NAMESPACE_LABEL]: namespace,
    [ID_LABEL]: sandbox.id,
    [IMAGE_LABEL]: sandbox.image,
    [TOKEN_HASH_LABEL]: tokenHash(sandbox.token),
  };
}

function validateRequest(
  sandbox: SandboxIdentity,
  options: SandboxOptions,
): void {
  vmName(sandbox.id);
  if (sandbox.token.length < 32) {
    throw new Error("Sandbox token must be at least 32 characters");
  }
  if (!sandbox.image.trim()) {
    throw new Error("Sandbox image must not be empty");
  }
  const cwd = posix.resolve(options.cwd);
  if (cwd !== "/workspace" && !cwd.startsWith("/workspace/")) {
    throw new Error("Sandbox cwd must be inside /workspace");
  }
  if (
    !Number.isFinite(options.limits.cpus) ||
    options.limits.cpus <= 0 ||
    !Number.isSafeInteger(options.limits.memoryBytes) ||
    options.limits.memoryBytes < 1_048_576
  ) {
    throw new Error(
      "Sandbox CPU must be positive and memory must be at least one MiB",
    );
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function vmName(id: string): string {
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(id)) {
    throw new Error(`Invalid sandbox id: ${id}`);
  }
  return `kaeno-work-${id}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    const timer = setTimeout(finish, ms);
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Aborted"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
