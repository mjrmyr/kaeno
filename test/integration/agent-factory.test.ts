import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { AgentDoc, configure, type Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, it, vi } from "vitest";
import { AgentFactory, type AgentSelection } from "../../src/agents/index.ts";
import { frozenEntry } from "../../src/work/index.ts";
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
const orchestration = [
  "start_work",
  "list_work",
  "inspect_work",
  "message_work",
  "cancel_work",
];
const coding = ["read", "write", "edit", "bash"];
const matrix: {
  role: AgentSelection["role"];
  agent: string;
  orchestrate?: boolean;
  tools: string[];
  extensions: string[];
  cwd?: string;
}[] = [
  {
    role: "chat",
    agent: "chat",
    tools: orchestration,
    extensions: ["kaeno", "kaeno-work"],
  },
  {
    role: "work",
    agent: "swe",
    orchestrate: true,
    tools: [...coding, "message_parent", ...orchestration, "read_skill"],
    extensions: ["coding-tools", "kaeno", "kaeno-work"],
    cwd: "/custom-workspace",
  },
  {
    role: "work",
    agent: "swe",
    orchestrate: false,
    tools: [...coding, "message_parent", "read_skill"],
    extensions: ["coding-tools", "kaeno", "kaeno-work"],
    cwd: "/custom-workspace",
  },
  {
    role: "work",
    agent: "leaf",
    orchestrate: false,
    tools: [...coding, "message_parent"],
    extensions: ["coding-tools", "kaeno", "kaeno-work"],
    cwd: "/custom-workspace",
  },
];
it.each(matrix)(
  "configures exact $role/$agent (orchestrate=$orchestrate) capabilities and clears inherited settings",
  async ({ role, agent, orchestrate, tools, extensions, cwd }) => {
    const { config, factory, agents } = createAgentFixture();
    const harness = await open();
    const selection: AgentSelection =
      role === "chat"
        ? { role }
        : {
            role,
            agent,
            orchestrate: orchestrate ?? false,
            blueprint: agents.captureWorkBlueprint("chat"),
          };
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
      extensions,
    });
    expect(stored?.thinkingLevel).toBe(config.templates[agent].thinkingLevel);
    expect(stored?.cwd).toBe(cwd);
    expect(stored?.instructions).toContain(
      config.templates[agent].instructions,
    );
  },
);
it("configures WORK from its frozen blueprint after the live catalog and configuration change", async () => {
  const { config, catalog, agents, work } = createAgentFixture();
  const blueprint = agents.captureWorkBlueprint("swe");
  config.templates.swe.model = { provider: "anthropic", modelId: "changed" };
  config.templates.swe.instructions = "CHANGED";
  catalog.bindSkills = () => {
    throw new Error("Live catalog must not be consulted");
  };
  const later = new AgentFactory(config, catalog, work, "/custom-workspace");
  const harness = await open();
  const id = await harness.commit(async (tx) => {
    const conversation = await tx.createConversation({
      ownership: { kind: "ownerless" },
    });
    const bound = await later.configureAgent(
      tx,
      conversation.id,
      { role: "work", agent: "swe", blueprint, orchestrate: true },
      agents.extension,
    );
    expect(bound.skills).toEqual(guide);
    return conversation.id;
  }, ctx);
  const stored = await harness.snapshot(AgentDoc, id, ctx);
  expect(stored).toMatchObject({
    model: { provider: "openai", modelId: "swe" },
    cwd: "/custom-workspace",
  });
  expect(stored?.instructions).toContain("SWE PROFILE");
  expect(stored?.instructions).not.toContain("CHANGED");
});
it("takes one immutable reachable snapshot with the depth limit and resolves cycles", () => {
  const { config, agents } = createAgentFixture();
  const blueprint = agents.captureWorkBlueprint("swe");
  expect(Object.keys(blueprint.templates).sort()).toEqual(["leaf", "swe"]);
  expect(blueprint.maxDepth).toBe(config.maxDepth);
  expect(Object.isFrozen(blueprint)).toBe(true);
  expect(Object.isFrozen(blueprint.templates.swe.skills[0].documents)).toBe(
    true,
  );
  expect(
    Reflect.set(blueprint.templates.swe.template, "instructions", "changed"),
  ).toBe(false);
  config.templates.swe.instructions = "changed";
  expect(frozenEntry(blueprint, "swe").template.instructions).toBe(
    "SWE PROFILE",
  );
});
