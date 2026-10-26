import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { z } from "zod";
import {
  parseTaskId,
  type Kaeno,
  type KaenoExtension,
} from "../../core/application/index.ts";
import { latestSlot, nextSlot } from "./schedule.ts";
import {
  routineInputSchema,
  type Routine,
  type RoutineStore,
} from "./store.ts";

export const ROUTINES_EXTENSION = "kaeno-routines";
export const LIST_ROUTINES = "list_routines";
const TICK_MS = 30_000;

/** Long enough to answer "how did it go", short enough for a tool result. */
const REPORT_CHARS = 2000;
const workResultSchema = z.object({
  status: z.enum(["completed", "failed"]),
  text: z.string(),
});

/**
 * A run as WORK records it; the store keeps only the work ID. A finished task's own outcome is
 * "completed" even when the work failed, so a completed task reports the work's result instead.
 */
function runOutcome(task: Awaited<ReturnType<Kaeno["harness"]["getTask"]>>): {
  status: string;
  report?: string;
} {
  if (!task) {
    return { status: "unknown" };
  }
  if (task.state.status !== "terminal") {
    return { status: "running" };
  }
  const { outcome } = task.state;
  if (outcome.status !== "completed") {
    return { status: outcome.status };
  }
  const result = workResultSchema.safeParse(outcome.result);
  return result.success
    ? {
        status: result.data.status,
        report: result.data.text.slice(0, REPORT_CHARS),
      }
    : { status: "completed" };
}

export interface RoutineView extends Routine {
  lastRun?: {
    workId: number;
    startedAt: number;
    status: string;
    /** The run's final report, truncated. */
    report?: string;
  };
  nextRun?: number;
}

/**
 * Owner-defined scheduled work. Each run is root WORK for the routine's agent, started by the host
 * and reporting to the routine's Kaeno thread like work Kaeno started itself. Kaeno can list
 * routines but not create, change or run them; only the owner can, through the HTTP API.
 */
export class Routines {
  private readonly store: RoutineStore;
  private readonly onReport: (error: unknown) => void;
  private core: Kaeno | undefined;
  /** Scheduling passes and manual runs, one at a time, so their overlap checks never race. */
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    store: RoutineStore,
    onReport: (error: unknown) => void = console.error,
  ) {
    this.store = store;
    this.onReport = onReport;
  }

  /** The runtime: the read-only tool for Kaeno and the scheduler, started once core is open. */
  extension(): KaenoExtension {
    const list = defineTool({
      name: LIST_ROUTINES,
      description:
        "List the owner's routines: work that runs on its own schedule, with its agent, schedule, last run and next run. You can describe routines but not create, change or run them; the owner manages them.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, _api, context) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(await this.describe(Date.now(), context)),
          },
        ],
      }),
    });
    return {
      durable: defineExtension({ name: ROUTINES_EXTENSION, tools: [list] }),
      readOnlyTools: [LIST_ROUTINES],
      start: async (core, signal) => {
        this.core = core;
        if (!core.work) {
          return;
        }
        const tick = () => void this.tick(Date.now());
        tick();
        const timer = setInterval(tick, TICK_MS);
        signal.addEventListener("abort", () => clearInterval(timer), {
          once: true,
        });
        return async () => {
          clearInterval(timer);
          await this.queue;
        };
      },
    };
  }

  async describe(
    now: number,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<RoutineView[]> {
    const core = this.attached();
    return Promise.all(
      this.store.list().map(async (routine) => {
        const last = this.store.lastRun(routine.id);
        const task = last
          ? await core.harness.getTask(parseTaskId(last.workId), context)
          : undefined;
        const next = routine.enabled
          ? nextSlot(
              routine.schedule,
              Math.max(
                routine.updatedAt,
                this.store.lastScheduledSlot(routine.id) ?? -Infinity,
              ),
              now,
            )
          : undefined;
        return {
          ...routine,
          ...(last
            ? {
                lastRun: {
                  workId: last.workId,
                  startedAt: last.startedAt,
                  ...runOutcome(task),
                },
              }
            : {}),
          ...(next === undefined ? {} : { nextRun: next }),
        };
      }),
    );
  }

  /** `input` is validated here, so API bodies can be passed as received. */
  create(input: unknown, now = Date.now()): Routine {
    return this.store.create(this.validate(input), now);
  }

  replace(id: number, input: unknown, now = Date.now()): boolean {
    return this.store.replace(id, this.validate(input), now);
  }

  remove(id: number): boolean {
    return this.store.remove(id);
  }

  /** Start a run now, outside the schedule. Refused while the previous run is unfinished. */
  runNow(id: number, now = Date.now()): Promise<number> {
    return this.serially(async () => {
      const routine = this.store.get(id);
      if (!routine) {
        throw new Error(`No routine ${id}`);
      }
      if (await this.isRunning(routine, BACKGROUND_CONTEXT)) {
        throw new Error(`Routine ${id} is still running`);
      }
      return this.start(routine, null, now);
    });
  }

  /** One scheduling pass; one routine's failure does not stop the others. */
  tick(now: number): Promise<void> {
    return this.serially(async () => {
      for (const routine of this.store.list()) {
        try {
          await this.due(routine, now);
        } catch (error) {
          this.onReport(
            new Error(`Routine ${routine.id} (${routine.name})`, {
              cause: error,
            }),
          );
        }
      }
    });
  }

  private serially<T>(body: () => Promise<T>): Promise<T> {
    const result = this.queue.then(body);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async due(routine: Routine, now: number): Promise<void> {
    if (!routine.enabled) {
      return;
    }
    const last = this.store.lastRun(routine.id);
    if (last && (await this.isRunning(routine, BACKGROUND_CONTEXT))) {
      // No overlapping runs; a run past its deadline is cancelled, and the next slot starts fresh.
      if (now - last.startedAt > routine.timeoutMinutes * 60_000) {
        const core = this.attached();
        await core.work?.cancelWork(
          await core.threads.getOrCreateConversation(routine.thread),
          parseTaskId(last.workId),
        );
      }
      return;
    }
    const slot = latestSlot(
      routine.schedule,
      Math.max(
        routine.updatedAt,
        this.store.lastScheduledSlot(routine.id) ?? -Infinity,
      ),
      now,
    );
    if (slot !== undefined) {
      await this.start(routine, slot, now);
    }
  }

  private async start(
    routine: Routine,
    slot: number | null,
    now: number,
  ): Promise<number> {
    const core = this.attached();
    if (!core.work) {
      throw new Error("Routines need WORK, which is not configured");
    }
    const conversation = await core.threads.getOrCreateConversation(
      routine.thread,
    );
    // A slot's key is stable, so a start retried after a crash finds the same work.
    const key = `routine:${routine.id}:${slot ?? `manual:${now}`}`;
    const workId = await core.work.startWork(
      {
        origin: await core.turns.hostOrigin(
          conversation,
          key,
          BACKGROUND_CONTEXT,
        ),
        key,
        agent: routine.agent,
        title: `Routine: ${routine.name}`,
        brief: routine.instructions,
      },
      BACKGROUND_CONTEXT,
    );
    this.store.recordRun({
      routineId: routine.id,
      slot,
      workId,
      startedAt: now,
    });
    return workId;
  }

  private async isRunning(
    routine: Routine,
    context: Context,
  ): Promise<boolean> {
    const last = this.store.lastRun(routine.id);
    if (!last) {
      return false;
    }
    const task = await this.attached().harness.getTask(
      parseTaskId(last.workId),
      context,
    );
    return task !== undefined && task.state.status !== "terminal";
  }

  private validate(input: unknown) {
    const parsed = routineInputSchema.parse(input);
    const work = this.attached().work;
    if (!work) {
      throw new Error("Routines need WORK, which is not configured");
    }
    return { ...parsed, agent: work.resolveAgent(parsed.agent) };
  }

  private attached(): Kaeno {
    if (!this.core) {
      throw new Error("Routines are used before Kaeno started");
    }
    return this.core;
  }
}
