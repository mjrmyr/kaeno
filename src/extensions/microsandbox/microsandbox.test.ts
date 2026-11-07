import { expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MicrosandboxSandboxProvider, type SandboxEngine } from "./index.ts";
import type { SandboxIdentity, SandboxOptions } from "../execution/index.ts";

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
  "kaeno.io/namespace": "default",
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
  function describe(name: string, vm: FakeVm) {
    return {
      name,
      running: vm.running,
      labels: vm.labels,
      hostPort: 49152,
    };
  }
  return {
    target: "local-test-store",
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
    stop: vi.fn<SandboxEngine["stop"]>(async (name) => {
      const vm = vms.get(name);
      if (vm) {
        vm.running = false;
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

it.each([
  { "kaeno.io/token-sha256": "wrong" },
  { "kaeno.io/work-image": "other:image" },
  { "kaeno.io/namespace": "other" },
])(
  "refuses to adopt a VM whose persisted identity does not match (%j)",
  async (mismatch) => {
    const engine = engineStub();
    engine.vms.set("kaeno-work-default-work-42", {
      running: true,
      envd: true,
      labels: { ...labels, ...mismatch },
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
  },
);

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
    labels: {
      ...labels,
      "kaeno.io/namespace": "other",
      "kaeno.io/work-id": "other-work-43",
    },
  });
  engine.vms.set("kaeno-work-default-nested-work-43", {
    running: true,
    envd: true,
    labels: {
      ...labels,
      "kaeno.io/namespace": "default-nested",
      "kaeno.io/work-id": "default-nested-work-43",
    },
  });
  const provider = new MicrosandboxSandboxProvider({
    engine,
    createEnvironment: ({ cwd }) => new NodeExecutionEnv({ cwd }),
  });

  await provider.reconcile([sandbox]);

  expect(engine.remove).toHaveBeenCalledTimes(1);
  expect(engine.remove).toHaveBeenCalledWith("kaeno-work-default-work-43");
});

it("adopts the winner of a deterministic-name create race", async () => {
  const engine = engineStub();
  const create = engine.create.getMockImplementation();
  engine.create.mockImplementationOnce(async (...args) => {
    await create?.(...args);
    throw new Error("already exists");
  });
  const provider = new MicrosandboxSandboxProvider({
    engine,
    fetch: envdFetch(engine),
    createEnvironment: ({ cwd }) => new NodeExecutionEnv({ cwd }),
  });
  await provider.ensure(sandbox, options);
  expect(engine.create).toHaveBeenCalledTimes(1);
  expect(engine.launch).not.toHaveBeenCalled();
});

it("removes a VM safely more than once", async () => {
  const engine = engineStub();
  const provider = new MicrosandboxSandboxProvider({
    engine,
    fetch: envdFetch(engine),
    createEnvironment: ({ cwd }) => new NodeExecutionEnv({ cwd }),
  });
  await provider.ensure(sandbox, options);
  await provider.remove(sandbox);
  await provider.remove(sandbox);
  expect(engine.vms.size).toBe(0);
});

it("honors cancellation before touching the engine", async () => {
  const engine = engineStub();
  const provider = new MicrosandboxSandboxProvider({
    engine,
    createEnvironment: ({ cwd }) => new NodeExecutionEnv({ cwd }),
  });
  await expect(
    provider.ensure(
      sandbox,
      options,
      AbortSignal.abort(new Error("cancelled")),
    ),
  ).rejects.toThrow("cancelled");
  expect(engine.inspect).not.toHaveBeenCalled();
});

it("propagates cancellation while waiting for envd", async () => {
  const engine = engineStub();
  const controller = new AbortController();
  const provider = new MicrosandboxSandboxProvider({
    engine,
    readyTimeoutMs: 500,
    fetch: async () => {
      controller.abort(new Error("cancelled while waiting"));
      return new Response("not ready", { status: 503 });
    },
    createEnvironment: ({ cwd }) => new NodeExecutionEnv({ cwd }),
  });
  await expect(
    provider.ensure(sandbox, options, controller.signal),
  ).rejects.toThrow("cancelled while waiting");
});

it("bounds an unresponsive envd health request", async () => {
  const engine = engineStub();
  let timedOut = false;
  const provider = new MicrosandboxSandboxProvider({
    engine,
    readyTimeoutMs: 100,
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("Health probes must carry a deadline");
        }
        signal.addEventListener(
          "abort",
          () => {
            timedOut = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    createEnvironment: ({ cwd }) => new NodeExecutionEnv({ cwd }),
  });
  await expect(provider.ensure(sandbox, options)).rejects.toThrow(
    "did not become ready",
  );
  expect(timedOut).toBe(true);
});
