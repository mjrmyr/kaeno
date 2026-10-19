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
import { z } from "zod";
import {
  openKaeno,
  type AgentProfile,
} from "../../src/core/application/index.ts";

it("runs all-to-all delegation through core-only agents, keeps frozen children, exact tools and the v3 stored plan", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: "faux", modelId: "faux-1" };
  const leafSetup = { model, instructions: "LEAF", tools: [] };
  const agents: AgentProfile[] = [
    {
      id: "parent",
      description: "Coordinates",
      setup: { model, instructions: "PARENT", tools: ["start_work"] },
    },
    { id: "leaf", description: "Answers", setup: leafSetup },
  ];
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
      agents,
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
    // Durable bytes are unchanged: kaeno.work v3 input keeps `agent` and `plan.participants`.
    const record = (
      await core.harness.commit((tx) => tx.scanTasks({}, 100), context)
    ).items.find(
      (task) =>
        task.kind === "kaeno.work" &&
        JSON.stringify(task.input).includes('"agent":"parent"'),
    );
    expect(record?.version).toBe(3);
    expect(record?.input).toMatchObject({
      agent: "parent",
      plan: {
        root: "parent",
        participants: {
          parent: {
            id: "parent",
            description: "Coordinates",
            setup: { model, instructions: "PARENT", tools: ["start_work"] },
          },
          leaf: { id: "leaf", description: "Answers" },
        },
      },
    });
    expect(
      Object.keys(
        z
          .object({
            plan: z.object({ participants: z.record(z.string(), z.unknown()) }),
          })
          .parse(record?.input).plan.participants,
      ),
    ).toEqual(["parent", "leaf"]);
  } finally {
    await core.close();
  }
});

it("keeps orchestration usable and explains failed delegation without configured agents", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: "faux", modelId: "faux-1" };
  const failure = "No worker agents are configured";
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
      expect(prompt).toContain("No worker agents are configured");
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
    work: { agents: [], tools: [] },
  });
  try {
    const id = await core.threads.getOrCreateConversation(
      "no-available-workers",
    );
    expect((await core.harness.snapshot(AgentDoc, id, context))?.tools).toEqual(
      tools,
    );
    const task = await core.harness.commit(
      (tx) => core.turns.admitUserTurn(tx, id, "Delegate this", "delegate"),
      context,
    );
    await core.harness.waitForTask(task, context);
    expect(observedFailure).toBe(true);
    expect(
      (await core.turns.readReplies(id, 0)).replies.map((reply) => reply.text),
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
});

it.each([
  {
    agents: [
      {
        id: "broken",
        description: "Broken worker",
        setup: {
          model: { provider: "faux", modelId: "faux-1" },
          instructions: "BROKEN",
          tools: ["missing_tool"],
        },
      },
    ],
    error: 'Agent broken: tool "missing_tool" is not available here',
  },
  {
    agents: [
      {
        id: "unbound",
        description: "Missing binding owner",
        setup: {
          model: { provider: "faux", modelId: "faux-1" },
          instructions: "UNBOUND",
          tools: [],
          bindings: [{ owner: "not-installed", version: 1, value: {} }],
        },
      },
    ],
    error: "Agent unbound",
  },
  {
    agents: [
      {
        id: "twice",
        description: "First",
        setup: {
          model: { provider: "faux", modelId: "faux-1" },
          instructions: "A",
        },
      },
      {
        id: "twice",
        description: "Second",
        setup: {
          model: { provider: "faux", modelId: "faux-1" },
          instructions: "B",
        },
      },
    ],
    error: 'Duplicate agent "twice"',
  },
])(
  "rejects a misconfigured agent when Kaeno opens ($error)",
  async ({ agents, error }) => {
    await expect(
      openKaeno({
        storage: new MemoryStorage(),
        models: createModels(),
        assistant: {
          model: { provider: "faux", modelId: "faux-1" },
          instructions: "CHAT",
          tools: ["start_work"],
        },
        work: { agents, tools: [] },
      }),
    ).rejects.toThrow(error);
  },
);

it("keeps message_parent out of the assistant's selectable tools", async () => {
  await expect(
    openKaeno({
      storage: new MemoryStorage(),
      models: createModels(),
      assistant: {
        model: { provider: "faux", modelId: "faux-1" },
        instructions: "CHAT",
        tools: ["message_parent"],
      },
      work: { agents: [], tools: [] },
    }),
  ).rejects.toThrow('Assistant: tool "message_parent" is not available here');
});

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
  const agents: AgentProfile[] = [
    {
      id: "worker",
      description: "Worker",
      setup: { model, instructions: "WORKER", tools: [read.name] },
    },
  ];
  let ensuring = false;
  const environment = {
    identity: "test:pending",
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
    work: { agents, tools: [read.name], environment },
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
        work: { agents: [], tools: [], environment },
      }),
    ).rejects.toThrow(/Saved WORK no longer fits/);
  } finally {
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
});
