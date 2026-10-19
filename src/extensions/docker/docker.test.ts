import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  DockerCli,
  DockerSandboxProvider,
  type DockerEngine,
} from "./index.ts";
import type { SandboxIdentity, SandboxOptions } from "./provider.ts";

const sandbox: SandboxIdentity = {
  id: "work-42",
  token: "a".repeat(48),
  image: "kaeno-execution:test",
};
const options: SandboxOptions = {
  cwd: "/workspace",
  limits: { cpus: 1, memoryBytes: 512 * 1024 * 1024 },
};
const labels = {
  "kaeno.io/managed-work": "true",
  "kaeno.io/work-id": `default-${sandbox.id}`,
  "kaeno.io/work-image": sandbox.image,
  "kaeno.io/token-sha256":
    "97daac0ee9998dfcad6c9c0970da5ca411c86233a944c25b47566f6a7bc1ddd5",
};

function engineStub(): DockerEngine & {
  containers: Map<string, { running: boolean; labels: Record<string, string> }>;
  create: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  const containers = new Map<
    string,
    { running: boolean; labels: Record<string, string> }
  >();
  return {
    containers,
    inspect: vi.fn<DockerEngine["inspect"]>(async (name) => {
      const container = containers.get(name);
      return container
        ? {
            name,
            image: sandbox.image,
            running: container.running,
            labels: container.labels,
            hostPort: 49152,
          }
        : undefined;
    }),
    create: vi.fn<DockerEngine["create"]>(async (name, identity) => {
      containers.set(name, { running: false, labels });
      expect(identity).toEqual({ ...sandbox, id: `default-${sandbox.id}` });
    }),
    start: vi.fn<DockerEngine["start"]>(async (name) => {
      const container = containers.get(name);
      if (container) {
        container.running = true;
      }
    }),
    remove: vi.fn<DockerEngine["remove"]>(async (name) => {
      containers.delete(name);
    }),
    managed: vi.fn<DockerEngine["managed"]>(async () =>
      [...containers].map(([name, container]) => ({
        name,
        image: sandbox.image,
        running: container.running,
        labels: container.labels,
        hostPort: 49152,
      })),
    ),
  };
}

it("creates and starts a managed sandbox idempotently", async () => {
  const engine = engineStub();
  let executionUrl: string | undefined;
  const provider = new DockerSandboxProvider({
    engine,
    fetch: vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 })),
    readyTimeoutMs: 500,
    createEnvironment: ({ cwd, url }) => {
      executionUrl = url;
      return new NodeExecutionEnv({ cwd });
    },
  });

  await provider.ensure(sandbox, options);
  await provider.ensure(sandbox, options);

  expect(engine.create).toHaveBeenCalledTimes(1);
  expect(engine.start).toHaveBeenCalledTimes(1);
  await expect(
    provider.executionEnvironment(sandbox, options.cwd),
  ).resolves.toBeDefined();
  expect(executionUrl).toBe("http://127.0.0.1:49152");
});

it("refuses to adopt a container whose persisted identity does not match", async () => {
  const engine = engineStub();
  engine.containers.set("kaeno-work-default-work-42", {
    running: true,
    labels: { ...labels, "kaeno.io/token-sha256": "wrong" },
  });
  const provider = new DockerSandboxProvider({
    engine,
    createEnvironment: ({ cwd }) => new NodeExecutionEnv({ cwd }),
  });
  await expect(provider.ensure(sandbox, options)).rejects.toThrow(
    "Docker sandbox identity mismatch",
  );
  expect(engine.start).not.toHaveBeenCalled();
});

it("removes stale managed containers but preserves active work", async () => {
  const engine = engineStub();
  engine.containers.set("kaeno-work-default-work-42", {
    running: true,
    labels,
  });
  engine.containers.set("kaeno-work-default-work-43", {
    running: true,
    labels: { ...labels, "kaeno.io/work-id": "default-work-43" },
  });
  engine.containers.set("kaeno-work-other-work-43", {
    running: true,
    labels: { ...labels, "kaeno.io/work-id": "other-work-43" },
  });
  const provider = new DockerSandboxProvider({
    engine,
    createEnvironment: ({ cwd }) => new NodeExecutionEnv({ cwd }),
  });

  await provider.reconcile([sandbox]);

  expect(engine.remove).toHaveBeenCalledTimes(1);
  expect(engine.remove).toHaveBeenCalledWith(
    "kaeno-work-default-work-43",
    "kaeno-workspace-default-work-43",
  );
});

it("redacts sandbox bearer tokens from CLI errors, including rendered causes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-docker-cli-error-"));
  try {
    const executable = join(directory, "docker-failure");
    await writeFile(
      executable,
      `#!${process.execPath}
console.error(process.argv.join(" ")); process.exit(1);
`,
      { mode: 0o700 },
    );
    const cli = new DockerCli(executable);
    let rendered = "";
    try {
      await cli.create("test", sandbox, options);
      throw new Error("Expected fake Docker to fail");
    } catch (error) {
      rendered = inspect(error, { depth: 10 });
    }
    expect(rendered).toContain("docker create failed");
    expect(rendered).toContain("KAENO_ENV_TOKEN=[REDACTED]");
    expect(rendered).not.toContain(sandbox.token);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
