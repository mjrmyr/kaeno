import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { getCurrentSystemPrompt, Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  defineExtension,
  defineTool,
  MemoryStorage,
  AgentDoc,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  openKaeno,
  type Participants,
  type WorkPlan,
} from "../../src/core/application/index.ts";

it("runs all-to-all delegation through core-only participant plans, keeps frozen children and exact tools", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: "faux", modelId: "faux-1" };
  let prepares = 0;
  const leafSetup = { model, instructions: "LEAF", tools: [] };
  const livePlan: WorkPlan = {
    root: "parent",
    participants: {
      parent: {
        id: "parent",
        description: "Coordinates",
        setup: { model, instructions: "PARENT", tools: ["start_work"] },
      },
      leaf: { id: "leaf", description: "Answers", setup: leafSetup },
    },
  };
  const participants: Participants = {
    list: () =>
      Object.values(livePlan.participants).map(({ id, description }) => ({
        id,
        description,
        available: true,
      })),
    plan: () => {
      prepares++;
      return livePlan;
    },
  };
  const prompts: string[] = [];
  faux.setResponses(
    Array.from({ length: 30 }, () => async (request) => {
      const system = getCurrentSystemPrompt(request.messages);
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      if (
        system.includes("PARENT") &&
        last?.role === "user" &&
        !JSON.stringify(last.content).includes("Child Work")
      ) {
        // Mutating the source after root admission must not affect the child's saved setup.
        leafSetup.instructions = "CHANGED";
        return fauxAssistantMessage(
          [
            fauxToolCall("start_work", {
              agent: "leaf",
              title: "Leaf",
              brief: "Answer",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }
      if (system.includes("PARENT")) {
        return fauxAssistantMessage(
          last?.role === "toolResult" ? "Waiting for child." : "PARENT REPORT",
        );
      }
      if (system.includes("You are Kaeno WORK")) {
        prompts.push(system);
        return fauxAssistantMessage("LEAF REPORT");
      }
      if (
        last?.role === "user" &&
        JSON.stringify(last.content).includes("launch-root")
      ) {
        return fauxAssistantMessage(
          [
            fauxToolCall("start_work", {
              agent: "parent",
              title: "Parent",
              brief: "Coordinate",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage(
        last?.role === "toolResult" ? "STARTED" : "REPORTED",
      );
    }),
  );
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant: { model, instructions: "CHAT", tools: ["start_work"] },
    work: {
      participants,
      tools: ["start_work"],
      maxDepth: 2,
      maxConcurrent: 3,
    },
  });
  try {
    const id = await core.threads.getOrCreateConversation("tree");
    const task = await core.harness.commit(
      (tx) => core.turns.admitUserTurn(tx, id, "launch-root", "root"),
      context,
    );
    await core.harness.waitForTask(task, context);
    await vi.waitFor(
      async () => {
        expect(
          (await core.turns.readReplies(id, 0)).replies.some(
            (reply) => reply.text === "REPORTED",
          ),
        ).toBe(true);
      },
      { timeout: 5000 },
    );
    expect(prepares).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("LEAF");
    expect(prompts[0]).not.toContain("CHANGED");
    const conversations = await core.harness.commit(
      (tx) => tx.scanConversations({}, 100),
      context,
    );
    const setups = await Promise.all(
      conversations.items.map((conversation) =>
        core.harness.snapshot(AgentDoc, conversation.id, context),
      ),
    );
    expect(
      setups.some(
        (setup) =>
          setup?.instructions?.startsWith("LEAF") &&
          Array.isArray(setup.tools) &&
          setup.tools.length === 0,
      ),
    ).toBe(true);
  } finally {
    await core.close();
  }
});

it.each([false, true])(
  "keeps orchestration usable and explains failed delegation with unavailable definitions (%s)",
  async (configured) => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = { provider: "faux", modelId: "faux-1" };
    const failure = configured
      ? "Agent broken is unavailable: tools are not installed/approved: missing_tool"
      : "No worker agents are configured";
    const plan = vi.fn<Participants["plan"]>(() => {
      throw new Error(failure);
    });
    const tools = [
      "start_work",
      "list_work",
      "inspect_work",
      "message_work",
      "cancel_work",
    ];
    let observedFailure = false;
    faux.setResponses([
      async (request) => {
        const prompt = getCurrentSystemPrompt(request.messages);
        expect(prompt).toContain("You support delegation with start_work");
        expect(prompt).toContain(
          configured
            ? "Unavailable agent broken: tools are not installed/approved: missing_tool"
            : "No worker agents are configured",
        );
        return fauxAssistantMessage(
          [
            fauxToolCall("start_work", {
              agent: "broken",
              title: "Attempt",
              brief: "Delegate",
            }),
            fauxToolCall("list_work", {}),
          ],
          { stopReason: "toolUse" },
        );
      },
      async (request) => {
        const results = request.messages.filter(
          (message) => message.role === "toolResult",
        );
        expect(results).toHaveLength(2);
        expect(JSON.stringify(results)).toContain(failure);
        expect(JSON.stringify(results)).toContain('"text":"[]"');
        observedFailure = true;
        return fauxAssistantMessage(
          "I support delegation, but no worker can run yet.",
        );
      },
    ]);
    const core = await openKaeno({
      storage: new MemoryStorage(),
      models,
      assistant: { model, instructions: "CHAT", tools },
      work: {
        participants: {
          list: () =>
            configured
              ? [
                  {
                    id: "broken",
                    description: "Broken worker",
                    available: false,
                    reason: "tools are not installed/approved: missing_tool",
                  },
                ]
              : [],
          plan,
        },
        tools: [],
      },
    });
    try {
      const id = await core.threads.getOrCreateConversation(
        "no-available-workers",
      );
      expect(
        (await core.harness.snapshot(AgentDoc, id, context))?.tools,
      ).toEqual(tools);
      const task = await core.harness.commit(
        (tx) => core.turns.admitUserTurn(tx, id, "Delegate this", "delegate"),
        context,
      );
      await core.harness.waitForTask(task, context);
      expect(observedFailure).toBe(true);
      expect(plan).toHaveBeenCalledTimes(configured ? 1 : 0);
      expect(
        (await core.turns.readReplies(id, 0)).replies.map(
          (reply) => reply.text,
        ),
      ).toContain("I support delegation, but no worker can run yet.");
      const tasks = await core.harness.commit(
        (tx) => tx.scanTasks({}, 100),
        context,
      );
      expect(tasks.items.filter((task) => task.kind === "kaeno.work")).toEqual(
        [],
      );
    } finally {
      await core.close();
    }
  },
);

it("fails paused preflight when an approved tool disappears from a saved unfinished tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-plan-recovery-"));
  const path = join(directory, "db.sqlite");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: "faux", modelId: "faux-1" };
  const read = defineTool({
    name: "read_test",
    description: "Test",
    parameters: Type.Object({}),
    execute: async () => ({}),
  });
  const extension = {
    durable: defineExtension({ name: "test-reader", tools: [read] }),
  };
  const participants: Participants = {
    list: () => [{ id: "worker", description: "Worker", available: true }],
    plan: () => ({
      root: "worker",
      participants: {
        worker: {
          id: "worker",
          description: "Worker",
          setup: { model, instructions: "WORKER", tools: [read.name] },
        },
      },
    }),
  };
  let ensuring = false;
  const environment = {
    cwd: "/workspace",
    ensure: async (_work: unknown, _runtime: unknown, ctx: typeof context) => {
      ensuring = true;
      await new Promise<void>((_resolve, reject) => {
        if (ctx.abortSignal?.aborted) {
          reject(ctx.abortSignal.reason);
          return;
        }
        ctx.abortSignal?.addEventListener(
          "abort",
          () => reject(ctx.abortSignal?.reason),
          { once: true },
        );
      });
    },
    release: async () => {},
    reconcile: async () => {},
    executionEnvironment: async () => undefined,
  };
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("start_work", {
          agent: "worker",
          title: "Pending",
          brief: "Wait",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("STARTED"),
  ]);
  const core = await openKaeno({
    storage: await openNodeSqliteStorage(path),
    models,
    assistant: { model, instructions: "CHAT", tools: ["start_work"] },
    extensions: [extension],
    work: { participants, tools: [read.name], environment },
  });
  try {
    const id = await core.threads.getOrCreateConversation("pending");
    const task = await core.harness.commit(
      (tx) => core.turns.admitUserTurn(tx, id, "launch", "launch"),
      context,
    );
    await core.harness.waitForTask(task, context);
    await vi.waitFor(() => expect(ensuring).toBe(true));
    await core.close();
    await expect(
      openKaeno({
        storage: await openNodeSqliteStorage(path),
        models,
        assistant: { model, instructions: "CHAT", tools: ["start_work"] },
        extensions: [extension],
        work: {
          participants: {
            list: () => [],
            plan: () => {
              throw new Error("Sources unavailable");
            },
          },
          tools: [],
          environment,
        },
      }),
    ).rejects.toThrow(/Saved WORK no longer fits/);
  } finally {
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
});
