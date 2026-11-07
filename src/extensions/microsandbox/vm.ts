import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { z } from "zod";
import type { Sandbox, SandboxHandle } from "microsandbox";
import type { SandboxIdentity, SandboxOptions } from "../execution/index.ts";
import {
  MANAGED_LABEL,
  type SandboxEngine,
  type WorkVm,
} from "./microsandbox.ts";

const ENV_PORT = 7070;

async function launchEnvd(sandbox: Sandbox): Promise<void> {
  await sandbox.execDetachedWith("node", (options) =>
    options.args(["/app/src/host/envd.ts"]).cwd("/workspace").user("1000"),
  );
}

/** Local microsandbox adapter. All SDK calls stay in this file. */
export class MicrosandboxEngine implements SandboxEngine {
  readonly target = resolve(
    process.env.MSB_HOME ?? join(homedir(), ".microsandbox"),
  );
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
    const { Sandbox } = await import("microsandbox");
    const vm = await Sandbox.builder(name)
      .image(sandbox.image)
      .cpus(Math.ceil(options.limits.cpus))
      .memory(Math.floor(options.limits.memoryBytes / 1024 / 1024))
      .detached(true)
      .user("1000")
      .workdir("/workspace")
      .envs({
        KAENO_ENV_TOKEN: sandbox.token,
        HOME: "/home/agent",
        TMPDIR: "/tmp",
      })
      .labels(labels)
      // The SDK cannot report an ephemeral port back; config keeps this port for adoption.
      .portBind("127.0.0.1", await freePort(), ENV_PORT)
      .create();
    // SDK-created VMs do not run the image CMD. The detached job inherits the token.
    await launchEnvd(vm);
  }

  async start(name: string): Promise<void> {
    const { Sandbox } = await import("microsandbox");
    await (await Sandbox.get(name)).startDetached();
  }

  async launch(name: string): Promise<void> {
    const { Sandbox } = await import("microsandbox");
    await launchEnvd(await (await Sandbox.get(name)).connect());
  }

  async stop(name: string): Promise<void> {
    const handle = await find(name);
    if (handle?.status === "running") {
      await handle.stop();
    }
  }

  async remove(name: string): Promise<void> {
    const handle = await find(name);
    await handle?.destroy({ force: true });
  }

  async managed(): Promise<WorkVm[]> {
    const { Sandbox } = await import("microsandbox");
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
  const { Sandbox, SandboxNotFoundError } = await import("microsandbox");
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
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a sandbox port");
  }
  return address.port;
}
