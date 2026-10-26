import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { scheduleSchema } from "./schedule.ts";

/** What the owner writes. Kaeno itself can list routines but never create or change them. */
export const routineInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** Worker agent that runs it, for example `mjrmyr/myriad:swe`. */
    agent: z.string().min(1),
    /** The brief each run starts with. */
    instructions: z.string().trim().min(1).max(64_000),
    schedule: scheduleSchema,
    /** Kaeno thread that receives each run's report. */
    thread: z
      .string()
      .regex(/^[A-Za-z0-9:_.-]{1,200}$/)
      .default("routines"),
    /** A run still unfinished after this long is cancelled. */
    timeoutMinutes: z.number().int().min(1).max(1440).default(60),
    enabled: z.boolean().default(true),
  })
  .strict();
export type RoutineInput = z.input<typeof routineInputSchema>;
export interface Routine extends z.output<typeof routineInputSchema> {
  id: number;
  /** Creation or last change; scheduling never fires slots from before it. */
  updatedAt: number;
}
export interface RoutineRun {
  routineId: number;
  /** The scheduled instant it ran for; null for a manual run. */
  slot: number | null;
  workId: number;
  startedAt: number;
}

const routineRow = z.object({
  id: z.number(),
  name: z.string(),
  agent: z.string(),
  instructions: z.string(),
  schedule: z.string(),
  thread: z.string(),
  timeout_minutes: z.number(),
  enabled: z.number(),
  updated_at: z.number(),
});
const runRow = z.object({
  routine_id: z.number(),
  slot: z.number().nullable(),
  work_id: z.number(),
  started_at: z.number(),
});

function routineOf(row: unknown): Routine {
  const parsed = routineRow.parse(row);
  return {
    id: parsed.id,
    name: parsed.name,
    agent: parsed.agent,
    instructions: parsed.instructions,
    schedule: scheduleSchema.parse(JSON.parse(parsed.schedule)),
    thread: parsed.thread,
    timeoutMinutes: parsed.timeout_minutes,
    enabled: parsed.enabled === 1,
    updatedAt: parsed.updated_at,
  };
}
function runOf(row: unknown): RoutineRun {
  const parsed = runRow.parse(row);
  return {
    routineId: parsed.routine_id,
    slot: parsed.slot,
    workId: parsed.work_id,
    startedAt: parsed.started_at,
  };
}

/** Routines and their run history in Kaeno's own database. Run status lives in durable WORK. */
export class RoutineStore {
  private readonly database: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.database = database;
    database.exec(`CREATE TABLE IF NOT EXISTS routines (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      agent TEXT NOT NULL,
      instructions TEXT NOT NULL,
      schedule TEXT NOT NULL,
      thread TEXT NOT NULL,
      timeout_minutes INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`);
    database.exec(`CREATE TABLE IF NOT EXISTS routine_runs (
      id INTEGER PRIMARY KEY,
      routine_id INTEGER NOT NULL,
      slot INTEGER,
      work_id INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      UNIQUE (routine_id, slot)
    ) STRICT`);
  }

  list(): Routine[] {
    return this.database
      .prepare("SELECT * FROM routines ORDER BY id")
      .all()
      .map(routineOf);
  }

  get(id: number): Routine | undefined {
    const row = this.database
      .prepare("SELECT * FROM routines WHERE id = ?")
      .get(id);
    return row ? routineOf(row) : undefined;
  }

  create(input: z.output<typeof routineInputSchema>, now: number): Routine {
    const { lastInsertRowid } = this.database
      .prepare(
        "INSERT INTO routines (name, agent, instructions, schedule, thread, timeout_minutes, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(...this.values(input), now);
    return { ...input, id: Number(lastInsertRowid), updatedAt: now };
  }

  replace(
    id: number,
    input: z.output<typeof routineInputSchema>,
    now: number,
  ): boolean {
    const { changes } = this.database
      .prepare(
        "UPDATE routines SET name = ?, agent = ?, instructions = ?, schedule = ?, thread = ?, timeout_minutes = ?, enabled = ?, updated_at = ? WHERE id = ?",
      )
      .run(...this.values(input), now, id);
    return changes > 0;
  }

  remove(id: number): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("DELETE FROM routine_runs WHERE routine_id = ?")
        .run(id);
      const { changes } = this.database
        .prepare("DELETE FROM routines WHERE id = ?")
        .run(id);
      this.database.exec("COMMIT");
      return changes > 0;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  lastRun(routineId: number): RoutineRun | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(routineId);
    return row ? runOf(row) : undefined;
  }

  lastScheduledSlot(routineId: number): number | undefined {
    const row = this.database
      .prepare(
        "SELECT max(slot) AS slot FROM routine_runs WHERE routine_id = ? AND slot IS NOT NULL",
      )
      .get(routineId);
    const slot = z.object({ slot: z.number().nullable() }).parse(row).slot;
    return slot ?? undefined;
  }

  /** Idempotent: recording the same scheduled slot twice keeps the first record. */
  recordRun(run: RoutineRun): void {
    this.database
      .prepare(
        "INSERT OR IGNORE INTO routine_runs (routine_id, slot, work_id, started_at) VALUES (?, ?, ?, ?)",
      )
      .run(run.routineId, run.slot, run.workId, run.startedAt);
  }

  private values(input: z.output<typeof routineInputSchema>) {
    return [
      input.name,
      input.agent,
      input.instructions,
      JSON.stringify(input.schedule),
      input.thread,
      input.timeoutMinutes,
      input.enabled ? 1 : 0,
    ] as const;
  }
}
