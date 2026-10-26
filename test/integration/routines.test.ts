import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage as answer,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type JsonObject } from "@earendil-works/pi-durable";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { openKaeno, type Kaeno } from "../../src/core/application/index.ts";
import {
  LIST_ROUTINES,
  Routines,
  RoutineStore,
} from "../../src/extensions/routines/index.ts";

const model = { provider: "faux", modelId: "faux-1" };
const minute = 60_000;
// Far enough ahead that the scheduler's own real-time ticks never find a due slot.
const t0 = Date.now() + 10 * 86_400_000;
function call(name: string, args: JsonObject) {
  return answer([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

async function open(): Promise<{
  core: Kaeno;
  routines: Routines;
  listed: string[];
  errors: unknown[];
}> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const listed: string[] = [];
  faux.setResponses(
    Array.from({ length: 60 }, () => async (request) => {
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      const content = JSON.stringify(last?.content);
      if (getCurrentSystemPrompt(request.messages).includes("WORKER")) {
        // A slow run asks a question and waits, so it stays unfinished.
        if (content.includes("FAIL")) {
          return answer("partial", {
            stopReason: "error",
            errorMessage: "provider exploded",
          });
        }
        return content.includes("SLOW")
          ? call("message_parent", { text: "Need input" })
          : answer("ROUTINE RESULT");
      }
      if (last?.role === "toolResult" && last.toolName === LIST_ROUTINES) {
        listed.push(content);
        return answer("LISTED");
      }
      if (content.includes("which routines")) {
        return call(LIST_ROUTINES, {});
      }
      return answer(
        content.includes("ROUTINE RESULT") ? "KAENO SAW ROUTINE" : "OK",
      );
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
    assistant: { model, instructions: "CHAT", tools: [LIST_ROUTINES] },
    extensions: [routines.extension()],
    work: {
      agents: [
        {
          id: "local:worker",
          description: "Worker",
          setup: { model, instructions: "WORKER", tools: ["message_parent"] },
        },
      ],
      tools: ["message_parent"],
      maxConcurrent: 2,
    },
  });
  return { core, routines, listed, errors };
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
  await vi.waitFor(
    async () => {
      expect(
        (await works(core)).every(
          (record) => record.state.status === "terminal",
        ),
      ).toBe(true);
    },
    { timeout: 10_000 },
  );
}

it("runs a due routine as WORK once per slot and reports to its Kaeno thread", async () => {
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
    expect(await works(core)).toHaveLength(0);

    await routines.tick(t0 + 61 * minute);
    await routines.tick(t0 + 61 * minute);
    const [run] = await works(core);
    expect(await works(core)).toHaveLength(1);
    expect(run.input).toMatchObject({
      title: "Routine: PR check",
      brief: "Check PRs",
      agent: "local:worker",
    });

    const thread = await core.threads.getOrCreateConversation("routines");
    await vi.waitFor(
      async () => {
        expect((await core.turns.readReplies(thread, 0)).replies).toEqual([
          expect.objectContaining({
            text: "KAENO SAW ROUTINE",
            source: expect.objectContaining({ kind: "activity-result" }),
          }),
        ]);
      },
      { timeout: 10_000 },
    );
    await settled(core);

    // The finished slot never fires again; the next one does.
    await routines.tick(t0 + 61 * minute);
    expect(await works(core)).toHaveLength(1);
    await routines.tick(t0 + 121 * minute);
    expect(await works(core)).toHaveLength(2);
    await settled(core);

    const [view] = await routines.describe(t0 + 122 * minute);
    expect(view.lastRun).toMatchObject({
      status: "completed",
      report: "ROUTINE RESULT",
    });
    expect(view.nextRun).toBe(t0 + 180 * minute);
    expect(errors).toEqual([]);
  } finally {
    await core.close();
  }
});

it("Kaeno can list routines but has no tool to create, change or run them", async () => {
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
    ).toEqual([LIST_ROUTINES]);
    const chat = await core.threads.getOrCreateConversation("owner");
    const turn = await core.harness.commit(
      (tx) => core.turns.admitUserTurn(tx, chat, "which routines?", "ask-1"),
      context,
    );
    await core.harness.waitForTask(turn, context);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain("Morning brief");
    expect(listed[0]).toContain("Europe/Berlin");
  } finally {
    await core.close();
  }
});

it("cancels a run past its deadline and refuses a manual run while one is unfinished", async () => {
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
    const [run] = await works(core);
    await expect(routines.runNow(routine.id, t0 + 62 * minute)).rejects.toThrow(
      "is still running",
    );

    await routines.tick(t0 + 64 * minute);
    expect((await core.harness.getTask(run.id, context))?.abortRequested).toBe(
      false,
    );

    await routines.tick(t0 + 67 * minute);
    await settled(core);
    const [view] = await routines.describe(t0 + 68 * minute);
    expect(view.lastRun?.status).toBe("aborted");
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
    await settled(core);
    const [run] = await works(core);
    expect(run.state).toMatchObject({ outcome: { status: "completed" } });
    const [view] = await routines.describe(t0 + 62 * minute);
    expect(view.lastRun?.status).toBe("failed");
    expect(view.lastRun?.report).toContain("provider exploded");
  } finally {
    await core.close();
  }
});
