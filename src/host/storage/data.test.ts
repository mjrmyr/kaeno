import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { openDataDirectory } from "./index.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kaeno-data-"));
  roots.push(root);
  return root;
}

it("separates pi-durable storage from Kaeno's own database", async () => {
  const root = await directory();
  const data = await openDataDirectory(join(root, "nested"));
  try {
    expect(data.durableFile).toBe(join(root, "nested", "durable.sqlite"));
    expect(
      data.kaeno.prepare("PRAGMA journal_mode").get()?.journal_mode,
    ).not.toBe("wal");
  } finally {
    data.kaeno.close();
  }
});

it("refuses a kaeno.sqlite that still holds pi-durable data", async () => {
  const root = await directory();
  const legacy = new DatabaseSync(join(root, "kaeno.sqlite"));
  legacy.exec("CREATE TABLE durable_schema (version INTEGER)");
  legacy.close();
  await expect(openDataDirectory(root)).rejects.toThrow(
    "rename kaeno.sqlite (and any kaeno.sqlite-wal/-shm files) to durable.sqlite",
  );
});
