import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import {
  ApiServer,
  type MemoryAccess,
  type RoutineAccess,
} from "../../src/channels/api/index.ts";
import { openKaeno } from "../../src/core/application/index.ts";

it("serves host-supplied capabilities without extension implementations", async () => {
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models: createModels(),
    assistant: {
      model: { provider: "faux", modelId: "faux-1" },
      instructions: "Assist",
    },
    extensions: [],
  });
  const memory: MemoryAccess = {
    list: () => ({ preferences: [], memories: [] }),
    get: () => undefined,
    update: vi.fn<MemoryAccess["update"]>(() => true),
    remove: () => false,
  };
  const routines: RoutineAccess = {
    describe: async () => [],
    create: () => {
      throw new Error("Invalid routine");
    },
    replace: vi.fn<RoutineAccess["replace"]>(() => true),
    remove: () => false,
    changes: () => [],
    approve: () => {
      throw new Error("No change");
    },
    reject: () => {
      throw new Error("No change");
    },
    runNow: vi.fn<RoutineAccess["runNow"]>(async () => "k1"),
  };
  const api = new ApiServer(core, "test-token", { memory, routines }).server;
  const headers = { authorization: "Bearer test-token" };
  try {
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const address = api.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP listener");
    }
    const base = `http://127.0.0.1:${address.port}/v1`;
    expect(await (await fetch(`${base}/memory`, { headers })).json()).toEqual({
      preferences: [],
      memories: [],
    });
    expect((await fetch(`${base}/memory/m1`, { headers })).status).toBe(404);
    expect(
      (
        await fetch(`${base}/memory/m1`, {
          headers,
          method: "PUT",
          body: '{"text":"Hello"}',
        })
      ).status,
    ).toBe(200);
    expect(memory.update).toHaveBeenCalledWith("m1", { text: "Hello" });
    expect(
      (
        await fetch(`${base}/memory/m1`, {
          headers,
          method: "PUT",
          body: '{"text":42}',
        })
      ).status,
    ).toBe(400);
    expect(memory.update).toHaveBeenCalledTimes(1);
    expect(await (await fetch(`${base}/routines`, { headers })).json()).toEqual(
      [],
    );
    expect(
      (
        await fetch(`${base}/routines/1`, {
          headers,
          method: "PUT",
          body: '{"name":"Daily"}',
        })
      ).status,
    ).toBe(200);
    expect(routines.replace).toHaveBeenCalledWith(1, { name: "Daily" });
    expect(
      await (
        await fetch(`${base}/routines/1/run`, { headers, method: "POST" })
      ).json(),
    ).toEqual({ workId: "k1" });
    expect(routines.runNow).toHaveBeenCalledWith(1);
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await core.close();
  }
});
