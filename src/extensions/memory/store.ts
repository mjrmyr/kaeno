import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { MemoryEntry, MemoryState } from "./memory.ts";

const rowSchema = z.object({
  id: z.string(),
  kind: z.enum(["preference", "memory"]),
  title: z.string().nullable(),
  text: z.string(),
  saved_at: z.number(),
});

function entryOfRow(row: z.infer<typeof rowSchema>): MemoryEntry {
  return row.kind === "preference"
    ? { kind: "preference", text: row.text, savedAt: row.saved_at }
    : {
        kind: "memory",
        title: row.title ?? "",
        text: row.text,
        savedAt: row.saved_at,
      };
}

/**
 * Memory in Kaeno's own database, outside pi-durable's append-only history, so forgetting
 * really deletes. The connection must not use WAL: deleted text would linger in the WAL file
 * until a checkpoint. `secure_delete` overwrites freed pages.
 */
export class MemoryStore {
  private readonly database: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.database = database;
    database.exec("PRAGMA secure_delete = ON");
    database.exec(`CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('preference', 'memory')),
      title TEXT,
      text TEXT NOT NULL,
      saved_at INTEGER NOT NULL
    ) STRICT`);
  }

  read(): MemoryState {
    const entries: MemoryState["entries"] = {};
    for (const row of this.database
      .prepare("SELECT id, kind, title, text, saved_at FROM memory_entries")
      .all()) {
      const parsed = rowSchema.parse(row);
      entries[parsed.id] = entryOfRow(parsed);
    }
    return { entries };
  }

  /** Apply one pure change atomically; a throwing change writes nothing. */
  mutate<T>(change: (state: MemoryState) => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const before = this.read();
      const after = structuredClone(before);
      const result = change(after);
      const remove = this.database.prepare(
        "DELETE FROM memory_entries WHERE id = ?",
      );
      const upsert = this.database.prepare(
        "INSERT OR REPLACE INTO memory_entries (id, kind, title, text, saved_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const id of Object.keys(before.entries)) {
        if (!Object.hasOwn(after.entries, id)) {
          remove.run(id);
        }
      }
      for (const [id, entry] of Object.entries(after.entries)) {
        if (JSON.stringify(before.entries[id]) !== JSON.stringify(entry)) {
          upsert.run(
            id,
            entry.kind,
            entry.kind === "memory" ? entry.title : null,
            entry.text,
            entry.savedAt,
          );
        }
      }
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
