import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type {
  Kaeno,
  KaenoExtension,
  TicketRecord,
} from "../../core/application/index.ts";
import { latestSlot, nextSlot } from "./schedule.ts";
import {
  routineInputSchema,
  type Routine,
  type RoutineChange,
  type RoutineFields,
  type RoutineStore,
} from "./store.ts";

export const ROUTINES_EXTENSION = "kaeno-routines";
export const LIST_ROUTINES = "list_routines";
export const CREATE_ROUTINE = "create_routine";
export const UPDATE_ROUTINE = "update_routine";
export const DELETE_ROUTINE = "delete_routine";

const scheduleParameter = Type.Union([
  Type.Object({
    every: Type.Integer({
      minimum: 1,
      maximum: 10_080,
      description: "Minutes between runs",
    }),
  }),
  Type.Object({
    at: Type.String({ description: "Local time, HH:MM" }),
    timeZone: Type.String({ description: "IANA zone, e.g. Europe/Berlin" }),
    days: Type.Optional(
      Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), {
        description: "1 = Monday … 7 = Sunday; omit for every day",
      }),
    ),
  }),
]);
const routineParameters = {
  name: Type.String({ minLength: 1, maxLength: 80 }),
  agent: Type.String({ description: "Worker agent ID from your instructions" }),
  instructions: Type.String({
    minLength: 1,
    description: "Complete, self-contained brief that every run starts with",
  }),
  schedule: scheduleParameter,
  thread: Type.Optional(
    Type.String({
      description: "Thread that receives run reports; defaults to this one",
    }),
  ),
  timeoutMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
  enabled: Type.Optional(Type.Boolean()),
};
const APPROVAL =
  "Nothing changes until the owner approves this change ID; tell them exactly what you proposed and the ID. They can also reject it.";
const TICK_MS = 30_000;

/** Long enough to answer "how did it go", short enough for a tool result. */
const REPORT_CHARS = 2000;

/** A run as its ticket records it; the store keeps only the ticket number. */
function runOutcome(ticket: Readonly<TicketRecord> | undefined): {
  status: string;
  report?: string;
} {
  if (!ticket) {
    return { status: "unknown" };
  }
  if (ticket.status === "queued" || ticket.status === "running") {
    return { status: "running" };
  }
  const report = ticket.reports.at(-1);
  return {
    status:
      ticket.status === "ended"
        ? (ticket.ended?.reason ?? "ended")
        : (report?.state ?? "completed"),
    ...(report ? { report: report.summary.slice(0, REPORT_CHARS) } : {}),
  };
}

function fieldsOf(routine: Routine): RoutineFields {
  const { id: _id, updatedAt: _updatedAt, ...fields } = routine;
  return fields;
}

export interface RoutineView extends Routine {
  lastRun?: {
    ticket: string;
    startedAt: number;
    status: string;
    /** The run's final report, truncated. */
    report?: string;
  };
  nextRun?: number;
}

/**
 * Owner-defined scheduled work. Each run is a ticket for the routine's agent, started by the host with the
 * owner's standing approval (no router decision), and its report reaches the router, which relays it to the
 * routine's thread. Kaeno lists routines
 * and may propose creating, changing or deleting one; a proposal changes nothing until the owner
 * approves it. Only the scheduler and the owner start runs.
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

  /** The runtime: Kaeno's tools and the scheduler, started once core is open. */
  extension(): KaenoExtension {
    const list = defineTool({
      name: LIST_ROUTINES,
      description:
        "List the owner's routines (work that runs on its own schedule) with agent, schedule, last run and next run, plus your proposed changes still awaiting the owner. You cannot run routines.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, _api, context) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              routines: await this.describe(Date.now(), context),
              pendingChanges: this.store.changes("pending"),
            }),
          },
        ],
      }),
    });
    // Proposals mutate, so the router's tool policy demands the owner's message as their basis:
    // a work or routine report can never propose a routine. The change ID is the tool call.
    const create = defineTool({
      name: CREATE_ROUTINE,
      description: `Propose a new routine. ${APPROVAL}`,
      parameters: Type.Object(routineParameters),
      replay: "safe",
      execute: async (args, api) => {
        const input = this.validate({
          ...args,
          thread:
            args.thread ??
            (await this.attached().router.lastOwnerThread(BACKGROUND_CONTEXT)),
        });
        return this.proposed(
          this.store.propose(
            `c${api.taskId}`,
            { action: "create", input },
            Date.now(),
          ),
        );
      },
    });
    const update = defineTool({
      name: UPDATE_ROUTINE,
      description: `Propose changing a routine; omitted fields keep their current value. ${APPROVAL}`,
      parameters: Type.Object({
        id: Type.Integer({ minimum: 1 }),
        ...Type.Partial(Type.Object(routineParameters)).properties,
      }),
      replay: "safe",
      execute: async ({ id, ...changes }, api) => {
        const routine = this.routine(id);
        return this.proposed(
          this.store.propose(
            `c${api.taskId}`,
            {
              action: "update",
              routineId: id,
              baseUpdatedAt: routine.updatedAt,
              input: this.validate({ ...fieldsOf(routine), ...changes }),
            },
            Date.now(),
          ),
        );
      },
    });
    const remove = defineTool({
      name: DELETE_ROUTINE,
      description: `Propose deleting a routine. ${APPROVAL}`,
      parameters: Type.Object({ id: Type.Integer({ minimum: 1 }) }),
      replay: "safe",
      execute: async ({ id }, api) =>
        this.proposed(
          this.store.propose(
            `c${api.taskId}`,
            {
              action: "delete",
              routineId: id,
              baseUpdatedAt: this.routine(id).updatedAt,
            },
            Date.now(),
          ),
        ),
    });
    return {
      durable: defineExtension({
        name: ROUTINES_EXTENSION,
        tools: [list, create, update, remove],
      }),
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
        const ticket = last
          ? await core.router
              .ticket(`k${last.workId}`, context)
              .catch(() => undefined)
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
                  ticket: `k${last.workId}`,
                  startedAt: last.startedAt,
                  ...runOutcome(ticket),
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

  changes(): RoutineChange[] {
    return this.store.changes();
  }

  /**
   * Apply a proposed change exactly as proposed. Idempotent: approving it again returns it. An
   * update or delete of a routine that changed since the proposal is refused, never merged.
   */
  approve(id: string, now = Date.now()): RoutineChange {
    return this.store.transaction(() => {
      const change = this.change(id);
      if (change.status === "approved") {
        return change;
      }
      if (change.status === "rejected") {
        throw new Error(`Change ${id} was rejected`);
      }
      this.store.decide(id, "approved", now, this.apply(change, now));
      return this.change(id);
    });
  }

  reject(id: string, now = Date.now()): RoutineChange {
    return this.store.transaction(() => {
      if (this.change(id).status === "approved") {
        throw new Error(`Change ${id} was already approved`);
      }
      this.store.decide(id, "rejected", now);
      return this.change(id);
    });
  }

  /** Start a run now, outside the schedule. Refused while the previous run is unfinished. */
  runNow(id: number, now = Date.now()): Promise<string> {
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
        const works = await core.harness.commit(
          (tx) =>
            core.router.stopTicket(
              tx,
              `k${last.workId}`,
              "host",
              `timed out after ${routine.timeoutMinutes} minutes`,
            ),
          BACKGROUND_CONTEXT,
        );
        await core.router.abortWorks(works, BACKGROUND_CONTEXT);
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
  ): Promise<string> {
    const core = this.attached();
    if (!core.work) {
      throw new Error("Routines need WORK, which is not configured");
    }
    // A slot's key is stable, so a start retried after a crash finds the same ticket.
    const key = `routine:${routine.id}:${slot ?? `manual:${now}`}`;
    const previous = this.store.lastRun(routine.id);
    const ticket = await core.harness.commit(async (tx) => {
      // The previous run's ticket stops following the routine's thread: the new run takes over.
      if (previous) {
        const ended = await core.router
          .stopTicket(
            tx,
            `k${previous.workId}`,
            "host",
            "superseded by the next run",
          )
          .catch(() => []);
        if (ended.length > 0) {
          throw new Error(`Routine ${routine.id} is still running`);
        }
      }
      return core.router.startTicket(tx, {
        key,
        source: "routine",
        thread: `routine:${routine.id}`,
        replyThread: routine.thread,
        agent: routine.agent,
        title: `Routine: ${routine.name}`,
        content: routine.instructions,
      });
    }, BACKGROUND_CONTEXT);
    this.store.recordRun({
      routineId: routine.id,
      slot,
      workId: Number(ticket.slice(1)),
      startedAt: now,
    });
    return ticket;
  }

  private async isRunning(
    routine: Routine,
    context: Context,
  ): Promise<boolean> {
    const last = this.store.lastRun(routine.id);
    if (!last) {
      return false;
    }
    const ticket = await this.attached()
      .router.ticket(`k${last.workId}`, context)
      .catch(() => undefined);
    return ticket?.status === "queued" || ticket?.status === "running";
  }

  private apply(change: RoutineChange, now: number): number {
    if (change.action === "create") {
      return this.store.create(change.input, now).id;
    }
    const current = this.store.get(change.routineId);
    if (!current) {
      throw new Error(`Routine ${change.routineId} no longer exists`);
    }
    if (current.updatedAt !== change.baseUpdatedAt) {
      throw new Error(
        `Routine ${change.routineId} changed after change ${change.id} was proposed; reject it and ask again`,
      );
    }
    if (change.action === "update") {
      this.store.replace(change.routineId, change.input, now);
    } else {
      this.store.remove(change.routineId);
    }
    return change.routineId;
  }

  private change(id: string): RoutineChange {
    const change = this.store.change(id);
    if (!change) {
      throw new Error(`No change ${id}`);
    }
    return change;
  }

  private routine(id: number): Routine {
    const routine = this.store.get(id);
    if (!routine) {
      throw new Error(`No routine ${id}`);
    }
    return routine;
  }

  private proposed(change: RoutineChange) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Proposed change ${change.id} (${change.status}): ${JSON.stringify(change)}. ${APPROVAL}`,
        },
      ],
    };
  }

  private validate(input: unknown): RoutineFields {
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
