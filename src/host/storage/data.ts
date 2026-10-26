import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DataDirectory {
  /** pi-durable storage only: conversations, tasks, documents. */
  readonly durableFile: string;
  /** Kaeno's own state, outside durable history, for example owner memory. */
  readonly kaeno: DatabaseSync;
}

/**
 * Open the data directory. Before this layout, `kaeno.sqlite` was the pi-durable file; opening it
 * as Kaeno's store would leave pi-durable to start empty, so that layout fails startup instead.
 */
export async function openDataDirectory(
  directory: string,
): Promise<DataDirectory> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const durableFile = join(root, "durable.sqlite");
  const kaenoFile = join(root, "kaeno.sqlite");
  // Rollback journal, not WAL: deleted state must not linger in a WAL file until a checkpoint.
  const kaeno = new DatabaseSync(kaenoFile, { timeout: 5000 });
  const durableTables = kaeno
    .prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'durable_schema'",
    )
    .get();
  if (durableTables?.count !== 0) {
    kaeno.close();
    throw new Error(
      `${kaenoFile} holds pi-durable data from before the durable/kaeno split. Finish or cancel unfinished work, stop Kaeno, then rename kaeno.sqlite (and any kaeno.sqlite-wal/-shm files) to durable.sqlite.`,
    );
  }
  return { durableFile, kaeno };
}
