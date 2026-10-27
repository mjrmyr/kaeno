import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { forgetEntry, saveEntry, MemoryStore } from "./index.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function file(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kaeno-memory-"));
  roots.push(root);
  return join(root, "kaeno.sqlite");
}

it("persists across reopening and writes nothing when a change throws", async () => {
  const path = await file();
  const first = new DatabaseSync(path);
  new MemoryStore(first).mutate((state) =>
    saveEntry(state, {
      id: "m1",
      kind: "memory",
      title: "Partner",
      text: "Mia",
      savedAt: 1,
    }),
  );
  first.close();

  const second = new DatabaseSync(path);
  const store = new MemoryStore(second);
  try {
    expect(() =>
      store.mutate((state) => {
        forgetEntry(state, "m1");
        throw new Error("change failed");
      }),
    ).toThrow("change failed");
    expect(store.read().entries).toEqual({
      m1: { kind: "memory", title: "Partner", text: "Mia", savedAt: 1 },
    });
  } finally {
    second.close();
  }
});

it("forgetting erases the text from the database files, not just from the index", async () => {
  const path = await file();
  const marker = "UNIQUE-FORGET-MARKER-7f3a";
  const database = new DatabaseSync(path);
  const store = new MemoryStore(database);
  store.mutate((state) =>
    saveEntry(state, {
      id: "m1",
      kind: "memory",
      title: "Secret",
      text: marker,
      savedAt: 1,
    }),
  );
  store.mutate((state) =>
    saveEntry(state, {
      id: "m2",
      kind: "preference",
      text: "keep me",
      savedAt: 2,
    }),
  );
  const before = await readFile(path);
  expect(before.includes(marker)).toBe(true);

  store.mutate((state) => forgetEntry(state, "m1"));
  database.close();

  const directory = join(path, "..");
  for (const name of await readdir(directory)) {
    expect((await readFile(join(directory, name))).includes(marker)).toBe(
      false,
    );
  }
  const reopened = new DatabaseSync(path);
  expect(Object.keys(new MemoryStore(reopened).read().entries)).toEqual(["m2"]);
  reopened.close();
});
