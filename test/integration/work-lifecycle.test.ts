import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  defineExtension,
  defineTool,
  MemoryStorage,
  type TaskId,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  openKaeno,
  type WorkEnvironment,
} from "../../src/core/application/index.ts";

async function fixture(
  mode: "final" | "paused" | "busy" | "tree",
  observerThrows = false,
  cleanupGate?: Promise<void>,
  storage?: Storage,
) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: "faux", modelId: "faux-1" };
  const errors: unknown[] = [];
  let lost: string | undefined;
  let transportError = false;
  let workId: TaskId | undefined;
  const workIds: TaskId[] = [];
  let toolStarted = false;
  let toolStopped = false;
  const release = vi
    .fn<WorkEnvironment["release"]>()
    .mockImplementation(async () => {
      await cleanupGate;
      throw new Error("DELETE forbidden");
    });
  const check = vi
    .fn<NonNullable<WorkEnvironment["check"]>>()
    .mockImplementation(async (work) => {
      if (transportError) {
        throw new Error("health API unavailable");
      }
      return work.workId === workId ? lost : undefined;
    });
  const block = defineTool({
    name: "block",
    description: "Wait until cancelled",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_input, _api, ctx) => {
      toolStarted = true;
      try {
        await new Promise<void>((_resolve, reject) => {
          const signal = ctx.abortSignal;
          if (!signal) {
            throw new Error("Missing tool cancellation signal");
          }
          signal.throwIfAborted();
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      } finally {
        toolStopped = true;
      }
      return { content: [{ type: "text", text: "stopped" }] };
    },
  });
  faux.setResponses(
    Array.from({ length: 40 }, () => async (request) => {
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      if (
        getCurrentSystemPrompt(request.messages).includes("You are Kaeno WORK")
      ) {
        if (mode === "final") {
          return fauxAssistantMessage("VERIFIED FINAL REPORT");
        }
        if (
          mode === "tree" &&
          !getCurrentSystemPrompt(request.messages).includes("CHILD")
        ) {
          return request.messages.some(
            (message) =>
              message.role === "toolResult" &&
              message.toolName === "start_work",
          )
            ? fauxAssistantMessage("Waiting for child")
            : fauxAssistantMessage(
                [
                  fauxToolCall("start_work", {
                    agent: "child",
                    title: "Child",
                    brief: "Ask a question",
                  }),
                ],
                { stopReason: "toolUse" },
              );
        }
        return fauxAssistantMessage(
          [
            fauxToolCall(
              mode === "paused" ? "message_parent" : "block",
              mode === "paused" ? { text: "Which option?" } : {},
            ),
          ],
          { stopReason: "toolUse" },
        );
      }
      if (
        last?.role === "user" &&
        JSON.stringify(last.content).includes("launch-work")
      ) {
        return fauxAssistantMessage(
          [
            fauxToolCall("start_work", {
              agent: "worker",
              title: "Work",
              brief: "Do work",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage(
        JSON.stringify(last?.content).includes("finished")
          ? "FINAL DELIVERED"
          : "ACK",
      );
    }),
  );
  const core = await openKaeno({
    storage: storage ?? new MemoryStorage(),
    models,
    assistant: { model, instructions: "CHAT", tools: ["start_work"] },
    extensions: [
      { durable: defineExtension({ name: "lifecycle-test", tools: [block] }) },
    ],
    work: {
      agents: [
        {
          id: "worker",
          description: "Worker",
          setup: {
            model,
            instructions: "WORKER",
            tools: ["message_parent", "block", "start_work"],
          },
        },
        {
          id: "child",
          description: "Child",
          setup: {
            model,
            instructions: "CHILD",
            tools: ["message_parent", "block"],
          },
        },
      ],
      tools: ["message_parent", "block", "start_work"],
      maxConcurrent: 3,
      environment: {
        identity: "test:lifecycle",
        cwd: "/workspace",
        ensure: async (work) => {
          workId ??= work.workId;
          if (!workIds.includes(work.workId)) {
            workIds.push(work.workId);
          }
        },
        check,
        release,
        reconcile: async () => {},
        executionEnvironment: async () => undefined,
      },
    },
    onReport: (error) => {
      errors.push(error);
      if (observerThrows) {
        throw new Error("observer failed");
      }
    },
  });
  const conversationId =
    await core.threads.getOrCreateConversation("lifecycle");
  const turn = await core.harness.commit(
    (tx) =>
      core.turns.admitUserTurn(tx, conversationId, "launch-work", "launch"),
    context,
  );
  await core.harness.waitForTask(turn, context);
  async function id() {
    await vi.waitFor(() => expect(workId).toBeDefined());
    if (workId === undefined) {
      throw new Error("Missing work");
    }
    return workId;
  }
  return {
    core,
    conversationId,
    release,
    check,
    errors,
    id,
    lose: () => {
      lost = "sandbox Failed (DeadlineExceeded)";
    },
    transport: (value: boolean) => {
      transportError = value;
    },
    workIds,
    toolStarted: () => toolStarted,
    toolStopped: () => toolStopped,
  };
}

it.each([false, true])(
  "delivers a final report exactly once despite cleanup failure (observer throws: %s)",
  async (observerThrows) => {
    const rig = await fixture("final", observerThrows);
    try {
      const id = await rig.id();
      const outcome = await rig.core.harness.waitForTask(id, context);
      expect(JSON.stringify(outcome)).toContain("VERIFIED FINAL REPORT");
      await vi.waitFor(() => {
        expect(rig.release).toHaveBeenCalledTimes(1);
        expect(String(rig.errors[0])).toContain("cleanup deferred");
      });
      await vi.waitFor(async () => {
        const replies = (
          await rig.core.turns.readReplies(rig.conversationId, 0)
        ).replies;
        expect(
          replies.filter((reply) => reply.text === "FINAL DELIVERED"),
        ).toHaveLength(1);
      });
    } finally {
      await rig.core.close();
    }
  },
);

it("finishes cancellation despite resource cleanup failure", async () => {
  const rig = await fixture("paused");
  try {
    const id = await rig.id();
    await vi.waitFor(async () => {
      expect(
        JSON.stringify((await rig.core.harness.getTask(id, context))?.state),
      ).toContain('"awaiting":"reply"');
    });
    await rig.core.harness.abortTask(id, context);
    expect(
      JSON.stringify(await rig.core.harness.waitForTask(id, context)),
    ).toContain("aborted");
    await vi.waitFor(() => {
      expect(rig.release).toHaveBeenCalledTimes(1);
      expect(String(rig.errors[0])).toContain("cleanup deferred");
    });
  } finally {
    await rig.core.close();
  }
});

it.each(["paused", "busy"] as const)(
  "settles sandbox loss and aborts an active conversation while %s",
  async (mode) => {
    const rig = await fixture(mode);
    try {
      const id = await rig.id();
      await vi.waitFor(async () => {
        if (mode === "busy") {
          expect(rig.toolStarted()).toBe(true);
        } else {
          expect(
            JSON.stringify(
              (await rig.core.harness.getTask(id, context))?.state,
            ),
          ).toContain('"awaiting":"reply"');
        }
      });
      rig.lose();
      await vi.waitFor(
        async () => {
          const record = await rig.core.harness.getTask(id, context);
          expect(record?.state.status).toBe("terminal");
          expect(JSON.stringify(record?.state)).toContain("DeadlineExceeded");
          expect(JSON.stringify(record?.state)).toContain('"status":"failed"');
        },
        { timeout: 7000 },
      );
      if (mode === "busy") {
        expect(rig.toolStopped()).toBe(true);
      }
      expect(rig.release).toHaveBeenCalledTimes(1);
      await vi.waitFor(async () => {
        const replies = (
          await rig.core.turns.readReplies(rig.conversationId, 0)
        ).replies;
        expect(
          replies.filter((reply) => reply.text === "FINAL DELIVERED"),
        ).toHaveLength(1);
      });
    } finally {
      await rig.core.close();
    }
  },
);

it("retries transient health errors without failing paused work; shutdown cancels the monitor", async () => {
  const rig = await fixture("paused");
  const id = await rig.id();
  try {
    await vi.waitFor(async () => {
      expect(
        JSON.stringify((await rig.core.harness.getTask(id, context))?.state),
      ).toContain('"awaiting":"reply"');
    });
    rig.transport(true);
    await vi.waitFor(
      () =>
        expect(
          rig.errors.some((error) =>
            String(error).includes("health API unavailable"),
          ),
        ).toBe(true),
      { timeout: 7000 },
    );
    expect((await rig.core.harness.getTask(id, context))?.state.status).toBe(
      "running",
    );
    rig.transport(false);
    const checks = rig.check.mock.calls.length;
    await vi.waitFor(
      () => expect(rig.check.mock.calls.length).toBeGreaterThan(checks),
      { timeout: 7000 },
    );
    expect((await rig.core.harness.getTask(id, context))?.state.status).toBe(
      "running",
    );
  } finally {
    await rig.core.close();
  }
  expect(rig.release).not.toHaveBeenCalled();
  const checks = rig.check.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(rig.check).toHaveBeenCalledTimes(checks);
});

it("settles descendants before reporting parent sandbox loss even when every release fails", async () => {
  const rig = await fixture("tree");
  try {
    const root = await rig.id();
    await vi.waitFor(async () => {
      expect(rig.workIds).toHaveLength(2);
      expect(rig.toolStarted()).toBe(true);
      expect(
        JSON.stringify((await rig.core.harness.getTask(root, context))?.state),
      ).toContain('"awaiting":"children"');
    });
    rig.lose();
    await vi.waitFor(
      async () => {
        for (const id of rig.workIds) {
          expect(
            (await rig.core.harness.getTask(id, context))?.state.status,
          ).toBe("terminal");
        }
      },
      { timeout: 7000 },
    );
    expect(
      JSON.stringify((await rig.core.harness.getTask(root, context))?.state),
    ).toContain("DeadlineExceeded");
    const child = rig.workIds.find((id) => id !== root);
    if (child === undefined) {
      throw new Error("Missing child");
    }
    expect(
      JSON.stringify((await rig.core.harness.getTask(child, context))?.state),
    ).toContain("aborted");
    expect(rig.toolStopped()).toBe(true);
    expect(rig.release).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => {
      expect(
        (
          await rig.core.turns.readReplies(rig.conversationId, 0)
        ).replies.filter((reply) => reply.text === "FINAL DELIVERED"),
      ).toHaveLength(1);
    });
  } finally {
    await rig.core.close();
  }
});

it("commits and delivers the report before a stuck cleanup backend returns", async () => {
  const gate = Promise.withResolvers<void>();
  const rig = await fixture("final", false, gate.promise);
  try {
    const id = await rig.id();
    expect(
      JSON.stringify(await rig.core.harness.waitForTask(id, context)),
    ).toContain("VERIFIED FINAL REPORT");
    await vi.waitFor(async () => {
      expect(rig.release).toHaveBeenCalledTimes(1);
      expect(
        (
          await rig.core.turns.readReplies(rig.conversationId, 0)
        ).replies.filter((reply) => reply.text === "FINAL DELIVERED"),
      ).toHaveLength(1);
    });
    expect(rig.errors).toHaveLength(0);
  } finally {
    gate.resolve();
    await rig.core.close();
  }
});

it("does not duplicate an already committed final report after SQLite reopen with cleanup pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-report-cleanup-"));
  const database = join(directory, "db.sqlite");
  try {
    const first = await fixture(
      "final",
      false,
      undefined,
      await openNodeSqliteStorage(database),
    );
    try {
      await first.core.harness.waitForTask(await first.id(), context);
      await vi.waitFor(async () => {
        expect(
          first.errors.some((error) =>
            String(error).includes("cleanup deferred"),
          ),
        ).toBe(true);
        expect(
          (
            await first.core.turns.readReplies(first.conversationId, 0)
          ).replies.filter((reply) => reply.text === "FINAL DELIVERED"),
        ).toHaveLength(1);
      });
    } finally {
      await first.core.close();
    }
    const reopened = await fixture(
      "final",
      false,
      undefined,
      await openNodeSqliteStorage(database),
    );
    try {
      expect(reopened.release).not.toHaveBeenCalled();
      expect(
        (
          await reopened.core.turns.readReplies(reopened.conversationId, 0)
        ).replies.filter((reply) => reply.text === "FINAL DELIVERED"),
      ).toHaveLength(1);
    } finally {
      await reopened.core.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("commits cancellation before a stuck cleanup backend returns", async () => {
  const gate = Promise.withResolvers<void>();
  const rig = await fixture("paused", false, gate.promise);
  try {
    const id = await rig.id();
    await vi.waitFor(async () => {
      expect(
        JSON.stringify((await rig.core.harness.getTask(id, context))?.state),
      ).toContain('"awaiting":"reply"');
    });
    await rig.core.harness.abortTask(id, context);
    expect(
      JSON.stringify(await rig.core.harness.waitForTask(id, context)),
    ).toContain("aborted");
    await vi.waitFor(() => expect(rig.release).toHaveBeenCalledTimes(1));
    expect(rig.errors).toHaveLength(0);
  } finally {
    gate.resolve();
    await rig.core.close();
  }
});
