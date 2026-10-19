import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { posix } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { z } from "zod";
import type {
  SandboxIdentity,
  SandboxOptions,
  SandboxProvider,
} from "./provider.ts";

const execFile = promisify(execFileCallback);
const MANAGED_LABEL = "kaeno.io/managed-work";
const ID_LABEL = "kaeno.io/work-id";
const IMAGE_LABEL = "kaeno.io/work-image";
const TOKEN_HASH_LABEL = "kaeno.io/token-sha256";
const ENV_PORT = 7070;
const inspectedContainerSchema = z.array(
  z.object({
    Config: z.object({
      Image: z.string(),
      Labels: z.record(z.string(), z.string()).nullable(),
    }),
    State: z.object({ Running: z.boolean() }),
    NetworkSettings: z.object({
      Ports: z
        .record(
          z.string(),
          z
            .array(z.object({ HostIp: z.string(), HostPort: z.string() }))
            .nullable(),
        )
        .optional(),
    }),
    Name: z.string(),
  }),
);

interface DockerContainer {
  name: string;
  image: string;
  running: boolean;
  labels: Record<string, string>;
  hostPort?: number;
}

/** Docker-specific process boundary; kept behind SandboxProvider. */
export interface DockerEngine {
  inspect(name: string): Promise<DockerContainer | undefined>;
  create(
    name: string,
    sandbox: SandboxIdentity,
    options: SandboxOptions,
  ): Promise<void>;
  start(name: string): Promise<void>;
  remove(name: string, volume: string): Promise<void>;
  managed(): Promise<DockerContainer[]>;
}

/** Thin Docker Engine CLI adapter. All arguments are passed without a shell. */
export class DockerCli implements DockerEngine {
  private readonly executable: string;
  constructor(executable = "docker") {
    this.executable = executable;
  }

  private async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFile(this.executable, args, {
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (error) {
      // execFile embeds argv in its error message; create's argv includes the envd bearer token.
      // Do not retain the original error as cause: standard error logging also renders causes.
      const detail = (
        error instanceof Error ? error.message : String(error)
      ).replace(/KAENO_ENV_TOKEN=\S+/g, "KAENO_ENV_TOKEN=[REDACTED]");
      throw new Error(`docker ${args[0]} failed: ${detail}`);
    }
  }

  async inspect(name: string): Promise<DockerContainer | undefined> {
    let output: string;
    try {
      output = await this.run(["inspect", name]);
    } catch (error) {
      if (
        error instanceof Error &&
        /No such (object|container)/i.test(error.message)
      ) {
        return undefined;
      }
      throw error;
    }
    const [raw] = inspectedContainerSchema.parse(JSON.parse(output));
    const published = raw.NetworkSettings.Ports?.[`${ENV_PORT}/tcp`]?.find(
      (port) => port.HostIp === "127.0.0.1" || port.HostIp === "::1",
    );
    return {
      name: raw.Name.replace(/^\//, ""),
      image: raw.Config.Image,
      running: raw.State.Running,
      labels: raw.Config.Labels ?? {},
      ...(published ? { hostPort: Number(published.HostPort) } : {}),
    };
  }

  async create(
    name: string,
    sandbox: SandboxIdentity,
    options: SandboxOptions,
  ): Promise<void> {
    await this.run([
      "create",
      "--name",
      name,
      "--label",
      `${MANAGED_LABEL}=true`,
      "--label",
      `${ID_LABEL}=${sandbox.id}`,
      "--label",
      `${IMAGE_LABEL}=${sandbox.image}`,
      "--label",
      `${TOKEN_HASH_LABEL}=${tokenHash(sandbox.token)}`,
      "--restart",
      "unless-stopped",
      "--init",
      "--publish",
      `127.0.0.1::${ENV_PORT}/tcp`,
      "--volume",
      `${volumeName(sandbox.id)}:/workspace`,
      "--env",
      `KAENO_ENV_TOKEN=${sandbox.token}`,
      "--env",
      "HOME=/home/agent",
      "--memory",
      String(options.limits.memoryBytes),
      "--cpus",
      String(options.limits.cpus),
      "--pids-limit",
      "256",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--tmpfs",
      "/home/agent:rw,noexec,nosuid,size=16m,uid=1000,gid=1000",
      sandbox.image,
      "node",
      "/app/src/host/envd.ts",
    ]);
  }

  async start(name: string): Promise<void> {
    await this.run(["start", name]);
  }

  async remove(name: string, volume: string): Promise<void> {
    try {
      await this.run(["rm", "--force", "--volumes", name]);
    } catch (error) {
      if (!(
        error instanceof Error &&
        /No such (object|container)/i.test(error.message)
      )) {
        throw error;
      }
    }
    try {
      await this.run(["volume", "rm", volume]);
    } catch (error) {
      if (!(error instanceof Error && /no such volume/i.test(error.message))) {
        throw error;
      }
    }
  }

  async managed(): Promise<DockerContainer[]> {
    const output = await this.run([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=${MANAGED_LABEL}=true`,
    ]);
    const ids = output.split(/\s+/).filter(Boolean);
    const containers = await Promise.all(ids.map((id) => this.inspect(id)));
    return containers.filter(
      (container): container is DockerContainer => container !== undefined,
    );
  }
}

/** Local Docker implementation of the provider contract used by work orchestration. */
export class DockerSandboxProvider implements SandboxProvider {
  private readonly engine: DockerEngine;
  private readonly fetch: typeof globalThis.fetch;
  private readonly apiHost: string;
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
    engine?: DockerEngine;
    fetch?: typeof globalThis.fetch;
    apiHost?: string;
    /** Stable owner namespace; separate applications sharing Docker must use distinct values. */
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
    this.engine = options.engine ?? new DockerCli();
    this.fetch = options.fetch ?? fetch;
    this.createEnvironment = options.createEnvironment;
    this.apiHost = options.apiHost ?? "127.0.0.1";
    this.namespace = z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/)
      .parse(options.namespace ?? "default");
    this.readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  }

  async ensure(
    sandbox: SandboxIdentity,
    options: SandboxOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    sandbox = this.scoped(sandbox);
    const name = containerName(sandbox.id);
    validateRequest(sandbox, options);
    let container = await this.engine.inspect(name);
    if (!container) {
      try {
        await this.engine.create(name, sandbox, options);
      } catch (error) {
        // Another retry/process may have won the deterministic-name create race.
        container = await this.engine.inspect(name);
        if (!container) {
          throw error;
        }
      }
      container ??= await this.engine.inspect(name);
    }
    if (
      !container ||
      container.labels[MANAGED_LABEL] !== "true" ||
      container.labels[ID_LABEL] !== sandbox.id ||
      container.labels[IMAGE_LABEL] !== sandbox.image ||
      container.labels[TOKEN_HASH_LABEL] !== tokenHash(sandbox.token)
    ) {
      throw new Error(`Docker sandbox identity mismatch for ${sandbox.id}`);
    }
    if (!container.running) {
      await this.engine.start(name);
    }
    await this.waitUntilReady(name, signal);
  }

  async executionEnvironment(
    sandbox: SandboxIdentity,
    cwd: string,
  ): Promise<ExecutionEnv> {
    sandbox = this.scoped(sandbox);
    return this.createEnvironment({
      url: `http://${this.apiHost}:${await this.portFor(sandbox.id)}`,
      token: sandbox.token,
      id: `docker:${sandbox.id}`,
      cwd,
      fetch: this.fetch,
    });
  }

  async remove(sandbox: SandboxIdentity): Promise<void> {
    sandbox = this.scoped(sandbox);
    await this.engine.remove(containerName(sandbox.id), volumeName(sandbox.id));
  }

  async reconcile(active: readonly SandboxIdentity[]): Promise<void> {
    const keep = new Set(active.map((sandbox) => this.scoped(sandbox).id));
    for (const container of await this.engine.managed()) {
      const id = container.labels[ID_LABEL];
      const owned =
        id?.startsWith(`${this.namespace}-`) ||
        (!id && container.name.startsWith(`kaeno-work-${this.namespace}-`));
      if (!owned) {
        continue;
      }
      if (!id || !keep.has(id)) {
        const nameId = container.name.startsWith("kaeno-work-")
          ? container.name.slice("kaeno-work-".length)
          : undefined;
        const removableId = id ?? nameId;
        if (!removableId) {
          throw new Error(
            `Managed container has no recoverable work id: ${container.name}`,
          );
        }
        await this.engine.remove(container.name, volumeName(removableId));
      }
    }
  }

  private scoped(sandbox: SandboxIdentity): SandboxIdentity {
    return { ...sandbox, id: `${this.namespace}-${sandbox.id}` };
  }

  private async portFor(id: string): Promise<number> {
    const container = await this.engine.inspect(containerName(id));
    if (!container?.running || container.hostPort === undefined) {
      throw new Error(
        `Docker sandbox ${id} is not running or has no published port`,
      );
    }
    return container.hostPort;
  }

  private async waitUntilReady(
    name: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const container = await this.engine.inspect(name);
      if (!container?.running) {
        throw new Error(`Docker sandbox ${name} exited before becoming ready`);
      }
      if (container.hostPort !== undefined) {
        try {
          const response = await this.fetch(
            `http://${this.apiHost}:${container.hostPort}/healthz`,
            {
              signal,
            },
          );
          if (response.ok) {
            return;
          }
        } catch (error) {
          lastError = error;
        }
      }
      await delay(250, signal);
    }
    throw new Error(`Docker sandbox ${name} did not become ready`, {
      cause: lastError,
    });
  }
}

function validateRequest(
  sandbox: SandboxIdentity,
  options: SandboxOptions,
): void {
  containerName(sandbox.id);
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
    options.limits.memoryBytes <= 0
  ) {
    throw new Error("Sandbox CPU and memory limits must be positive");
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function containerName(id: string): string {
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(id)) {
    throw new Error(`Invalid sandbox id: ${id}`);
  }
  return `kaeno-work-${id}`;
}

function volumeName(id: string): string {
  return `kaeno-workspace-${containerName(id).slice("kaeno-work-".length)}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
