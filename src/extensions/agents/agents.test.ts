import { expect, it, vi } from "vitest";
import {
  parseAgent,
  parseAgents,
  resolveAgentSetup,
  agentParticipants,
  type SkillBinder,
} from "./index.ts";
const manifest = (frontmatter: string, body = "Prompt") =>
  `---\n${frontmatter}\n---\n${body}`;
it("requires only name and description and preserves body and future metadata", () => {
  const agent = parseAgent(
    manifest(
      `name: scout\ndescription: Investigates\nfuture:\n  option: true`,
      "Investigate carefully.",
    ),
    "home",
    "/agents/scout/AGENT.md",
  );
  expect(agent.id).toBe("home:scout");
  expect(agent.prompt).toBe("Investigate carefully.");
  expect(agent.metadata).toEqual({ future: { option: true } });
  expect(() =>
    parseAgent(manifest("name: missing-description"), "home", "x"),
  ).toThrow(/description/);
});
it("keeps legacy or future delegation metadata inert; core uses all-to-all delegation", () => {
  const agent = parseAgent(
    manifest("name: scout\ndescription: Investigates\ndelegates: []"),
    "home",
    "x",
  );
  expect(agent.metadata).toEqual({ delegates: [] });
  expect(
    agentParticipants({
      agents: [agent],
      defaults: { model: { provider: "openai", modelId: "x" }, tools: [] },
    }).plan("home:scout").participants["home:scout"],
  ).toBeDefined();
});
it("reports duplicate IDs but preserves same names from distinct source aliases", () => {
  const packages = ["home", "local"].map((source) => ({
    source,
    directory: source,
    manifest: manifest("name: reviewer\ndescription: Reviews"),
  }));
  expect(parseAgents(packages).agents.map((agent) => agent.id)).toEqual([
    "home:reviewer",
    "local:reviewer",
  ]);
  expect(parseAgents([packages[0], packages[0]]).diagnostics).toHaveLength(1);
});
it("leaves agents discoverable without a model and activates them when a default exists", () => {
  const agent = parseAgent(
    manifest("name: scout\ndescription: Investigates"),
    "local",
    "x",
  );
  const unavailable = agentParticipants({
    agents: [agent],
    defaults: { tools: [] },
  });
  expect(unavailable.list()).toMatchObject([
    { id: "local:scout", available: false },
  ]);
  expect(() => unavailable.plan("local:scout")).toThrow(/no model/);
  const participant = agentParticipants({
    agents: [agent],
    defaults: { model: { provider: "openai", modelId: "x" }, tools: [] },
  });
  expect(
    participant.plan("local:scout").participants["local:scout"].setup.tools,
  ).toEqual([]);
  expect(Object.keys(participant.plan("local:scout").participants)).toEqual([
    "local:scout",
  ]);
});
it.each(["", "\nskills: []"])(
  "defaults to skill tools even without assignments (%s)",
  (skills) => {
    const bind = vi.fn<SkillBinder["bind"]>();
    const agent = parseAgent(
      manifest(`name: scout\ndescription: Investigates${skills}`),
      "local",
      "x",
    );
    const setup = resolveAgentSetup(
      agent,
      {
        model: { provider: "openai", modelId: "x" },
        tools: ["bash", "read_skill"],
      },
      { tools: ["list_skills", "read_skill"], bind },
    );
    expect(setup.tools).toEqual(["bash", "read_skill", "list_skills"]);
    expect(setup.bindings).toEqual([]);
    expect(bind).not.toHaveBeenCalled();
  },
);
it("freezes trusted extension bindings without changing explicit tool selection", () => {
  const agent = parseAgent(
    manifest(
      "name: coder\ndescription: Codes\ntools: []\ngithub: self-granted",
    ),
    "local",
    "x",
  );
  const binding = { owner: "external", version: 1, value: { scope: [123] } };
  const participants = agentParticipants({
    agents: [agent],
    defaults: {
      model: { provider: "openai", modelId: "x" },
      tools: ["external_tool"],
    },
    bindingsFor: (definition) =>
      definition.id === "local:coder" ? [binding] : [],
  });
  const plan = participants.plan(agent.id);
  expect(plan.participants[agent.id].setup.tools).toEqual([]);
  expect(plan.participants[agent.id].setup.bindings).toEqual([binding]);
  binding.value.scope.push(456);
  expect(plan.participants[agent.id].setup.bindings?.[0].value).toEqual({
    scope: [123],
  });
  expect(
    resolveAgentSetup(agent, {
      model: { provider: "openai", modelId: "x" },
      tools: [],
    }).bindings,
  ).toEqual([]);
});

it("keeps explicit empty tool/skill lists and never maps a tool name to a grant", () => {
  const agent = parseAgent(
    manifest("name: scout\ndescription: Investigates\ntools: []\nskills: []"),
    "local",
    "x",
  );
  const setup = resolveAgentSetup(
    agent,
    {
      model: { provider: "openai", modelId: "x" },
      tools: ["bash"],
    },
    {
      tools: ["list_skills", "read_skill"],
      bind: vi.fn<SkillBinder["bind"]>(),
    },
  );
  expect(setup.tools).toEqual([]);
  expect(setup.bindings).toEqual([]);
});
