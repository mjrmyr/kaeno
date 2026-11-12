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
import {
  isRouterRequest,
  receive,
  replies,
  ROUTER_ASSISTANT_TOOLS,
  startTicket,
  ticketWhen,
  until,
} from "../mocks/router.ts";

it("runs all-to-all delegation through core-only agents, keeps frozen children, exact tools and the v4 stored plan", async () => {
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
      if (isRouterRequest(request)) {
        return fauxAssistantMessage("ok");
      }
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
              assignment: { kind: "task" },
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
      throw new Error("Unexpected model request");
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
    work: {
      agents,
      tools: ["start_work"],
      maxDepth: 2,
      maxConcurrent: 3,
    },
  });
  try {
    const ticket = await startTicket(core, {
      agent: "parent",
      title: "Parent",
      content: "Coordinate",
    });
    const done = await ticketWhen(
      core,
      ticket,
      (value) => value.reports.some((report) => report.state === "ready"),
      "the parent's report",
    );
    expect(done.reports.at(-1)).toMatchObject({
      state: "ready",
      summary: "PARENT REPORT",
    });
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
    const record = (
      await core.harness.commit((tx) => tx.scanTasks({}, 100), context)
    ).items.find(
      (task) =>
        task.kind === "kaeno.work" &&
        JSON.stringify(task.input).includes('"agent":"parent"'),
    );
    expect(record?.version).toBe(4);
    expect(record?.input).toMatchObject({
      agent: "parent",
      parent: { kind: "ticket", ticket },
      conversation: { kind: "ticket", id: done.conversation },
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

it("keeps the router usable and explains a failed ticket without configured agents", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: "faux", modelId: "faux-1" };
  const tools = [...ROUTER_ASSISTANT_TOOLS];
  let observedFailure = false;
  faux.setResponses([
    async (request) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      expect(prompt).toContain("No worker agents are configured");
      return fauxAssistantMessage(
        [
          fauxToolCall("route", {
            items: [
              {
                trigger: "t1",
                kind: "accept",
                agent: "broken",
                title: "Attempt",
                ack: "On it.",
              },
            ],
          }),
          fauxToolCall("list_tickets", {}),
        ],
        { stopReason: "toolUse" },
      );
    },
    async (request) => {
      const results = request.messages.filter(
        (message) => message.role === "toolResult",
      );
      expect(results).toHaveLength(2);
      expect(JSON.stringify(results)).toContain("t1: not routed");
      observedFailure = true;
      return fauxAssistantMessage("I can answer, but no worker can run yet.");
    },
  ]);
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant: { model, instructions: "ROUTER", tools },
    work: { agents: [], tools: [] },
  });
  try {
    const router = await core.router.routerConversation(context);
    expect(
      (await core.harness.snapshot(AgentDoc, router, context))?.tools,
    ).toEqual(tools);
    await receive(core, "Delegate this", { key: "delegate" });
    await until(
      async () =>
        (await replies(core)).some(
          (reply) => reply.text === "I can answer, but no worker can run yet.",
        ),
      "the router's answer",
    );
    expect(observedFailure).toBe(true);
    await expect(
      startTicket(core, { agent: "broken", content: "Delegate" }),
    ).rejects.toThrow(/Unknown agent "broken"/);
    const tasks = await core.harness.commit(
      (tx) => tx.scanTasks({}, 100),
      context,
    );
    expect(tasks.items.filter((task) => task.kind === "kaeno.work")).toEqual(
      [],
    );
    expect(await core.router.listTickets(context, true)).toEqual([]);
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
          instructions: "ROUTER",
          tools: [...ROUTER_ASSISTANT_TOOLS],
        },
        work: { agents, tools: [] },
      }),
    ).rejects.toThrow(error);
  },
);

it.each(["message_parent", "report", "start_work", "list_work"])(
  "keeps the WORK tool %s out of the assistant's selectable tools",
  async (tool) => {
    await expect(
      openKaeno({
        storage: new MemoryStorage(),
        models: createModels(),
        assistant: {
          model: { provider: "faux", modelId: "faux-1" },
          instructions: "ROUTER",
          tools: [tool],
        },
        work: { agents: [], tools: [] },
      }),
    ).rejects.toThrow(`Assistant: tool "${tool}" is not available here`);
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
  const core = await openKaeno({
    storage: await openNodeSqliteStorage(path),
    models,
    assistant: {
      model,
      instructions: "ROUTER",
      tools: [...ROUTER_ASSISTANT_TOOLS],
    },
    extensions: [extension],
    work: { agents, tools: [read.name], environment },
  });
  try {
    await startTicket(core, {
      agent: "worker",
      title: "Pending",
      content: "Wait",
    });
    await vi.waitFor(() => expect(ensuring).toBe(true));
    await core.close();
    await expect(
      openKaeno({
        storage: await openNodeSqliteStorage(path),
        models,
        assistant: {
          model,
          instructions: "ROUTER",
          tools: [...ROUTER_ASSISTANT_TOOLS],
        },
        extensions: [extension],
        work: { agents: [], tools: [], environment },
      }),
    ).rejects.toThrow(/Saved WORK no longer fits/);
  } finally {
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
});
