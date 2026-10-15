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
import { expect, it, vi } from "vitest";
import { SandboxSlots, type Pod } from "../../src/sandboxes/index.ts";
import { sandboxSlots } from "./composition.ts";
import * as k8s from "./sandbox-fixture.ts";
import { required } from "./values.ts";
it("admits four workers, preserves leases across allocator recreation, and releases only after confirmed pod removal", async () => {
  const pods = new Map<string, Pod>();
  vi.spyOn(k8s, "getPod").mockImplementation(async (name) => pods.get(name));
  vi.spyOn(k8s, "listSandboxPods").mockImplementation(async () => [
    ...pods.values(),
  ]);
  vi.spyOn(k8s, "deletePod").mockImplementation(async (name) => {
    pods.delete(name);
  });
  const Hold = defineTask<
    null,
    {
      phase: "hold";
    },
    null
  >({
    name: "hold",
    version: 1,
    initial: () => ({ phase: "hold" }),
    phases: {
      hold: async (_task, runtime, context) => {
        await runtime.sleep(runtime.now() + 60000, context);
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      ),
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "holder", tasks: [Hold] }));
  const harness = await Harness.open(
    new MemoryStorage(),
    { registry, models: createModels() },
    ctx,
  );
  const root = await harness.createConversation(
    { ownership: { kind: "ownerless" } },
    ctx,
  );
  const ids = await harness.commit(async (tx) => {
    const ids = [];
    for (let index = 0; index < 6; index++) {
      ids.push(
        await tx.createTask(Hold, null, {
          ownership: { kind: "conversation" },
          conversationId: root.id,
          background: true,
        }),
      );
    }
    return ids;
  }, ctx);
  try {
    let slots = sandboxSlots(() => harness);
    for (let index = 0; index < 4; index++) {
      await slots.acquireSandbox(required(ids[index]), `pod-${index}`, ctx);
      pods.set(`pod-${index}`, { metadata: { name: `pod-${index}` } });
    }
    slots = sandboxSlots(() => harness); // fresh process's allocator sees the same durable reservations
    let fifth = false;
    const pending = slots
      .acquireSandbox(required(ids[4]), "pod-4", ctx)
      .then(() => {
        fifth = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fifth).toBe(false);
    expect(
      Object.keys(required(await harness.snapshot(SandboxSlots, ctx)).held),
    ).toHaveLength(4);
    expect(await slots.releaseSandbox("pod-0")).toBe(false); // delete request/terminal task alone isn't a release
    pods.delete("pod-0");
    expect(await slots.releaseSandbox("pod-0")).toBe(true);
    await pending;
    expect(fifth).toBe(true);
    pods.set("pod-4", { metadata: { name: "pod-4" } });
    expect(
      Object.keys(required(await harness.snapshot(SandboxSlots, ctx)).held),
    ).toHaveLength(4);
    const stop = new AbortController();
    const queued = slots.acquireSandbox(
      required(ids[5]),
      "pod-5",
      withAbortSignal(stop.signal, ctx),
    );
    const rejected = queued.then(
      () => {
        throw new Error("Expected cancelled acquisition");
      },
      (error) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort();
    expect(await rejected).toBeInstanceOf(Error);
    // A cancelled queued task is reconciled without allocating a pod or leaking its place in FIFO.
    await harness.abortTask(required(ids[5]), ctx);
    harness.resume();
    await harness.waitForTask(required(ids[5]), ctx);
    await slots.reconcileReservations();
    expect(required(await harness.snapshot(SandboxSlots, ctx)).waiting).toEqual(
      [],
    );
    const overflow = await harness.commit(async (tx) => {
      const state = await tx.doc(SandboxSlots);
      const ids = [];
      for (let index = 0; index < 129; index++) {
        ids.push(
          await tx.createTask(Hold, null, {
            ownership: { kind: "conversation" },
            conversationId: root.id,
            background: true,
          }),
        );
      }
      state.waiting = ids
        .slice(0, 128)
        .map((id, index) => ({ id, pod: `queued-${index}` }));
      return required(ids[128]);
    }, ctx);
    await expect(
      slots.acquireSandbox(overflow, "overflow", ctx),
    ).rejects.toThrow("128 pending works");
  } finally {
    await harness.close(ctx);
    vi.restoreAllMocks();
  }
});
