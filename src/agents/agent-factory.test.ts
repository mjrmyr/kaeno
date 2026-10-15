import { Type } from "@earendil-works/pi-ai";
import { configure, type ToolRegistration } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { createMockTransaction } from "../../test/mocks/durable.ts";
import { conversationId } from "../../test/mocks/identifiers.ts";
import type { Config, Template } from "../config/index.ts";
import type { WorkBlueprint } from "../work/index.ts";
import {
  AgentFactory,
  type AgentSkills,
  type WorkToolSurface,
} from "./index.ts";
vi.mock("@earendil-works/pi-durable", async () => {
  const { createMockSdk } = await import("../../test/mocks/sdk.ts");
  return createMockSdk();
});
vi.mock("@earendil-works/pi-durable/tools", async () => {
  const { Type } = await import("@earendil-works/pi-ai");
  const bash = {
    name: "bash",
    description: "bash",
    parameters: Type.Object({}),
    execute: async () => ({ content: [] }),
  };
  return { CodingTools: { name: "coding-tools", tools: [bash] } };
});
vi.mock("../config/index.ts", () => ({
  eligibleWorkTemplates: (config: Config): Template[] =>
    Object.values(config.templates),
}));
vi.mock("../work/index.ts", () => ({
  immutableCopy: <T>(value: T): T => value,
  sealBlueprint: (value: Omit<WorkBlueprint, "digest">): WorkBlueprint => ({
    ...value,
    digest: "mocked-policy-digest",
  }),
  frozenEntry: (snapshot: WorkBlueprint, name: string) =>
    snapshot.templates[name],
}));
function tool(name: string): ToolRegistration {
  return {
    name,
    description: name,
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => ({ content: [] }),
  };
}
function configuration(): Config {
  return {
    agent: "root",
    maxDepth: 3,
    sandboxResources: {
      requests: { cpu: "250m", memory: "256Mi" },
      limits: { cpu: "2", memory: "2Gi" },
    },
    skillRepositories: [],
    telegram: { allowedChatIds: [] },
    templates: {
      root: {
        name: "root",
        description: "front desk",
        model: { provider: "anthropic", modelId: "root-model" },
        instructions: "Root profile",
        skills: [],
        delegates: ["worker"],
      },
      worker: {
        name: "worker",
        description: "worker",
        model: { provider: "openai", modelId: "worker-model" },
        instructions: "Worker profile",
        skills: ["demo/skills:guide"],
        delegates: ["root"],
      },
    },
  };
}
function workSurface(): WorkToolSurface {
  const orchestrationTools = [tool("start_work"), tool("message_work")];
  const parentTools = [tool("message_parent")];
  return {
    extension: {
      name: "kaeno-work",
      tools: [...orchestrationTools, ...parentTools],
    },
    orchestrationTools,
    parentTools,
  };
}
const agentExtension = { name: "kaeno", tools: [tool("read_skill")] };
it("binds through the injected skill contract and rejects unknown selections", () => {
  const skills: AgentSkills = {
    bindSkills: vi.fn<AgentSkills["bindSkills"]>().mockReturnValue([]),
  };
  const factory = new AgentFactory(configuration(), skills, workSurface());
  expect(factory.bindAgent("worker").template.name).toBe("worker");
  expect(skills.bindSkills).toHaveBeenCalledWith(["demo/skills:guide"]);
  expect(() => factory.bindAgent("missing")).toThrow(/Unknown agent/);
});
it("captures each reachable template once, including cycles, with the injected image and the depth limit", () => {
  const skills: AgentSkills = {
    bindSkills: vi.fn<AgentSkills["bindSkills"]>().mockReturnValue([]),
  };
  const factory = new AgentFactory(configuration(), skills, workSurface());
  const snapshot = factory.captureWorkBlueprint(
    "root",
    { execution: "chosen-image" },
    "chosen-cache",
  );
  expect(Object.keys(snapshot.templates).sort()).toEqual(["root", "worker"]);
  expect(skills.bindSkills).toHaveBeenCalledTimes(2);
  expect(snapshot.maxDepth).toBe(3);
  expect(snapshot.images).toEqual({ execution: "chosen-image" });
  expect(snapshot.skillCacheClaim).toBe("chosen-cache");
});
it("configures CHAT with orchestration only: no coding tools, no sandbox cwd", async () => {
  const factory = new AgentFactory(
    configuration(),
    { bindSkills: () => [] },
    workSurface(),
  );
  const tx = createMockTransaction();
  const id = conversationId(12);
  const bound = await factory.configureAgent(
    tx,
    id,
    { role: "chat" },
    agentExtension,
  );
  expect(bound.template.name).toBe("root");
  expect(configure).toHaveBeenCalledWith(
    tx,
    id,
    expect.objectContaining({
      model: { provider: "anthropic", modelId: "root-model" },
      thinkingLevel: null,
      cwd: null,
      tools: [
        expect.objectContaining({ name: "start_work" }),
        expect.objectContaining({ name: "message_work" }),
      ],
      extensions: [
        expect.objectContaining({ name: "kaeno" }),
        expect.objectContaining({ name: "kaeno-work" }),
      ],
      instructions: expect.stringContaining("- worker: worker"),
    }),
  );
});
it.each([
  [
    true,
    ["bash", "message_parent", "start_work", "message_work", "read_skill"],
  ],
  [false, ["bash", "message_parent", "read_skill"]],
])(
  "configures WORK in its sandbox with coding tools and orchestration only when allowed (orchestrate=%s)",
  async (orchestrate, tools) => {
    const factory = new AgentFactory(
      configuration(),
      { bindSkills: () => [] },
      workSurface(),
      "/chosen-workspace",
    );
    const blueprint = factory.captureWorkBlueprint(
      "root",
      { execution: "image" },
      "cache",
    );
    const tx = createMockTransaction();
    await factory.configureAgent(
      tx,
      conversationId(13),
      {
        role: "work",
        blueprint: {
          ...blueprint,
          templates: {
            ...blueprint.templates,
            worker: {
              ...blueprint.templates.worker,
              skills: [
                {
                  id: "demo/skills:guide",
                  description: "guide",
                  disableModelInvocation: false,
                  repositoryCommit: "a",
                  treeHash: "b",
                  sandboxRoot: "/s",
                  documents: { "SKILL.md": "x" },
                },
              ],
            },
          },
        },
        agent: "worker",
        orchestrate,
      },
      agentExtension,
    );
    const change = vi.mocked(configure).mock.calls[0]?.[2];
    expect(change?.cwd).toBe("/chosen-workspace");
    expect(
      Array.isArray(change?.tools) && change.tools.map((entry) => entry.name),
    ).toEqual(tools);
    expect(change?.instructions).toContain("Kaeno WORK");
    expect(String(change?.instructions).includes("Child work templates")).toBe(
      orchestrate,
    );
  },
);
