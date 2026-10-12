import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { AgentDoc, defineTask, type Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, it, vi } from "vitest";
import {
  AgentDelegation,
  AgentState,
  type AgentSandboxes,
  type DelegationRuntime,
} from "../../src/agents/index.ts";
import { storageCopy } from "../../src/work/index.ts";
import { createAgentFixture, openAgentHarness } from "./agent-fixture.ts";
import { createDelegationRuntime } from "./composition.ts";
const opened: Harness[] = [];
afterEach(async () => {
  for (const harness of opened.splice(0)) {
    await harness.close(ctx);
  }
  vi.restoreAllMocks();
});
const holder = defineTask<
  null,
  {
    phase: "hold";
  },
  null
>({
  name: "fixture.holder",
  version: 1,
  initial: () => ({ phase: "hold" }),
  phases: { hold: async () => {} },
  abort: async () => {},
});
function fakeSandboxes(): AgentSandboxes {
  return {
    ensureSandbox: vi.fn<AgentSandboxes["ensureSandbox"]>(),
    removeSandbox: vi.fn<AgentSandboxes["removeSandbox"]>(),
    sweepOrphanedSandboxes: vi.fn<AgentSandboxes["sweepOrphanedSandboxes"]>(),
    listReservations: vi
      .fn<AgentSandboxes["listReservations"]>()
      .mockResolvedValue([]),
    getExecutionEnvironment: () => {
      throw new Error("Unexpected execution environment");
    },
  };
}
it.each(["chat", "worker", "missing-blueprint"] as const)(
  "rejects $0 delegation before creating a child",
  async (role) => {
    const { factory, agents } = createAgentFixture();
    const harness = await openAgentHarness();
    opened.push(harness);
    const parent = await harness.commit(async (tx) => {
      const conversation = await tx.createConversation({
        ownership: { kind: "ownerless" },
      });
      const task = await tx.createTask(holder, null, {
        ownership: { kind: "conversation" },
        conversationId: conversation.id,
      });
      const state = await tx.doc(AgentState, conversation.id);
      state.template = "swe";
      state.role = role === "missing-blueprint" ? "work" : role;
      return { conversation, task };
    }, ctx);
    const api: DelegationRuntime = {
      ...createDelegationRuntime(harness, parent.conversation.id, parent.task),
      commit: async () => {
        throw new Error("Unexpected child creation");
      },
    };
    const commit = vi.spyOn(api, "commit");
    const delegation = new AgentDelegation(
      factory,
      fakeSandboxes(),
      { execution: "image" },
      "cache",
    );
    const result = await delegation.executeDelegation(
      { agent: "leaf", task: "Task" },
      api,
      ctx,
      agents.extension,
    );
    expect(result.isError).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  },
);
it("enforces direct delegation allowlists rather than graph reachability", async () => {
  const { factory, agents } = createAgentFixture();
  const harness = await openAgentHarness();
  opened.push(harness);
  const parent = await harness.commit(async (tx) => {
    const conversation = await tx.createConversation({
      ownership: { kind: "ownerless" },
    });
    const task = await tx.createTask(holder, null, {
      ownership: { kind: "conversation" },
      conversationId: conversation.id,
    });
    const state = await tx.doc(AgentState, conversation.id);
    state.template = "swe";
    state.role = "work";
    state.blueprint = storageCopy(agents.captureWorkBlueprint("swe"));
    return { conversation, task };
  }, ctx);
  const delegation = new AgentDelegation(
    factory,
    fakeSandboxes(),
    { execution: "image" },
    "cache",
  );
  const result = await delegation.executeDelegation(
    { agent: "chat", task: "Task" },
    createDelegationRuntime(harness, parent.conversation.id, parent.task),
    ctx,
    agents.extension,
  );
  expect(result.isError).toBe(true);
  expect(result.content?.[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("Unknown agent template"),
  });
});
it("adopts an existing child without replacing its saved configuration or binding", async () => {
  const { config, factory, agents } = createAgentFixture();
  const harness = await openAgentHarness();
  opened.push(harness);
  const parent = await harness.commit(async (tx) => {
    const conversation = await tx.createConversation({
      ownership: { kind: "ownerless" },
    });
    const task = await tx.createTask(holder, null, {
      ownership: { kind: "conversation" },
      conversationId: conversation.id,
    });
    const state = await tx.doc(AgentState, conversation.id);
    state.template = "swe";
    state.role = "work";
    state.blueprint = storageCopy(agents.captureWorkBlueprint("swe"));
    return { conversation, task };
  }, ctx);
  const configure = vi.spyOn(factory, "configureAgent");
  const delegation = new AgentDelegation(
    factory,
    fakeSandboxes(),
    { execution: "image" },
    "cache",
  );
  const api = createDelegationRuntime(
    harness,
    parent.conversation.id,
    parent.task,
  );
  await delegation.executeDelegation(
    { agent: "leaf", task: "First task" },
    api,
    ctx,
    agents.extension,
  );
  const child = (
    await harness.commit(
      (tx) => tx.scanConversations({ ownerTaskId: parent.task }, 10),
      ctx,
    )
  ).items[0];
  if (!child) {
    throw new Error("Child was not persisted");
  }
  const before = await harness.snapshot(AgentDoc, child.id, ctx);
  delete config.templates.leaf;
  await delegation.executeDelegation(
    { agent: "leaf", task: "Retry" },
    api,
    ctx,
    agents.extension,
  );
  expect(configure).toHaveBeenCalledTimes(1);
  expect(await harness.snapshot(AgentDoc, child.id, ctx)).toEqual(before);
  expect((await harness.snapshot(AgentState, child.id, ctx))?.role).toBe(
    "worker",
  );
});
