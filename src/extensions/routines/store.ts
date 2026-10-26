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
/** Validated routine fields, with defaults applied and the agent resolved. */
export type RoutineFields = z.output<typeof routineInputSchema>;
export interface Routine extends RoutineFields {
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

const fieldsSchema = routineInputSchema.required();
/** What Kaeno asked for. Update and delete name the routine version they were proposed against. */
const proposalSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), input: fieldsSchema }),
  z.object({
    action: z.literal("update"),
    routineId: z.number(),
    baseUpdatedAt: z.number(),
    input: fieldsSchema,
  }),
  z.object({
    action: z.literal("delete"),
    routineId: z.number(),
    baseUpdatedAt: z.number(),
  }),
]);
export type RoutineProposal = z.infer<typeof proposalSchema>;
/** A change Kaeno proposed; it is applied only when the owner approves it. */
export type RoutineChange = RoutineProposal & {
  id: string;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  decidedAt?: number;
  /** The routine an approved change created, changed or deleted. */
  result?: number;
};
const changeRow = z.object({
  id: z.string(),
  proposal: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  created_at: z.number(),
  decided_at: z.number().nullable(),
  result: z.number().nullable(),
});
function changeOf(row: unknown): RoutineChange {
  const parsed = changeRow.parse(row);
  return {
    ...proposalSchema.parse(JSON.parse(parsed.proposal)),
    id: parsed.id,
    status: parsed.status,
    createdAt: parsed.created_at,
    ...(parsed.decided_at === null ? {} : { decidedAt: parsed.decided_at }),
    ...(parsed.result === null ? {} : { result: parsed.result }),
  };
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
    database.exec(`CREATE TABLE IF NOT EXISTS routine_changes (
      id TEXT PRIMARY KEY,
      proposal TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      result INTEGER
    ) STRICT`);
  }

  private depth = 0;
  /** Run `body` atomically; nested calls join the outer transaction. */
  transaction<T>(body: () => T): T {
    if (this.depth > 0) {
      return body();
    }
    this.database.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = body();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
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

  create(input: RoutineFields, now: number): Routine {
    const { lastInsertRowid } = this.database
      .prepare(
        "INSERT INTO routines (name, agent, instructions, schedule, thread, timeout_minutes, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(...this.values(input), now);
    return { ...input, id: Number(lastInsertRowid), updatedAt: now };
  }

  replace(id: number, input: RoutineFields, now: number): boolean {
    const { changes } = this.database
      .prepare(
        "UPDATE routines SET name = ?, agent = ?, instructions = ?, schedule = ?, thread = ?, timeout_minutes = ?, enabled = ?, updated_at = ? WHERE id = ?",
      )
      .run(...this.values(input), now, id);
    return changes > 0;
  }

  remove(id: number): boolean {
    return this.transaction(() => {
      this.database
        .prepare("DELETE FROM routine_runs WHERE routine_id = ?")
        .run(id);
      const { changes } = this.database
        .prepare("DELETE FROM routines WHERE id = ?")
        .run(id);
      return changes > 0;
    });
  }

  /** Idempotent: proposing under an existing ID keeps the first proposal. */
  propose(id: string, proposal: RoutineProposal, now: number): RoutineChange {
    this.database
      .prepare(
        "INSERT OR IGNORE INTO routine_changes (id, proposal, status, created_at) VALUES (?, ?, 'pending', ?)",
      )
      .run(id, JSON.stringify(proposalSchema.parse(proposal)), now);
    const change = this.change(id);
    if (!change) {
      throw new Error(`Change ${id} was not recorded`);
    }
    return change;
  }

  change(id: string): RoutineChange | undefined {
    const row = this.database
      .prepare("SELECT * FROM routine_changes WHERE id = ?")
      .get(id);
    return row ? changeOf(row) : undefined;
  }

  changes(status?: RoutineChange["status"]): RoutineChange[] {
    return (
      status
        ? this.database
            .prepare(
              "SELECT * FROM routine_changes WHERE status = ? ORDER BY created_at",
            )
            .all(status)
        : this.database
            .prepare("SELECT * FROM routine_changes ORDER BY created_at")
            .all()
    ).map(changeOf);
  }

  decide(
    id: string,
    status: "approved" | "rejected",
    now: number,
    result?: number,
  ): void {
    this.database
      .prepare(
        "UPDATE routine_changes SET status = ?, decided_at = ?, result = ? WHERE id = ? AND status = 'pending'",
      )
      .run(status, now, result ?? null, id);
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

  private values(input: RoutineFields) {
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
