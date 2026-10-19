import { expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MicrosandboxSandboxProvider, type SandboxEngine } from "./index.ts";
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

interface FakeVm {
  running: boolean;
  envd: boolean;
  labels: Record<string, string>;
}

function engineStub(): SandboxEngine & {
  vms: Map<string, FakeVm>;
  create: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  launch: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  const vms = new Map<string, FakeVm>();
  const describe = (name: string, vm: FakeVm) => ({
    name,
    running: vm.running,
    labels: vm.labels,
    hostPort: 49152,
  });
  return {
    vms,
    inspect: vi.fn<SandboxEngine["inspect"]>(async (name) => {
      const vm = vms.get(name);
      return vm && describe(name, vm);
    }),
    create: vi.fn<SandboxEngine["create"]>(
      async (name, identity, _options, vmLabels) => {
        expect(identity).toEqual({ ...sandbox, id: `default-${sandbox.id}` });
        vms.set(name, { running: true, envd: true, labels: vmLabels });
      },
    ),
    start: vi.fn<SandboxEngine["start"]>(async (name) => {
      const vm = vms.get(name);
      if (vm) {
        vm.running = true;
      }
    }),
    launch: vi.fn<SandboxEngine["launch"]>(async (name) => {
      const vm = vms.get(name);
      if (vm) {
        vm.envd = true;
      }
    }),
    remove: vi.fn<SandboxEngine["remove"]>(async (name) => {
      vms.delete(name);
    }),
    managed: vi.fn<SandboxEngine["managed"]>(async () =>
      [...vms].map(([name, vm]) => describe(name, vm)),
    ),
  };
}

/** envd answers only while its fake VM runs it. */
function envdFetch(engine: ReturnType<typeof engineStub>) {
  return vi.fn<typeof fetch>(async () =>
    [...engine.vms.values()].some((vm) => vm.running && vm.envd)
      ? new Response("ok", { status: 200 })
      : Promise.reject(new TypeError("fetch failed")),
  );
}

it("creates a managed VM idempotently and connects to its published port", async () => {
  const engine = engineStub();
  let executionUrl: string | undefined;
  const provider = new MicrosandboxSandboxProvider({
    engine,
    fetch: envdFetch(engine),
    readyTimeoutMs: 500,
    createEnvironment: ({ cwd, url }) => {
      executionUrl = url;
      return new NodeExecutionEnv({ cwd });
    },
  });

  await provider.ensure(sandbox, options);
  await provider.ensure(sandbox, options);

  expect(engine.create).toHaveBeenCalledTimes(1);
  expect(engine.create.mock.calls[0]?.[3]).toEqual(labels);
  expect(engine.start).not.toHaveBeenCalled();
  expect(engine.launch).not.toHaveBeenCalled();
  await expect(
    provider.executionEnvironment(sandbox, options.cwd),
  ).resolves.toBeDefined();
  expect(executionUrl).toBe("http://127.0.0.1:49152");
});

it("boots a stopped VM and relaunches envd, which does not survive a stop", async () => {
  const engine = engineStub();
  engine.vms.set("kaeno-work-default-work-42", {
    running: false,
    envd: false,
    labels,
  });
  const provider = new MicrosandboxSandboxProvider({
    engine,
    fetch: envdFetch(engine),
    readyTimeoutMs: 500,
    createEnvironment: ({ cwd }) => new NodeExecutionEnv({ cwd }),
  });

  await provider.ensure(sandbox, options);

  expect(engine.start).toHaveBeenCalledTimes(1);
  expect(engine.launch).toHaveBeenCalledTimes(1);
});

it("relaunches envd in a running VM whose envd died", async () => {
  const engine = engineStub();
  engine.vms.set("kaeno-work-default-work-42", {
    running: true,
    envd: false,
    labels,
  });
  const provider = new MicrosandboxSandboxProvider({
    engine,
    fetch: envdFetch(engine),
    readyTimeoutMs: 500,
    createEnvironment: ({ cwd }) => new NodeExecutionEnv({ cwd }),
  });

  await provider.ensure(sandbox, options);

  expect(engine.start).not.toHaveBeenCalled();
  expect(engine.launch).toHaveBeenCalledTimes(1);
});

it("refuses to adopt a VM whose persisted identity does not match", async () => {
  const engine = engineStub();
  engine.vms.set("kaeno-work-default-work-42", {
    running: true,
    envd: true,
    labels: { ...labels, "kaeno.io/token-sha256": "wrong" },
  });
  const provider = new MicrosandboxSandboxProvider({
    engine,
    createEnvironment: ({ cwd }) => new NodeExecutionEnv({ cwd }),
  });
  await expect(provider.ensure(sandbox, options)).rejects.toThrow(
    "microsandbox identity mismatch",
  );
  expect(engine.start).not.toHaveBeenCalled();
  expect(engine.launch).not.toHaveBeenCalled();
});

it("removes stale managed VMs but preserves active work and other namespaces", async () => {
  const engine = engineStub();
  engine.vms.set("kaeno-work-default-work-42", {
    running: true,
    envd: true,
    labels,
  });
  engine.vms.set("kaeno-work-default-work-43", {
    running: true,
    envd: true,
    labels: { ...labels, "kaeno.io/work-id": "default-work-43" },
  });
  engine.vms.set("kaeno-work-other-work-43", {
    running: true,
    envd: true,
    labels: { ...labels, "kaeno.io/work-id": "other-work-43" },
  });
  const provider = new MicrosandboxSandboxProvider({
    engine,
    createEnvironment: ({ cwd }) => new NodeExecutionEnv({ cwd }),
  });

  await provider.reconcile([sandbox]);

  expect(engine.remove).toHaveBeenCalledTimes(1);
  expect(engine.remove).toHaveBeenCalledWith("kaeno-work-default-work-43");
});
