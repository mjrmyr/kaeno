import { z } from "zod";
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
  hook,
  ToolTask,
  wrapTool,
  MemoryStorage,
  type TaskId,
  type JsonObject,
  type Storage,
} from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import {
  openKaeno,
  type WorkEnvironment,
} from "../../src/core/application/index.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkScope } from "../../src/core/work/index.ts";

const model = { provider: "faux", modelId: "faux-1" };
let nextRequest = 0;
const orchestration = [
  "start_work",
  "inspect_work",
  "message_work",
  "cancel_work",
];
function call(name: string, args: JsonObject) {
  return answer([fauxToolCall(name, args)], { stopReason: "toolUse" });
}
function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(options: {
  worker: FauxResponseFactory;
  environment?: WorkEnvironment;
  storage?: Storage;
  mutateOnResult?: boolean;
  pauseQuestionReply?: boolean;
}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const busy = latch();
  const questionEntered = latch();
  const questionFinish = latch();
  const dispatchEntered = latch();
  const dispatch = latch();
  const entered = vi.fn<() => void>();
  let workId: TaskId | undefined;
  const resultInputs: string[] = [];
  const hold = defineTool({
    name: "hold",
    description: "Keep WORK executing while its progress is inspected",
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
          title: "Lifecycle",
          brief: "Work",
        });
      }
      if (workId === undefined) {
        const page = await core.harness.commit(
          (tx) => tx.scanTasks({ kind: "kaeno.work" }, 10),
          context,
        );
        workId = page.items[0]?.id;
      }
      if (workId === undefined) {
        throw new Error("No work to address");
      }
      if (content.includes("inspect-now")) {
        return call("inspect_work", { id: workId });
      }
      if (content.includes("reply-now")) {
        return call("message_work", {
          id: workId,
          text: "User answer: proceed",
        });
      }
      if (content.includes("cancel-now")) {
        return call("cancel_work", { id: workId });
      }
      resultInputs.push(content);
      if (options.mutateOnResult) {
        return call("message_work", {
          id: workId,
          text: "Untrusted result must not resume work",
        });
      }
      return answer("RESULT OBSERVED");
    }),
  );
  // Match the registered tool by name to pause only its dispatch, after the
  // real message_work admission commit; this exercises the crash-window state.
  const steering = defineTool({
    name: "message_work",
    description: "Steering surface",
    parameters: Type.Object({ id: Type.Integer(), text: Type.String() }),
    execute: async () => {
      throw new Error("Only the installed tool should execute");
    },
  });
  const holdExtension = defineExtension({
    name: "hold",
    tools: [hold],
    hooks: [
      hook(ToolTask, {
        afterTool: async (call, result) => {
          if (options.pauseQuestionReply && call.name === "message_parent") {
            questionEntered.release();
            await questionFinish.promise;
          }
          return result;
        },
      }),
    ],
    wraps: [
      wrapTool(steering, (tool) => ({
        ...tool,
        execute: async (args, api, ctx) => {
          if (!options.pauseQuestionReply) {
            return tool.execute(args, api, ctx);
          }
          const delayed = new Proxy(api, {
            get(target, key, receiver) {
              if (key === "conversation") {
                return async (
                  ...args: Parameters<typeof target.conversation>
                ) => {
                  const conversation = await target.conversation(...args);
                  return (
                    conversation &&
                    new Proxy(conversation, {
                      get(handle, key, receiver) {
                        if (key === "submit") {
                          return async (
                            ...args: Parameters<typeof handle.submit>
                          ) => {
                            dispatchEntered.release();
                            await dispatch.promise;
                            return handle.submit(...args);
                          };
                        }
                        return Reflect.get(handle, key, receiver);
                      },
                    })
                  );
                };
              }
              return Reflect.get(target, key, receiver);
            },
          });
          return tool.execute(args, delayed, ctx);
        },
      })),
    ],
  });
  const core = await openKaeno({
    storage: options.storage ?? new MemoryStorage(),
    models,
    assistant: {
      model,
      instructions: "CHAT",
      tools: orchestration,
      bindings: [{ owner: "hold", version: 1, value: null }],
    },
    extensions: [{ durable: holdExtension }],
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
      environment: options.environment,
      maxDepth: 1,
      maxConcurrent: 2,
    },
  });
  const chat = await core.threads.getOrCreateConversation("lifecycle");
  const existing = await core.harness.commit(
    (tx) => tx.scanTasks({ kind: "kaeno.work" }, 10),
    context,
  );
  workId = existing.items[0]?.id;
  async function user(text: string) {
    const request = ++nextRequest;
    const id = await core.harness.commit(
      (tx) => core.turns.admitUserTurn(tx, chat, text, `user:${request}`),
      context,
    );
    await core.harness.waitForTask(id, context);
    const { replies } = await core.turns.readReplies(chat, 0);
    return replies.find((reply) => reply.requestId === `user:${request}`)?.text;
  }
  async function launch() {
    await user("launch");
    const page = await core.harness.commit(
      (tx) => tx.scanTasks({ kind: "kaeno.work" }, 10),
      context,
    );
    workId = page.items[0].id;
    return workId;
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
        cleanupError: z.string().optional(),
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
    resultInputs,
    questionEntered,
    questionFinish,
    dispatchEntered,
    dispatch,
  };
}
function environment(
  overrides: Partial<WorkEnvironment> = {},
): WorkEnvironment {
  return {
    cwd: "/workspace",
    ensure: async () => {},
    release: async () => {},
    reconcile: async () => {},
    executionEnvironment: async () => undefined,
    ...overrides,
  };
}

it("delivers nonblocking progress while WORK is busy, then finishes and releases after durable notification", async () => {
  let turn = 0;
  const release = vi.fn<WorkEnvironment["release"]>(async (work, runtime) => {
    const record = await runtime.commit((tx) => tx.task(work.workId), context);
    expect(record?.state).toMatchObject({
      checkpoint: {
        phase: "cleanup",
        text: "Published: https://example.test/pr/1 SHA abc123",
      },
    });
    const reports = await runtime.commit(
      (tx) => tx.scanTasks({ kind: "kaeno.turn" }, 100),
      context,
    );
    expect(
      reports.items.some((report) =>
        JSON.stringify(report.input).includes(`${work.workId}:final`),
      ),
    ).toBe(true);
  });
  const lifecycle = await fixture({
    environment: environment({ release }),
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
      return answer("Published: https://example.test/pr/1 SHA abc123");
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
    expect(await lifecycle.inspect()).toMatchObject({
      status: "running",
      progress: "publishing now",
    });
    expect(await lifecycle.inspect()).not.toHaveProperty("pendingQuestion");
    expect(release).not.toHaveBeenCalled();
    lifecycle.busy.release();
    await vi.waitFor(async () =>
      expect((await lifecycle.record())?.state).toMatchObject({
        status: "terminal",
        outcome: {
          status: "completed",
          result: {
            status: "completed",
            text: "Published: https://example.test/pr/1 SHA abc123",
          },
        },
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  } finally {
    lifecycle.busy.release();
    await lifecycle.core.close();
  }
});

it.each(["question", undefined])(
  "retains a delivered %s question, rejects result-turn replies, and resumes only on user input",
  async (kind) => {
    let turn = 0;
    const release = vi.fn<WorkEnvironment["release"]>();
    const lifecycle = await fixture({
      mutateOnResult: true,
      environment: environment({ release }),
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
      await vi.waitFor(async () =>
        expect((await lifecycle.record())?.state).toMatchObject({
          checkpoint: { awaiting: "reply" },
        }),
      );
      await vi.waitFor(async () => {
        const { replies } = await lifecycle.core.turns.readReplies(
          lifecycle.chat,
          0,
        );
        expect(
          replies.some((reply) =>
            reply.text.includes("Assistant mutation requires a user turn"),
          ),
        ).toBe(true);
      });
      const details = await lifecycle.inspect();
      expect(details).toMatchObject({
        status: "awaiting-reply",
        message: "Which branch should I publish?",
        pendingQuestion: {
          text: "Which branch should I publish?",
          askedAt: expect.any(Number),
          id: expect.any(Number),
        },
      });
      expect(details.latest).toBeUndefined(); // Tool-call arguments are not assistant text.
      expect(turn).toBe(1);
      expect(release).not.toHaveBeenCalled();
      await lifecycle.user("reply-now");
      await vi.waitFor(() => expect(lifecycle.entered).toHaveBeenCalledOnce());
      expect(await lifecycle.inspect()).toMatchObject({ status: "running" });
      expect(await lifecycle.inspect()).not.toHaveProperty("pendingQuestion");
      expect(await lifecycle.inspect()).not.toHaveProperty("message");
      lifecycle.busy.release();
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    } finally {
      lifecycle.busy.release();
      await lifecycle.core.close();
    }
  },
);

it("keeps a genuinely blocked environment and cleans it on cancellation", async () => {
  const release = vi.fn<WorkEnvironment["release"]>();
  const reconcile = vi.fn<WorkEnvironment["reconcile"]>();
  const env = environment({ release, reconcile });
  const lifecycle = await fixture({
    environment: env,
    worker: async () =>
      call("message_parent", {
        kind: "question",
        text: "Need credentials from user",
      }),
  });
  try {
    const id = await lifecycle.launch();
    await vi.waitFor(async () =>
      expect((await lifecycle.record())?.state).toMatchObject({
        checkpoint: { awaiting: "reply" },
      }),
    );
    expect(release).not.toHaveBeenCalled();
    await lifecycle.user("cancel-now");
    await vi.waitFor(async () =>
      expect((await lifecycle.record())?.state).toMatchObject({
        status: "terminal",
        outcome: { status: "aborted" },
      }),
    );
    expect(release).toHaveBeenCalledOnce();
    expect(release.mock.calls[0][0].workId).toBe(id);
    expect(await lifecycle.inspect()).not.toHaveProperty("pendingQuestion");
    expect(await lifecycle.inspect()).not.toHaveProperty("message");
  } finally {
    await lifecycle.core.close();
  }
});

it("restores a pending question and preserves its sandbox across restart/reconciliation without auto-resuming", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-question-"));
  const path = join(directory, "state.sqlite");
  const release = vi.fn<WorkEnvironment["release"]>();
  const reconcile = vi.fn<WorkEnvironment["reconcile"]>();
  const env = environment({ release, reconcile });
  let lifecycle = await fixture({
    storage: await openNodeSqliteStorage(path),
    environment: env,
    worker: async () =>
      call("message_parent", {
        kind: "question",
        text: "Choose target branch",
      }),
  });
  try {
    const id = await lifecycle.launch();
    await vi.waitFor(async () =>
      expect((await lifecycle.record())?.state).toMatchObject({
        checkpoint: { awaiting: "reply" },
      }),
    );
    const before = await lifecycle.inspect();
    await lifecycle.core.close();
    const resumedWorker = vi.fn<FauxResponseFactory>(async () =>
      answer("Published durable result"),
    );
    lifecycle = await fixture({
      storage: await openNodeSqliteStorage(path),
      environment: env,
      worker: resumedWorker,
    });
    expect((await lifecycle.inspect()).pendingQuestion).toEqual(
      before.pendingQuestion,
    );
    expect(resumedWorker).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(reconcile.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ workId: id }),
    ]);
    await lifecycle.user("reply-now");
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(resumedWorker).toHaveBeenCalledOnce();
  } finally {
    await lifecycle.core.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("retries interrupted cleanup on restart without rerunning WORK or redelivering its report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-cleanup-"));
  const path = join(directory, "state.sqlite");
  const gate = latch();
  const release = vi.fn<WorkEnvironment["release"]>(async () => {
    await gate.promise;
  });
  let lifecycle = await fixture({
    storage: await openNodeSqliteStorage(path),
    environment: environment({ release }),
    worker: async () =>
      answer("Artifact URL https://example.test/result SHA 012345"),
  });
  try {
    await lifecycle.launch();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    const closing = lifecycle.core.close();
    // Shutdown fences the in-flight phase commit; its persisted cleanup checkpoint remains.
    await new Promise((resolve) => setTimeout(resolve, 25));
    gate.release();
    await closing;
    const worker = vi.fn<FauxResponseFactory>(async () =>
      answer("must not run"),
    );
    const retriedRelease = vi.fn<WorkEnvironment["release"]>(async () => {});
    lifecycle = await fixture({
      storage: await openNodeSqliteStorage(path),
      environment: environment({ release: retriedRelease }),
      worker,
    });
    await vi.waitFor(async () =>
      expect((await lifecycle.record())?.state).toMatchObject({
        status: "terminal",
        outcome: {
          result: {
            text: "Artifact URL https://example.test/result SHA 012345",
          },
        },
      }),
    );
    expect(retriedRelease).toHaveBeenCalledOnce();
    expect(worker).not.toHaveBeenCalled();
    const reports = await lifecycle.core.harness.commit(
      (tx) => tx.scanTasks({ kind: "kaeno.turn" }, 100),
      context,
    );
    expect(
      reports.items.filter((record) =>
        JSON.stringify(record.input).includes(":final"),
      ),
    ).toHaveLength(1);
  } finally {
    gate.release();
    await lifecycle.core.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("routes child progress to its WORK parent without stopping the child or requiring a reply", async () => {
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
        if (
          last?.role === "user" &&
          content.includes("progress (not a question")
        ) {
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

it.each([false, true])(
  "retries transient environment removal without faulting or rerunning WORK (cancel=%s)",
  async (cancel) => {
    let attempts = 0;
    const release = vi.fn<WorkEnvironment["release"]>(async () => {
      if (++attempts === 1) {
        throw new Error("temporary sandbox removal failure");
      }
    });
    const worker = vi.fn<FauxResponseFactory>(async () =>
      cancel
        ? call("message_parent", {
            kind: "question",
            text: "User decision needed",
          })
        : answer("Verified durable result"),
    );
    const lifecycle = await fixture({
      environment: environment({ release }),
      worker,
    });
    try {
      await lifecycle.launch();
      if (cancel) {
        await vi.waitFor(async () =>
          expect((await lifecycle.record())?.state).toMatchObject({
            checkpoint: { awaiting: "reply" },
          }),
        );
        await lifecycle.user("cancel-now");
      }
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
      expect(await lifecycle.inspect()).toMatchObject({
        status: cancel ? "cancelling" : "finishing",
        cleanupError: "Error: temporary sandbox removal failure",
      });
      await vi.waitFor(
        async () =>
          expect((await lifecycle.record())?.state).toMatchObject({
            status: "terminal",
            outcome: { status: cancel ? "aborted" : "completed" },
          }),
        { timeout: 7000 },
      );
      expect(release).toHaveBeenCalledTimes(2);
      expect(worker).toHaveBeenCalledOnce();
      if (!cancel) {
        expect(
          lifecycle.resultInputs.filter((input) => input.includes("finished.")),
        ).toHaveLength(1);
      }
    } finally {
      await lifecycle.core.close();
    }
  },
);

it("preserves the question boundary when reply admission precedes supervisor consumption and dispatch", async () => {
  let turn = 0;
  const release = vi.fn<WorkEnvironment["release"]>();
  const lifecycle = await fixture({
    pauseQuestionReply: true,
    environment: environment({ release }),
    worker: async () => {
      return ++turn === 1
        ? call("message_parent", {
            kind: "question",
            text: "Choose publication target",
          })
        : answer("Verified published result");
    },
  });
  try {
    const id = await lifecycle.launch();
    await lifecycle.questionEntered.promise;
    const replying = lifecycle.user("reply-now");
    await lifecycle.dispatchEntered.promise;
    const conversation = await lifecycle.core.harness.commit(
      (tx) => tx.scanConversations({ ownerTaskId: id }, 1),
      context,
    );
    const scope = await lifecycle.core.harness.snapshot(
      WorkScope,
      conversation.items[0].id,
      context,
    );
    expect(scope).toMatchObject({
      message: "Choose publication target",
      question: { answered: true },
    });
    lifecycle.questionFinish.release();
    await vi.waitFor(async () =>
      expect((await lifecycle.record())?.state).toMatchObject({
        checkpoint: { phase: "supervise", seen: expect.any(Number) },
      }),
    );
    expect(release).not.toHaveBeenCalled();
    expect(turn).toBe(1);
    expect(lifecycle.resultInputs).toHaveLength(0); // Answered question is not notified as still pending.
    lifecycle.dispatch.release();
    await replying;
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect((await lifecycle.record())?.state).toMatchObject({
      status: "terminal",
      outcome: {
        result: { status: "completed", text: "Verified published result" },
      },
    });
  } finally {
    lifecycle.questionFinish.release();
    lifecycle.dispatch.release();
    await lifecycle.core.close();
  }
});
