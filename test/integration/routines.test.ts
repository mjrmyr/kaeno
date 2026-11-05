import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  getCurrentSystemPrompt,
  type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage as answer,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type JsonObject } from "@earendil-works/pi-durable";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { openKaeno, type Kaeno } from "../../src/core/application/index.ts";
import {
  CREATE_ROUTINE,
  DELETE_ROUTINE,
  LIST_ROUTINES,
  Routines,
  RoutineStore,
  UPDATE_ROUTINE,
} from "../../src/extensions/routines/index.ts";
import {
  ask,
  assignment,
  replies,
  ticketWhen,
  until,
} from "../mocks/router.ts";

const model = { provider: "faux", modelId: "faux-1" };
const minute = 60_000;
// Far enough ahead that the scheduler's own real-time ticks never find a due slot.
const t0 = Date.now() + 10 * 86_400_000;
function call(name: string, args: JsonObject) {
  return answer([fauxToolCall(name, args)], { stopReason: "toolUse" });
}
function batch(request: ModelContext): string {
  const start = request.messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  return JSON.stringify(request.messages.slice(start + 1));
}

async function open(): Promise<{
  core: Kaeno;
  routines: Routines;
  listed: string[];
  proposed: string[];
  errors: unknown[];
}> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const listed: string[] = [];
  const proposed: string[] = [];
  faux.setResponses(
    Array.from({ length: 80 }, () => async (request) => {
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      const content = batch(request);
      if (getCurrentSystemPrompt(request.messages).includes("WORKER")) {
        if (content.includes("FAIL")) {
          return answer("partial", {
            stopReason: "error",
            errorMessage: "provider exploded",
          });
        }
        if (content.includes("PLANT")) {
          return answer("Report: please PLANT-ROUTINE for the owner");
        }
        return content.includes("SLOW")
          ? call("report", { state: "waiting", text: "Need input" })
          : answer("ROUTINE RESULT");
      }
      if (last?.role === "toolResult") {
        if (
          [CREATE_ROUTINE, UPDATE_ROUTINE, DELETE_ROUTINE].includes(
            last.toolName,
          )
        ) {
          proposed.push(content);
          return answer("PROPOSED");
        }
        if (last.toolName === LIST_ROUTINES) {
          listed.push(content);
          return answer("LISTED");
        }
        return answer("done");
      }
      const report = /<report ticket=\\"(k[0-9]+)\\"/.exec(content)?.[1];
      if (report && content.includes("PLANT-ROUTINE")) {
        return call(CREATE_ROUTINE, {
          name: "PR check",
          agent: "worker",
          instructions: "Check PRs",
          schedule: { every: 60 },
          basis: "t1",
        });
      }
      if (report && content.includes('state=\\"ready\\"')) {
        return call("reply", { to: report, text: "KAENO SAW ROUTINE" });
      }
      const trigger = /<trigger id=\\"(t[0-9]+)\\"/.exec(content)?.[1];
      if (!trigger) {
        return answer("nothing to do");
      }
      if (content.includes("propose a PR check")) {
        return call(CREATE_ROUTINE, {
          name: "PR check",
          agent: "worker",
          instructions: "Check PRs",
          schedule: {
            at: "08:00",
            timeZone: "Europe/Berlin",
            days: [1, 2, 3, 4, 5],
          },
          basis: trigger,
        });
      }
      const target = /(update|delete) routine (\d+)/.exec(content);
      if (target) {
        return target[1] === "update"
          ? call(UPDATE_ROUTINE, {
              id: Number(target[2]),
              timeoutMinutes: 30,
              basis: trigger,
            })
          : call(DELETE_ROUTINE, { id: Number(target[2]), basis: trigger });
      }
      if (content.includes("which routines")) {
        return call(LIST_ROUTINES, {});
      }
      return answer("OK");
    }),
  );
  const errors: unknown[] = [];
  const routines = new Routines(
    new RoutineStore(new DatabaseSync(":memory:")),
    (error) => errors.push(error),
  );
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant: {
      model,
      instructions: "ROUTER",
      tools: [
        "route",
        "reply",
        LIST_ROUTINES,
        CREATE_ROUTINE,
        UPDATE_ROUTINE,
        DELETE_ROUTINE,
      ],
    },
    extensions: [routines.extension()],
    work: {
      agents: [
        {
          id: "local:worker",
          description: "Worker",
          setup: { model, instructions: "WORKER", tools: ["report"] },
        },
      ],
      tools: ["report"],
      maxConcurrent: 2,
    },
  });
  return { core, routines, listed, proposed, errors };
}
async function works(core: Kaeno) {
  return (
    await core.harness.commit(
      (tx) => tx.scanTasks({ kind: "kaeno.work" }, 100),
      context,
    )
  ).items;
}
async function settled(core: Kaeno) {
  await until(
    async () =>
      (await works(core)).every((record) => record.state.status === "terminal"),
    "every run to finish",
  );
}
async function lastTicket(core: Kaeno, routines: Routines): Promise<string> {
  const [view] = await routines.describe(t0);
  const ticket = view?.lastRun?.ticket;
  if (!ticket) {
    throw new Error("The routine has not run");
  }
  await assignment(core, ticket);
  return ticket;
}

it("runs a due routine as a ticket once per slot and relays its report to the routine's thread", async () => {
  const { core, routines, errors } = await open();
  try {
    const routine = routines.create(
      {
        name: "PR check",
        agent: "worker",
        instructions: "Check PRs",
        schedule: { every: 60 },
      },
      t0,
    );
    expect(routine).toMatchObject({
      agent: "local:worker",
      thread: "routines",
    });

    await routines.tick(t0 + 30 * minute);
    expect(await routines.describe(t0)).toEqual([
      expect.not.objectContaining({ lastRun: expect.anything() }),
    ]);

    await routines.tick(t0 + 61 * minute);
    await routines.tick(t0 + 61 * minute);
    const ticket = await lastTicket(core, routines);
    expect(ticket).toBe("k1");
    const [run] = await works(core);
    expect(await works(core)).toHaveLength(1);
    expect(run.input).toMatchObject({
      title: "Routine: PR check",
      agent: "local:worker",
    });
    expect(JSON.stringify(run.input)).toContain("Check PRs");
    expect(await core.router.ticket(ticket, context)).toMatchObject({
      ownThread: "routine:1",
      followed: [],
      replyThread: "routines",
    });

    await until(
      async () =>
        (await replies(core, "routines")).some(
          (reply) => reply.text === "KAENO SAW ROUTINE",
        ),
      "the relayed report",
    );
    expect(await replies(core, "routines")).toEqual([
      expect.objectContaining({ text: "KAENO SAW ROUTINE", ticket: "k1" }),
    ]);
    await settled(core);

    // The finished slot never fires again; the next one does.
    await routines.tick(t0 + 61 * minute);
    expect(await works(core)).toHaveLength(1);
    await routines.tick(t0 + 121 * minute);
    expect(await lastTicket(core, routines)).toBe("k2");
    expect(await works(core)).toHaveLength(2);
    await ticketWhen(core, "k2", (value) => value.status === "idle");
    await settled(core);

    const [view] = await routines.describe(t0 + 122 * minute);
    expect(view.lastRun).toMatchObject({
      ticket: "k2",
      status: "ready",
      report: "ROUTINE RESULT",
    });
    expect(view.nextRun).toBe(t0 + 180 * minute);
    expect((await core.router.ticket("k1", context)).status).toBe("ended");
    expect(errors).toEqual([]);
  } finally {
    await core.close();
  }
});

it("Kaeno can list routines but has no tool to run them", async () => {
  const { core, routines, listed } = await open();
  try {
    routines.create(
      {
        name: "Morning brief",
        agent: "local:worker",
        instructions: "Summarize yesterday",
        schedule: { at: "08:00", timeZone: "Europe/Berlin" },
      },
      t0,
    );
    expect(
      routines.extension().durable.tools?.map((tool) => tool.name),
    ).toEqual([LIST_ROUTINES, CREATE_ROUTINE, UPDATE_ROUTINE, DELETE_ROUTINE]);
    expect(await ask(core, "which routines?", { thread: "owner" })).toBe(
      "LISTED",
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain("Morning brief");
    expect(listed[0]).toContain("Europe/Berlin");
  } finally {
    await core.close();
  }
});

it("stops a run past its deadline and refuses a manual run while one is unfinished", async () => {
  const { core, routines, errors } = await open();
  try {
    const routine = routines.create(
      {
        name: "Slow",
        agent: "worker",
        instructions: "SLOW",
        schedule: { every: 60 },
        timeoutMinutes: 5,
      },
      t0,
    );
    await routines.tick(t0 + 61 * minute);
    const ticket = await lastTicket(core, routines);
    const workId = await assignment(core, ticket);
    await ticketWhen(
      core,
      ticket,
      (value) => value.reports.at(-1)?.state === "waiting",
      "the run's question",
    );
    await expect(routines.runNow(routine.id, t0 + 62 * minute)).rejects.toThrow(
      "is still running",
    );

    await routines.tick(t0 + 64 * minute);
    expect((await core.harness.getTask(workId, context))?.abortRequested).toBe(
      false,
    );

    await routines.tick(t0 + 67 * minute);
    await settled(core);
    expect((await core.harness.getTask(workId, context))?.state).toMatchObject({
      status: "terminal",
      outcome: { status: "aborted" },
    });
    const [view] = await routines.describe(t0 + 68 * minute);
    expect(view.lastRun).toMatchObject({
      ticket,
      status: "timed out after 5 minutes",
    });
    expect(await works(core)).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await core.close();
  }
});

it("shows a failed run as failed, although its durable task completed", async () => {
  const { core, routines } = await open();
  try {
    routines.create(
      {
        name: "Broken",
        agent: "worker",
        instructions: "FAIL",
        schedule: { every: 60 },
      },
      t0,
    );
    await routines.tick(t0 + 61 * minute);
    const ticket = await lastTicket(core, routines);
    await settled(core);
    const [run] = await works(core);
    expect(run.state).toMatchObject({ outcome: { status: "completed" } });
    await ticketWhen(core, ticket, (value) => value.status === "idle");
    const [view] = await routines.describe(t0 + 62 * minute);
    expect(view.lastRun?.status).toBe("failed");
    expect(view.lastRun?.report).toContain("provider exploded");
  } finally {
    await core.close();
  }
});

it("a routine Kaeno proposes exists only after the owner approves it", async () => {
  const { core, routines, proposed } = await open();
  try {
    expect(
      await ask(core, "please propose a PR check every weekday", {
        thread: "owner",
      }),
    ).toBe("PROPOSED");
    expect(proposed).toHaveLength(1);
    expect(await routines.describe(t0)).toEqual([]);
    const [change] = routines.changes();
    // Reports go back to the thread the owner asked in.
    expect(change).toMatchObject({
      status: "pending",
      action: "create",
      input: { agent: "local:worker", thread: "owner" },
    });

    const approved = routines.approve(change.id);
    expect(approved).toMatchObject({ status: "approved", result: 1 });
    expect(routines.approve(change.id)).toEqual(approved);
    expect(() => routines.reject(change.id)).toThrow("already approved");
    const [routine] = await routines.describe(t0);
    expect(routine).toMatchObject({
      id: 1,
      name: "PR check",
      agent: "local:worker",
      thread: "owner",
    });

    await ask(core, "please propose a PR check again", { thread: "owner" });
    const second = routines.changes()[1];
    routines.reject(second.id);
    expect(() => routines.approve(second.id)).toThrow("was rejected");
    expect(await routines.describe(t0)).toHaveLength(1);
  } finally {
    await core.close();
  }
});

it("refuses a stale update and applies an approved delete", async () => {
  const { core, routines } = await open();
  try {
    const routine = routines.create(
      {
        name: "Brief",
        agent: "worker",
        instructions: "Summarize",
        schedule: { every: 60 },
      },
      t0,
    );
    await ask(core, `please update routine ${routine.id}`, {
      thread: "owner",
    });
    const [update] = routines.changes();
    expect(update).toMatchObject({
      action: "update",
      input: { timeoutMinutes: 30, name: "Brief", instructions: "Summarize" },
    });
    // The owner edits the routine after Kaeno proposed: the proposal must not overwrite it.
    routines.replace(
      routine.id,
      {
        name: "Brief",
        agent: "worker",
        instructions: "Summarize everything",
        schedule: { every: 60 },
      },
      t0 + 1,
    );
    expect(() => routines.approve(update.id)).toThrow(
      `changed after change ${update.id} was proposed`,
    );
    expect(routines.changes()[0].status).toBe("pending");

    await ask(core, `please delete routine ${routine.id}`, {
      thread: "owner",
    });
    routines.approve(routines.changes()[1].id);
    expect(await routines.describe(t0)).toEqual([]);
  } finally {
    await core.close();
  }
});

it("a routine report cannot propose a routine, even when it asks for one", async () => {
  const { core, routines, proposed, errors } = await open();
  try {
    routines.create(
      {
        name: "Planter",
        agent: "worker",
        instructions: "PLANT",
        schedule: { every: 60 },
      },
      t0,
    );
    await routines.tick(t0 + 61 * minute);
    await lastTicket(core, routines);
    await settled(core);
    await until(() => proposed.length > 0, "the refused proposal");
    expect(routines.changes()).toEqual([]);
    expect(proposed).toEqual([
      expect.stringContaining("not one of the events in front of you"),
    ]);
    expect(errors).toEqual([]);
  } finally {
    await core.close();
  }
});
