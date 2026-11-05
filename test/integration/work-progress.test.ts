import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage as answer,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import {
  defineExtension,
  defineTool,
  MemoryStorage,
  type JsonObject,
  type TaskId,
} from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import {
  openKaeno,
  type WorkEnvironment,
} from "../../src/core/application/index.ts";
import { listWork, WorkScope } from "../../src/core/work/index.ts";
import {
  assignment,
  isRouterRequest,
  receive,
  ROUTER_ASSISTANT_TOOLS,
  settle,
  sinceLastAnswer,
  startTicket,
  ticketConversation,
  ticketWhen,
} from "../mocks/router.ts";

const model = { provider: "faux", modelId: "faux-1" };
function call(name: string, args: JsonObject) {
  return answer([fauxToolCall(name, args)], { stopReason: "toolUse" });
}
function latch() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: () => resolve() };
}
function environment(release: WorkEnvironment["release"]): WorkEnvironment {
  return {
    identity: "test:progress",
    cwd: "/workspace",
    ensure: async () => {},
    release,
    reconcile: async () => {},
    executionEnvironment: async () => undefined,
  };
}
async function fixture(options: {
  worker: FauxResponseFactory;
  replyOnQuestion?: boolean;
}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const busy = latch();
  const entered = vi.fn<() => void>();
  const release = vi.fn<WorkEnvironment["release"]>();
  const routerBatches: string[] = [];
  const hold = defineTool({
    name: "hold",
    description: "Keep WORK executing while it is inspected",
    parameters: Type.Object({}),
    execute: async () => {
      entered();
      await busy.promise;
      return { content: [{ type: "text", text: "continue" }] };
    },
  });
  faux.setResponses(
    Array.from({ length: 100 }, () => async (...args) => {
      const [request] = args;
      if (!isRouterRequest(request)) {
        return options.worker(...args);
      }
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      if (last?.role === "toolResult") {
        return answer("ok");
      }
      const batch = sinceLastAnswer(request);
      routerBatches.push(batch);
      return options.replyOnQuestion && batch.includes('state=\\"waiting\\"')
        ? call("message_ticket", { ticket: "k1", text: "Context answer: main" })
        : answer("RESULT OBSERVED");
    }),
  );
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant: {
      model,
      instructions: "ROUTER",
      tools: [...ROUTER_ASSISTANT_TOOLS],
    },
    extensions: [{ durable: defineExtension({ name: "hold", tools: [hold] }) }],
    work: {
      agents: [
        {
          id: "worker",
          description: "Worker",
          setup: {
            model,
            instructions: "WORKER",
            tools: ["message_parent", "report", "hold"],
          },
        },
      ],
      tools: ["message_parent", "report", "hold"],
      environment: environment(release),
      maxDepth: 1,
      maxConcurrent: 2,
    },
  });
  let workId: TaskId | undefined;
  async function launch() {
    const ticket = await startTicket(core, {
      agent: "worker",
      title: "Progress",
      content: "Work",
      key: "progress",
    });
    workId = await assignment(core, ticket);
  }
  async function record() {
    if (workId === undefined) {
      throw new Error("Not launched");
    }
    return core.harness.getTask(workId, context);
  }
  async function inspect() {
    const router = await core.router.routerConversation(context);
    const view = (await listWork(() => core.harness, router)).find(
      (value) => value.id === workId,
    );
    const scope = await core.harness.snapshot(
      WorkScope,
      await ticketConversation(core, "k1"),
      context,
    );
    return {
      status: view?.status,
      question: scope?.question?.text,
      progress: scope?.progress ?? undefined,
    };
  }
  return {
    core,
    launch,
    record,
    inspect,
    busy,
    entered,
    release,
    routerBatches,
  };
}

it("delivers nonblocking progress while WORK keeps running, then completes", async () => {
  let turn = 0;
  const lifecycle = await fixture({
    worker: async () => {
      turn++;
      if (turn === 1) {
        return call("message_parent", {
          kind: "progress",
          text: "publishing now",
        });
      }
      if (turn === 2) {
        return call("hold", {});
      }
      return answer("Published: https://example.test/pr/1");
    },
  });
  try {
    await lifecycle.launch();
    await vi.waitFor(() => expect(lifecycle.entered).toHaveBeenCalledOnce());
    const progressed = await ticketWhen(lifecycle.core, "k1", (ticket) =>
      ticket.reports.some((report) => report.state === "progress"),
    );
    expect(progressed.reports).toMatchObject([
      { state: "progress", summary: "publishing now" },
    ]);
    expect(progressed.status).toBe("running");
    expect(await lifecycle.inspect()).toEqual({
      status: "running",
      question: undefined,
      progress: "publishing now",
    });
    expect(JSON.stringify((await lifecycle.record())?.state)).not.toContain(
      '"awaiting":"reply"',
    );
    await settle(lifecycle.core);
    expect(lifecycle.routerBatches).toEqual([]);
    lifecycle.busy.release();
    await vi.waitFor(async () =>
      expect((await lifecycle.record())?.state).toMatchObject({
        status: "terminal",
        outcome: {
          status: "completed",
          result: {
            status: "completed",
            text: "Published: https://example.test/pr/1",
          },
        },
      }),
    );
    await vi.waitFor(() => expect(lifecycle.routerBatches).toHaveLength(1));
    expect(lifecycle.routerBatches[0]).toContain('state=\\"ready\\"');
    expect(lifecycle.routerBatches[0]).toContain("publishing now");
    const done = await ticketWhen(
      lifecycle.core,
      "k1",
      (ticket) => ticket.status === "idle",
    );
    expect(done.reports.map((report) => report.state)).toEqual([
      "progress",
      "ready",
    ]);
    expect(lifecycle.release).toHaveBeenCalledOnce();
  } finally {
    lifecycle.busy.release();
    await lifecycle.core.close();
  }
});

it.each([
  { ask: "message_parent", kind: "question", autonomous: false },
  { ask: "message_parent", kind: undefined, autonomous: false },
  { ask: "report", kind: "waiting", autonomous: false },
  { ask: "message_parent", kind: "question", autonomous: true },
  { ask: "message_parent", kind: undefined, autonomous: true },
  { ask: "report", kind: "waiting", autonomous: true },
])(
  "resumes questions from the owner's message or the router's context ($ask $kind, autonomous=$autonomous)",
  async ({ ask, kind, autonomous }) => {
    let turn = 0;
    const answers: string[] = [];
    const lifecycle = await fixture({
      replyOnQuestion: autonomous,
      worker: async (request) => {
        turn++;
        if (turn === 1) {
          const text = "Which branch should I publish?";
          return ask === "report"
            ? call("report", { state: "waiting", text })
            : call("message_parent", { ...(kind ? { kind } : {}), text });
        }
        if (turn === 2) {
          answers.push(JSON.stringify(request.messages.at(-1)));
          return call("hold", {});
        }
        return answer("Verified final result");
      },
    });
    try {
      await lifecycle.launch();
      if (!autonomous) {
        await vi.waitFor(async () =>
          expect((await lifecycle.record())?.state).toMatchObject({
            checkpoint: { awaiting: "reply" },
          }),
        );
        expect(await lifecycle.inspect()).toMatchObject({
          status: "awaiting-reply",
          question: "Which branch should I publish?",
        });
        const asked = await lifecycle.core.router.ticket("k1", context);
        expect(asked.reports.at(-1)).toMatchObject({
          state: "waiting",
          summary: "Which branch should I publish?",
        });
        expect(turn).toBe(1);
        expect(
          (
            await receive(lifecycle.core, "User answer: main", {
              thread: "test:ticket:progress",
            })
          ).path,
        ).toBe("tickets");
      }
      await vi.waitFor(() => expect(lifecycle.entered).toHaveBeenCalledOnce());
      expect(answers[0]).toContain(
        autonomous ? "Context answer: main" : "User answer: main",
      );
      expect(await lifecycle.inspect()).toMatchObject({ status: "running" });
      lifecycle.busy.release();
      await vi.waitFor(async () =>
        expect((await lifecycle.record())?.state).toMatchObject({
          status: "terminal",
          outcome: { result: { text: "Verified final result" } },
        }),
      );
      const done = await ticketWhen(
        lifecycle.core,
        "k1",
        (ticket) => ticket.status === "idle",
      );
      expect(done.assignments).toHaveLength(1);
    } finally {
      lifecycle.busy.release();
      await lifecycle.core.close();
    }
  },
);

it("routes child progress to its WORK parent without stopping the child", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const gate = latch();
  let childTurns = 0;
  const received: string[] = [];
  const hold = defineTool({
    name: "hold",
    description: "Hold child",
    parameters: Type.Object({}),
    execute: async () => {
      await gate.promise;
      return { content: [{ type: "text", text: "continue" }] };
    },
  });
  faux.setResponses(
    Array.from({ length: 60 }, () => async (request) => {
      const system = getCurrentSystemPrompt(request.messages);
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      const content = JSON.stringify(last?.content);
      if (isRouterRequest(request)) {
        return answer("ACK");
      }
      if (system.includes("CHILD PROFILE")) {
        if (++childTurns === 1) {
          return call("message_parent", {
            kind: "progress",
            text: "publishing child output",
          });
        }
        if (childTurns === 2) {
          return call("hold", {});
        }
        return answer("Published child output");
      }
      if (system.includes("PARENT PROFILE")) {
        if (last?.role === "user" && content.includes("Coordinate")) {
          return call("start_work", {
            agent: "child",
            title: "Child",
            brief: "Work",
          });
        }
        if (last?.role === "user" && content.includes("progress (not a")) {
          received.push(content);
        }
        return answer(
          content.includes("finished")
            ? "Verified parent report"
            : "Waiting for child",
        );
      }
      return answer("ACK");
    }),
  );
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant: {
      model,
      instructions: "ROUTER",
      tools: [...ROUTER_ASSISTANT_TOOLS],
    },
    extensions: [{ durable: defineExtension({ name: "hold", tools: [hold] }) }],
    work: {
      agents: [
        {
          id: "parent",
          description: "Parent",
          setup: {
            model,
            instructions: "PARENT PROFILE",
            tools: ["start_work"],
          },
        },
        {
          id: "child",
          description: "Child",
          setup: {
            model,
            instructions: "CHILD PROFILE",
            tools: ["message_parent", "hold"],
          },
        },
      ],
      tools: ["start_work", "message_parent", "hold"],
      maxDepth: 2,
      maxConcurrent: 3,
    },
  });
  try {
    await startTicket(core, {
      agent: "parent",
      title: "Parent",
      content: "Coordinate",
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(childTurns).toBe(2);
    const records = await core.harness.commit(
      (tx) => tx.scanTasks({ kind: "kaeno.work" }, 10),
      context,
    );
    const child = records.items.find((record) =>
      JSON.stringify(record.input).includes('"agent":"child"'),
    );
    expect(child?.state).toMatchObject({ checkpoint: { phase: "supervise" } });
    expect(JSON.stringify(child?.state)).not.toContain('"awaiting":"reply"');
    gate.release();
    await vi.waitFor(async () => {
      const all = await core.harness.commit(
        (tx) => tx.scanTasks({ kind: "kaeno.work" }, 10),
        context,
      );
      expect(
        all.items.every((record) => record.state.status === "terminal"),
      ).toBe(true);
    });
  } finally {
    gate.release();
    await core.close();
  }
});
