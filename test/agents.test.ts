import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { BoundSkill } from "../src/skills.ts";
import type { AgentState as SdkAgentState, Tx, ConversationId } from "@earendil-works/pi-durable";
import { AgentFactory, type AgentSelection } from "../src/agent-factory.ts";
import { createAgents } from "../src/agents.ts";
import { sealBlueprint } from "../src/work-blueprint.ts";
import { parseConfig } from "../src/config.ts";

function setup() {
  const config = parseConfig({ agent: "kaeno", skillRepositories: ["demo/skills"], templates: {
    kaeno: { description: "chat primary", model: "anthropic/chat", instructions: "CHAT PROFILE", delegates: ["swe"] },
    swe: { description: "engineer", model: "openai/work", thinkingLevel: "high", instructions: "SWE PROFILE",
      sandbox: true, tools: ["bash", "read"], skills: ["demo/skills:guide"], delegates: ["leaf"] },
    leaf: { description: "execution leaf", model: "openai/leaf", instructions: "LEAF PROFILE", delegates: ["kaeno"] },
    hidden: { description: "unrelated", model: "anthropic/hidden", instructions: "HIDDEN" },
  } });
  const binding: BoundSkill[] = [{ id: "demo/skills:guide", description: "engineering skill", disableModelInvocation: false,
    repositoryCommit: "a".repeat(40), treeHash: "b".repeat(64), sandboxRoot: "/workspace/.agents/skills/demo/skills/guide", documents: { "SKILL.md": "FROZEN SKILL" } }];
  const skills = { bind: (ids: readonly string[]) => ids.length ? structuredClone(binding) : [] };
  const tools = [{ name: "start_work" }, { name: "list_work" }, { name: "cancel_work" }];
  const factory = new AgentFactory({ config, skills,
    work: { extension: { name: "test-work", tools }, tools } as any });
  const agents = createAgents({ harness: () => { throw new Error("unexpected harness access"); },
    images: { execution: "frozen-image" }, skillCacheClaim: "frozen-cache", factory });
  const delegate = agents.Kaeno.tools!.find(t => t.name === "delegate")!;
  const execute = (state: any, agent: string) => delegate.execute({ agent, task: "Task" }, {
    conversationId: 1, snapshot: async () => state, commit: async () => { throw new Error("unexpected child creation"); },
  } as any, ctx);
  const configured = async (selection: AgentSelection) => {
    const doc: SdkAgentState = {};
    await factory.configure({ doc: async () => doc } as unknown as Tx, 1 as ConversationId, selection, agents.Kaeno);
    return doc;
  };
  return { config, agents, execute, configured, factory };
}

it("freezes selected root's model, thinking, profile, tools, skills and reachable allowlist without changing CHAT", async () => {
  const { config, agents, configured } = setup();
  const blueprint = agents.captureWork("swe");
  expect(blueprint.agent).toBe("swe");
  expect(blueprint.templates.swe!.template).toEqual(config.templates.swe);
  expect(blueprint.images.execution).toBe("frozen-image");
  expect(blueprint.skillCacheClaim).toBe("frozen-cache");
  expect(Object.keys(blueprint.templates)).toEqual(["swe", "leaf", "kaeno"]);
  expect(blueprint.templates.hidden).toBeUndefined();
  const work = await configured({ role: "work", blueprint });
  expect(work.model).toEqual({ provider: "openai", modelId: "work" });
  expect(work.thinkingLevel).toBe("high");
  expect(work.instructions).toContain("SWE PROFILE");
  expect(work.instructions).toContain("Kaeno WORK");
  expect(work.instructions).not.toContain("Kaeno CHAT");
  expect(work.tools).toEqual(["read_skill", "delegate"]);
  expect(work.cwd).toBeUndefined();
  expect(blueprint.templates.swe!.skills[0]!.documents["SKILL.md"]).toBe("FROZEN SKILL");
  expect(blueprint.templates.swe!.skills[0]!.treeHash).toBe("b".repeat(64));
  config.templates.swe!.instructions = "CHANGED"; config.templates.swe!.delegates = [];
  expect(blueprint.templates.swe!.template.instructions).toBe("SWE PROFILE");
  expect(blueprint.templates.swe!.template.delegates).toEqual(["leaf"]);
  expect((await configured({ role: "chat" })).model).toEqual({ provider: "anthropic", modelId: "chat" });
  expect(config.agent).toBe("kaeno");
  expect(() => agents.captureWork("hidden")).toThrow(/Ineligible/);
  expect(() => agents.captureWork("arbitrary")).toThrow(/Ineligible/);
});

it.each([true, false])("WORKER tools and runtime are leaves even with configured delegates (blueprint=%s)", async frozen => {
  const { config, agents, execute, configured } = setup();
  const blueprint = frozen ? agents.captureWork("swe") : undefined;
  const worker = await configured({ role: "worker", agent: "swe", blueprint });
  expect(worker.tools).toEqual(["bash", "read", "read_skill"]);
  expect(worker.instructions).not.toContain("Foreground delegate targets");
  expect(worker.instructions).not.toContain("Kaeno WORK");
  const result = await execute({ role: "worker", template: "swe", blueprint }, "leaf");
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("WORKERs are leaves");
});

it("WORK rejects non-allowlisted and missing frozen targets rather than consulting current config", async () => {
  const { agents, execute, configured } = setup();
  let blueprint = agents.captureWork("swe");
  const state = { role: "work", template: "swe", blueprint };
  expect(JSON.stringify((await execute(state, "kaeno")).content)).toContain("Available: leaf");
  expect(JSON.stringify((await execute(state, "hidden")).content)).toContain("Available: leaf");
  const damaged = JSON.parse(JSON.stringify(blueprint));
  delete damaged.templates.leaf;
  const { digest: _, ...content } = damaged;
  blueprint = sealBlueprint(content); state.blueprint = blueprint;
  expect(JSON.stringify((await execute(state, "leaf")).content)).toContain('Missing frozen delegate template');
  // The root's saved instructions no longer require resolving delegate descriptions.
  await expect(configured({ role: "work", blueprint })).resolves.toBeDefined();
  expect(JSON.stringify((await execute({ role: "work", template: "swe" }, "leaf")).content)).toContain("no frozen blueprint");
  expect(JSON.stringify((await execute({ role: "chat", template: "kaeno" }, "swe")).content)).toContain("CHAT starts work");
});
