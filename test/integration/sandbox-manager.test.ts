import {
  BACKGROUND_CONTEXT as ctx,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  KubernetesClient,
  SandboxCapacity,
  SandboxManager,
  SandboxSlots,
  type SandboxLaunch,
} from "../../src/sandboxes/index.ts";
import * as cluster from "./sandbox-fixture.ts";
import { SANDBOX_RESOURCES } from "./values.ts";

// Controlled waits: no wall-clock sleeps or Kubernetes traffic. The abort test
// keeps one wait pending and explicitly delivers its AbortSignal rejection.
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn<typeof delay>() }));
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close(ctx);
  }
  cluster.resetCluster();
});

async function fixture() {
  vi.mocked(delay).mockResolvedValue(undefined);
  cluster.resetCluster();
  cluster.setSandboxQuota({ pods: "1" });
  const Hold = defineTask<null, { phase: "hold" }, null>({
    name: "quota-holder",
    version: 1,
    initial: () => ({ phase: "hold" }),
    phases: { hold: async () => {} },
    abort: async () => {},
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "quota-test", tasks: [Hold] }));
  const harness = await Harness.open(
    new MemoryStorage(),
    { registry, models: createModels() },
    ctx,
  );
  harnesses.push(harness);
  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" } },
    ctx,
  );
  const taskId = await harness.commit(
    (tx) =>
      tx.createTask(Hold, null, {
        ownership: { kind: "conversation" },
        conversationId: conversation.id,
        background: true,
      }),
    ctx,
  );
  // Exercise the real KubernetesClient's status/body-to-Error boundary, with
  // fetch replaced completely. Its error includes the truncated K8s Status JSON.
  const post = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.method).toBe("POST");
    await cluster.createPod(JSON.parse(String(init?.body)));
    return new Response(null, { status: 201 });
  });
  const transport = new KubernetesClient(
    "kaeno",
    post,
    async () => "fake-token",
  );
  const client = {
    ...cluster,
    createPod: (pod: unknown) => transport.createPod(pod),
  };
  const capacity = new SandboxCapacity(
    () => harness,
    client,
    SANDBOX_RESOURCES,
  );
  const acquire = vi.spyOn(capacity, "acquireSandbox");
  const release = vi.spyOn(capacity, "releaseSandbox");
  // Count actual held -> absent transitions, not repeated idempotent cleanup calls.
  let releasedReservations = 0;
  release.mockImplementation(async (pod) => {
    const before = await capacity.listReservations();
    const result = await SandboxCapacity.prototype.releaseSandbox.call(
      capacity,
      pod,
    );
    const after = await capacity.listReservations();
    releasedReservations += before.length - after.length;
    return result;
  });
  const manager = new SandboxManager(() => harness, client, capacity, {
    createEnvironment: () => {
      throw new Error("No execution in this fixture");
    },
    createCaptureEnvironment: () => {
      throw new Error("No capture in this fixture");
    },
  });
  const launch: SandboxLaunch = {
    sandbox: {
      pod: "quota-pod",
      token: "sensitive-env-token",
      images: { execution: "test-image" },
      skillCacheClaim: "test-cache",
    },
    selection: [],
    conversationId: String(conversation.id),
    taskId,
    template: "worker",
  };
  return {
    manager,
    capacity,
    acquire,
    release,
    post,
    launch,
    harness,
    releasedReservations: () => releasedReservations,
  };
}

function quotaResponse(): Response {
  return new Response(
    JSON.stringify({
      kind: "Status",
      apiVersion: "v1",
      status: "Failure",
      message:
        'pods "quota-pod" is forbidden: exceeded quota: kaeno-sandbox, requested: pods=1, used: pods=1, limited: pods=1',
      reason: "Forbidden",
      code: 403,
    }),
    { status: 403 },
  );
}

it("bounds persistent quota rejection at five POSTs/four waits and releases one durable reservation", async () => {
  const rig = await fixture();
  rig.post.mockImplementation(async () => {
    // Safety fuse: a regression must fail, not spin forever in mocked time.
    if (rig.post.mock.calls.length > 5) {
      throw new Error("Unexpected sixth quota create attempt");
    }
    return quotaResponse();
  });
  const outcome = rig.manager.ensureSandbox(rig.launch, ctx);
  await expect(outcome).rejects.toThrow(/quota.*5 attempts/i);
  expect(rig.post).toHaveBeenCalledTimes(5);
  expect(delay).toHaveBeenCalledTimes(4);
  for (const call of vi.mocked(delay).mock.calls) {
    expect(call).toEqual([1000, undefined, { signal: ctx.abortSignal }]);
  }
  expect(rig.acquire).toHaveBeenCalledExactlyOnceWith(
    rig.launch.taskId,
    "quota-pod",
    ctx,
  );
  expect(rig.release).toHaveBeenCalledExactlyOnceWith("quota-pod");
  expect(await rig.capacity.listReservations()).toEqual([]);
  expect(await rig.harness.snapshot(SandboxSlots, ctx)).toEqual({
    waiting: [],
    held: {},
  });
  expect(rig.releasedReservations()).toBe(1);
  // WORK's report/abort cleanup may run later. There is no second reservation
  // release (and no negative capacity accounting) when it sees an absent pod.
  await rig.manager.removeSandbox("quota-pod");
  await rig.manager.removeSandbox("quota-pod");
  expect(rig.releasedReservations()).toBe(1);
  expect(await rig.capacity.listReservations()).toEqual([]);
});

it.each([2, 4])(
  "recovers after %i quota errors without re-acquiring or prematurely releasing capacity",
  async (failures) => {
    const rig = await fixture();
    for (let failure = 0; failure < failures; failure++) {
      rig.post.mockImplementationOnce(async () => quotaResponse());
    }
    await rig.manager.ensureSandbox(rig.launch, ctx);
    expect(rig.post).toHaveBeenCalledTimes(failures + 1);
    expect(delay).toHaveBeenCalledTimes(failures);
    expect(rig.acquire).toHaveBeenCalledTimes(1);
    expect(rig.release).not.toHaveBeenCalled();
    expect(await rig.capacity.listReservations()).toEqual([
      { id: rig.launch.taskId, pod: "quota-pod" },
    ]);
    await rig.manager.removeSandbox("quota-pod");
    expect(rig.release).toHaveBeenCalledTimes(1);
    expect(rig.releasedReservations()).toBe(1);
    expect(await rig.capacity.listReservations()).toEqual([]);
  },
);

it("aborts a pending quota backoff promptly and releases capacity even with an aborted context", async () => {
  const rig = await fixture();
  const stop = new AbortController();
  const context = withAbortSignal(stop.signal, ctx);
  rig.post.mockImplementation(async () => quotaResponse());
  let waiting!: () => void;
  const enteredWait = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  vi.mocked(delay).mockImplementationOnce(
    (_ms, _value, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () =>
            reject(new DOMException("The operation was aborted", "AbortError")),
          { once: true },
        );
        waiting();
      }),
  );
  const outcome = rig.manager.ensureSandbox(rig.launch, context);
  const rejected = outcome.then(
    () => {
      throw new Error("Expected quota wait to abort");
    },
    (error: unknown) => error,
  );
  await enteredWait;
  expect(await rig.capacity.listReservations()).toHaveLength(1);
  stop.abort();
  // No clock advance or release of the controlled wait needed.
  expect(await rejected).toMatchObject({ name: "AbortError" });
  expect(rig.post).toHaveBeenCalledTimes(1);
  expect(delay).toHaveBeenCalledExactlyOnceWith(1000, undefined, {
    signal: stop.signal,
  });
  expect(rig.acquire).toHaveBeenCalledTimes(1);
  expect(rig.release).toHaveBeenCalledTimes(1);
  expect(rig.releasedReservations()).toBe(1);
  expect(await rig.capacity.listReservations()).toEqual([]);
  await rig.manager.removeSandbox("quota-pod");
  expect(rig.releasedReservations()).toBe(1);
});

it.each([400, 403, 422, 500, 503])(
  "does not retry a non-quota HTTP %i and leaves existing WORK cleanup behavior intact",
  async (status) => {
    const rig = await fixture();
    rig.post.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            kind: "Status",
            message: "denied by admission",
            code: status,
          }),
          { status },
        ),
    );
    await expect(rig.manager.ensureSandbox(rig.launch, ctx)).rejects.toThrow(
      `→ ${status}:`,
    );
    expect(rig.post).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    expect(rig.acquire).toHaveBeenCalledTimes(1);
    expect(rig.release).not.toHaveBeenCalled();
    await rig.manager.removeSandbox("quota-pod");
    expect(rig.release).toHaveBeenCalledTimes(1);
    expect(rig.releasedReservations()).toBe(1);
    expect(await rig.capacity.listReservations()).toEqual([]);
  },
);
