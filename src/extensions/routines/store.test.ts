import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { routineInputSchema, RoutineStore } from "./index.ts";

const input = routineInputSchema.parse({
  name: "PR check",
  agent: "local:worker",
  instructions: "Check PRs",
  schedule: { every: 60 },
});

it("records each scheduled slot once and keeps manual runs out of the schedule", () => {
  const store = new RoutineStore(new DatabaseSync(":memory:"));
  const { id } = store.create(input, 1);
  expect(store.lastScheduledSlot(id)).toBeUndefined();

  store.recordRun({ routineId: id, slot: 100, workId: 7, startedAt: 101 });
  store.recordRun({ routineId: id, slot: 100, workId: 8, startedAt: 102 });
  expect(store.lastRun(id)).toEqual({
    routineId: id,
    slot: 100,
    workId: 7,
    startedAt: 101,
  });

  store.recordRun({ routineId: id, slot: null, workId: 9, startedAt: 200 });
  store.recordRun({ routineId: id, slot: null, workId: 10, startedAt: 201 });
  expect(store.lastRun(id)?.workId).toBe(10);
  expect(store.lastScheduledSlot(id)).toBe(100);
});

it("round-trips routines, applies defaults, and deletes a routine with its runs", () => {
  const store = new RoutineStore(new DatabaseSync(":memory:"));
  const created = store.create(input, 1);
  expect(store.get(created.id)).toEqual({
    ...input,
    id: created.id,
    thread: "routines",
    timeoutMinutes: 60,
    enabled: true,
    updatedAt: 1,
  });
  expect(
    store.replace(
      created.id,
      { ...input, enabled: false, schedule: { at: "08:00", timeZone: "UTC" } },
      2,
    ),
  ).toBe(true);
  expect(store.get(created.id)).toMatchObject({
    enabled: false,
    schedule: { at: "08:00", timeZone: "UTC" },
    updatedAt: 2,
  });
  store.recordRun({
    routineId: created.id,
    slot: 5,
    workId: 1,
    startedAt: 5,
  });
  expect(store.remove(created.id)).toBe(true);
  expect(store.remove(created.id)).toBe(false);
  expect(store.lastRun(created.id)).toBeUndefined();
  expect(store.list()).toEqual([]);
});

it("keeps the first proposal under an ID and decides only pending changes", () => {
  const store = new RoutineStore(new DatabaseSync(":memory:"));
  const first = store.propose("c1", { action: "create", input }, 1);
  const replayed = store.propose(
    "c1",
    { action: "delete", routineId: 9, baseUpdatedAt: 1 },
    2,
  );
  expect(replayed).toEqual(first);
  expect(first).toMatchObject({
    id: "c1",
    action: "create",
    status: "pending",
  });

  store.decide("c1", "rejected", 3);
  store.decide("c1", "approved", 4, 7);
  expect(store.change("c1")).toMatchObject({
    status: "rejected",
    decidedAt: 3,
  });
  expect(store.change("c1")?.result).toBeUndefined();
  expect(store.changes("pending")).toEqual([]);
});

it("rolls back everything a failed transaction wrote, including nested calls", () => {
  const store = new RoutineStore(new DatabaseSync(":memory:"));
  expect(() =>
    store.transaction(() => {
      store.create(input, 1);
      store.transaction(() =>
        store.propose("c1", { action: "create", input }, 1),
      );
      throw new Error("apply failed");
    }),
  ).toThrow("apply failed");
  expect(store.list()).toEqual([]);
  expect(store.changes()).toEqual([]);
});
