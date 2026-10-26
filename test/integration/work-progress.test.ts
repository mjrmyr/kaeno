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
import { z } from "zod";
import {
  openKaeno,
  type WorkEnvironment,
} from "../../src/core/application/index.ts";

const model = { provider: "faux", modelId: "faux-1" };
const orchestration = ["start_work", "inspect_work", "message_work"];
let nextRequest = 0;
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
/** CHAT launches one worker and acts on keywords; any other input is recorded as a result turn. */
async function fixture(options: {
  worker: FauxResponseFactory;
  replyOnResult?: boolean;
}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const busy = latch();
  const entered = vi.fn<() => void>();
  const release = vi.fn<WorkEnvironment["release"]>();
  const resultInputs: string[] = [];
  let workId: TaskId | undefined;
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
      if (getCurrentSystemPrompt(request.messages).includes("WORKER")) {
        return options.worker(...args);
      }
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      if (last?.role === "toolResult") {
        return answer(
          last.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join(""),
        );
      }
      const content = JSON.stringify(last?.content);
      if (content.includes("launch")) {
        return call("start_work", {
          agent: "worker",
          title: "Progress",
          brief: "Work",
        });
      }
      if (workId === undefined) {
        throw new Error("No work to address");
      }
      if (content.includes("inspect-now")) {
        return call("inspect_work", { id: workId });
      }
      if (content.includes("reply-now")) {
        return call("message_work", { id: workId, text: "User answer: main" });
      }
      resultInputs.push(content);
      return options.replyOnResult && content.includes("waits for a reply")
        ? call("message_work", { id: workId, text: "Context answer: main" })
        : answer("RESULT OBSERVED");
    }),
  );
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant: { model, instructions: "CHAT", tools: orchestration },
    extensions: [{ durable: defineExtension({ name: "hold", tools: [hold] }) }],
    work: {
      agents: [
        {
          id: "worker",
          description: "Worker",
          setup: {
            model,
            instructions: "WORKER",
            tools: ["message_parent", "hold"],
          },
        },
      ],
      tools: [...orchestration, "message_parent", "hold"],
      environment: environment(release),
      maxDepth: 1,
      maxConcurrent: 2,
    },
  });
  const chat = await core.threads.getOrCreateConversation("progress");
  async function user(text: string) {
    const request = `user:${++nextRequest}`;
    const id = await core.harness.commit(
      (tx) => core.turns.admitUserTurn(tx, chat, text, request),
      context,
    );
    await core.harness.waitForTask(id, context);
    const { replies } = await core.turns.readReplies(chat, 0);
    return replies.find((reply) => reply.requestId === request)?.text;
  }
  async function launch() {
    await user("launch");
    const page = await core.harness.commit(
      (tx) => tx.scanTasks({ kind: "kaeno.work" }, 10),
      context,
    );
    workId = page.items[0].id;
  }
  async function record() {
    if (workId === undefined) {
      throw new Error("Not launched");
    }
    return core.harness.getTask(workId, context);
  }
  async function inspect() {
    return z
      .object({
        status: z.string(),
        message: z.string().optional(),
        latest: z.string().optional(),
        progress: z.string().optional(),
        pendingQuestion: z
          .object({ id: z.number(), text: z.string(), askedAt: z.number() })
          .optional(),
      })
      .parse(JSON.parse((await user("inspect-now")) ?? "null"));
  }
  return {
    core,
    chat,
    user,
    launch,
    record,
    inspect,
    busy,
    entered,
    release,
    resultInputs,
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
    await vi.waitFor(() =>
      expect(
        lifecycle.resultInputs.some((input) =>
          input.includes("publishing now"),
        ),
      ).toBe(true),
    );
    const details = await lifecycle.inspect();
    expect(details).toMatchObject({
      status: "running",
      progress: "publishing now",
    });
    expect(details).not.toHaveProperty("pendingQuestion");
    expect(JSON.stringify((await lifecycle.record())?.state)).not.toContain(
      '"awaiting":"reply"',
    );
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
    // One progress turn and one final report; progress is never redelivered.
    expect(
      lifecycle.resultInputs.filter((input) =>
        input.includes("publishing now"),
      ),
    ).toHaveLength(1);
    expect(lifecycle.release).toHaveBeenCalledOnce();
  } finally {
    lifecycle.busy.release();
    await lifecycle.core.close();
  }
});

it.each([
  { kind: "question", autonomous: false },
  { kind: undefined, autonomous: false },
  { kind: "question", autonomous: true },
  { kind: undefined, autonomous: true },
])(
  "resumes questions from user input or autonomously from context ($kind, autonomous=$autonomous)",
  async ({ kind, autonomous }) => {
    let turn = 0;
    const lifecycle = await fixture({
      replyOnResult: autonomous,
      worker: async () => {
        turn++;
        if (turn === 1) {
          return call("message_parent", {
            ...(kind ? { kind } : {}),
            text: "Which branch should I publish?",
          });
        }
        if (turn === 2) {
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
          message: "Which branch should I publish?",
          pendingQuestion: {
            id: expect.any(Number),
            text: "Which branch should I publish?",
            askedAt: expect.any(Number),
          },
        });
        expect(turn).toBe(1);
        await lifecycle.user("reply-now");
      }
      await vi.waitFor(() => expect(lifecycle.entered).toHaveBeenCalledOnce());
      const resumed = await lifecycle.inspect();
      expect(resumed).toMatchObject({ status: "running" });
      expect(resumed).not.toHaveProperty("pendingQuestion");
      expect(resumed).not.toHaveProperty("message");
      lifecycle.busy.release();
      await vi.waitFor(async () =>
        expect((await lifecycle.record())?.state).toMatchObject({
          status: "terminal",
          outcome: { result: { text: "Verified final result" } },
        }),
      );
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
      if (last?.role === "user" && content.includes("launch")) {
        return call("start_work", {
          agent: "parent",
          title: "Parent",
          brief: "Coordinate",
        });
      }
      return answer("ACK");
    }),
  );
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant: { model, instructions: "CHAT", tools: ["start_work"] },
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
    const chat = await core.threads.getOrCreateConversation("tree");
    const turn = await core.harness.commit(
      (tx) => core.turns.admitUserTurn(tx, chat, "launch", "launch"),
      context,
    );
    await core.harness.waitForTask(turn, context);
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
