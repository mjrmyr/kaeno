import { createServer } from "node:net";
import { once } from "node:events";
import { z } from "zod";
import {
  Sandbox,
  SandboxNotFoundError,
  type SandboxHandle,
} from "microsandbox";
import type { SandboxIdentity, SandboxOptions } from "./provider.ts";
import {
  MANAGED_LABEL,
  type SandboxEngine,
  type WorkVm,
} from "./microsandbox.ts";

export const ENV_PORT = 7070;

/** Everything one WORK VM needs; shared by the local engine and the Kubernetes pod runner. */
export interface WorkVmSpec {
  name: string;
  /** OCI reference or a host directory used as the guest root filesystem. */
  image: string;
  token: string;
  cpus: number;
  memoryBytes: number;
  labels: Record<string, string>;
  /** Host address and port forwarded to envd inside the guest. */
  bind: string;
  hostPort: number;
  /** Detached VMs outlive this process; attached ones stop with it. */
  detached: boolean;
}

/**
 * Boots the VM and starts envd in it. microsandbox does not run the image CMD for SDK-created
 * sandboxes, so envd is a detached job; it inherits the sandbox env, including the token.
 */
export async function bootWorkVm(spec: WorkVmSpec): Promise<Sandbox> {
  const sandbox = await Sandbox.builder(spec.name)
    .image(spec.image)
    .cpus(Math.max(1, Math.ceil(spec.cpus)))
    .memory(Math.floor(spec.memoryBytes / 1024 / 1024))
    .detached(spec.detached)
    .user("1000")
    .workdir("/workspace")
    .envs({
      KAENO_ENV_TOKEN: spec.token,
      HOME: "/home/agent",
      TMPDIR: "/tmp",
    })
    .labels(spec.labels)
    .portBind(spec.bind, spec.hostPort, ENV_PORT)
    .create();
  await launchEnvd(sandbox);
  return sandbox;
}

async function launchEnvd(sandbox: Sandbox): Promise<void> {
  await sandbox.execDetachedWith("node", (options) =>
    options.args(["/app/src/host/envd.ts"]).cwd("/workspace").user("1000"),
  );
}

/** Local microsandbox adapter. All SDK calls stay in this file. */
export class MicrosandboxEngine implements SandboxEngine {
  async inspect(name: string): Promise<WorkVm | undefined> {
    const handle = await find(name);
    return handle && describe(handle);
  }

  async create(
    name: string,
    sandbox: SandboxIdentity,
    options: SandboxOptions,
    labels: Record<string, string>,
  ): Promise<void> {
    await bootWorkVm({
      name,
      image: sandbox.image,
      token: sandbox.token,
      cpus: options.limits.cpus,
      memoryBytes: options.limits.memoryBytes,
      labels,
      bind: "127.0.0.1",
      // The SDK cannot report an ephemeral port back, so pick one; config keeps it for adoption.
      hostPort: await freePort(),
      detached: true,
    });
  }

  async start(name: string): Promise<void> {
    await (await Sandbox.get(name)).startDetached();
  }

  async launch(name: string): Promise<void> {
    await launchEnvd(await (await Sandbox.get(name)).connect());
  }

  async remove(name: string): Promise<void> {
    const handle = await find(name);
    await handle?.destroy({ force: true });
  }

  async managed(): Promise<WorkVm[]> {
    const vms: WorkVm[] = [];
    let cursor: string | undefined;
    do {
      const page = await Sandbox.listWith((list) => {
        list.label(MANAGED_LABEL, "true");
        return cursor === undefined ? list : list.cursor(cursor);
      });
      vms.push(...page.sandboxes.map(describe));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return vms;
  }
}

async function find(name: string): Promise<SandboxHandle | undefined> {
  try {
    return await Sandbox.get(name);
  } catch (error) {
    if (error instanceof SandboxNotFoundError) {
      return undefined;
    }
    throw error;
  }
}

const configSchema = z.object({
  labels: z.record(z.string(), z.string()).nullish(),
  network: z
    .object({
      ports: z.array(z.object({ hostPort: z.number(), guestPort: z.number() })),
    })
    .nullish(),
});

function describe(handle: SandboxHandle): WorkVm {
  const config = configSchema.parse(handle.config());
  const published = config.network?.ports.find(
    (port) => port.guestPort === ENV_PORT,
  );
  return {
    name: handle.name,
    running: handle.status === "running",
    labels: config.labels ?? {},
    ...(published?.hostPort ? { hostPort: published.hostPort } : {}),
  };
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a sandbox port");
  }
  return address.port;
}
