import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DataDirectory {
  /** pi-durable storage only: conversations, tasks, documents. */
  readonly durableFile: string;
  /** Kaeno's own state, outside durable history, for example owner memory. */
  readonly kaeno: DatabaseSync;
}

export async function openDataDirectory(
  directory: string,
): Promise<DataDirectory> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  return {
    durableFile: join(root, "durable.sqlite"),
    // Rollback journal, not WAL: deleted state must not linger in a WAL file until a checkpoint.
    kaeno: new DatabaseSync(join(root, "kaeno.sqlite"), { timeout: 5000 }),
  };
}
