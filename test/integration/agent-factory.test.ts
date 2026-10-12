import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { AgentDoc, configure, type Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, it, vi } from "vitest";
import { AgentFactory, type AgentSelection } from "../../src/agents/index.ts";
import { frozenEntry, storageCopy, workRoot } from "../../src/work/index.ts";
import {
  createAgentFixture,
  guide,
  openAgentHarness,
} from "./agent-fixture.ts";
const opened: Harness[] = [];
afterEach(async () => {
  for (const harness of opened.splice(0)) {
    await harness.close(ctx);
  }
  vi.restoreAllMocks();
});
async function open(): Promise<Harness> {
  const harness = await openAgentHarness();
  opened.push(harness);
  return harness;
}
const matrix: {
  role: AgentSelection["role"];
  agent: string;
  tools: string[];
  cwd?: string;
}[] = [
  {
    role: "chat",
    agent: "chat",
    tools: ["start_work", "list_work", "cancel_work"],
  },
  { role: "work", agent: "chat", tools: ["delegate"] },
  { role: "work", agent: "swe", tools: ["read_skill", "delegate"] },
  { role: "work", agent: "leaf", tools: [] },
  { role: "worker", agent: "chat", tools: [] },
  {
    role: "worker",
    agent: "swe",
    tools: ["bash", "read", "write", "edit", "read_skill"],
    cwd: "/custom-workspace",
  },
  { role: "worker", agent: "leaf", tools: [] },
  { role: "legacy", agent: "chat", tools: ["delegate"] },
  {
    role: "legacy",
    agent: "swe",
    tools: ["bash", "read", "write", "edit", "read_skill", "delegate"],
    cwd: "/custom-workspace",
  },
  { role: "legacy", agent: "leaf", tools: [] },
];
it.each(matrix)(
  "configures exact $role/$agent capabilities and clears inherited settings",
  async ({ role, agent, tools, cwd }) => {
    const { config, factory, agents } = createAgentFixture();
    const harness = await open();
    const blueprint = agents.captureWorkBlueprint(agent);
    let selection: AgentSelection;
    if (role === "chat") {
      selection = { role };
    } else if (role === "work") {
      selection = { role, blueprint };
    } else {
      selection = { role, agent };
    }
    const id = await harness.commit(async (tx) => {
      const conversation = await tx.createConversation({
        ownership: { kind: "ownerless" },
      });
      await configure(tx, conversation.id, {
        tools: agents.extension.tools ?? [],
        extensions: [{ name: "inherited" }],
        cwd: "/inherited",
        thinkingLevel: "xhigh",
      });
      const bound = await factory.configureAgent(
        tx,
        conversation.id,
        selection,
        agents.extension,
      );
      expect(bound.template).toEqual(config.templates[agent]);
      expect(bound.skills).toEqual(agent === "swe" ? guide : []);
      return conversation.id;
    }, ctx);
    const stored = await harness.snapshot(AgentDoc, id, ctx);
    expect(stored).toMatchObject({
      model: config.templates[agent].model,
      tools,
      extensions: ["coding-tools", "kaeno", "kaeno-work"],
    });
    expect(stored?.thinkingLevel).toBe(config.templates[agent].thinkingLevel);
    expect(stored?.cwd).toBe(cwd);
    expect(stored?.instructions).toContain(
      config.templates[agent].instructions,
    );
  },
);
it("replays saved role settings and skills after the live catalog/configuration/cwd change", async () => {
  const { config, catalog, agents, work } = createAgentFixture();
  const blueprint = agents.captureWorkBlueprint("swe");
  config.templates.swe.model = { provider: "anthropic", modelId: "changed" };
  config.templates.swe.instructions = "CHANGED";
  config.templates.swe.tools = [];
  catalog.bindSkills = () => {
    throw new Error("Live catalog must not be consulted");
  };
  const later = new AgentFactory(config, catalog, work, "/changed");
  const harness = await open();
  const id = await harness.commit(async (tx) => {
    const conversation = await tx.createConversation({
      ownership: { kind: "ownerless" },
    });
    const bound = await later.configureAgent(
      tx,
      conversation.id,
      { role: "worker", agent: "swe", blueprint },
      agents.extension,
    );
    expect(bound.skills).toEqual(guide);
    return conversation.id;
  }, ctx);
  expect(await harness.snapshot(AgentDoc, id, ctx)).toMatchObject({
    model: { provider: "openai", modelId: "swe" },
    cwd: "/custom-workspace",
    tools: ["bash", "read", "write", "edit", "read_skill"],
  });
  expect(config.templates.swe.instructions).toBe("CHANGED");
});
it("fails visibly when a saved tool or extension implementation is unavailable", async () => {
  const { config, catalog, work, agents } = createAgentFixture();
  const draft = storageCopy(agents.captureWorkBlueprint("swe"));
  const harness = await open();
  const noWork = new AgentFactory(config, catalog);
  await expect(
    harness.commit(async (tx) => {
      const conversation = await tx.createConversation({
        ownership: { kind: "ownerless" },
      });
      await noWork.configureAgent(
        tx,
        conversation.id,
        { role: "work", blueprint: draft },
        agents.extension,
      );
    }, ctx),
  ).rejects.toThrow("extension");
  const noDelegate = {
    ...agents.extension,
    tools: (agents.extension.tools ?? []).filter(
      (tool) => tool.name !== "delegate",
    ),
  };
  const factory = new AgentFactory(config, catalog, work);
  await expect(
    harness.commit(async (tx) => {
      const conversation = await tx.createConversation({
        ownership: { kind: "ownerless" },
      });
      await factory.configureAgent(
        tx,
        conversation.id,
        { role: "work", blueprint: draft },
        noDelegate,
      );
    }, ctx),
  ).rejects.toThrow("tool");
});
it("takes one immutable reachable snapshot, resolves cycles, and keeps workers leaves", () => {
  const { config, agents } = createAgentFixture();
  const blueprint = agents.captureWorkBlueprint("swe");
  expect(Object.keys(blueprint.templates).sort()).toEqual(["leaf", "swe"]);
  expect(Object.isFrozen(blueprint)).toBe(true);
  expect(Object.isFrozen(blueprint.templates.swe.skills[0].documents)).toBe(
    true,
  );
  expect(frozenEntry(blueprint, "swe").settings.worker.tools).not.toContain(
    "delegate",
  );
  expect(
    Reflect.set(blueprint.templates.swe.template, "instructions", "changed"),
  ).toBe(false);
  config.templates.swe.instructions = "changed";
  expect(workRoot(blueprint).template.instructions).toBe("SWE PROFILE");
});
