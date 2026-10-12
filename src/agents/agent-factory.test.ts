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
vi.mock("@earendil-works/pi-durable/tools", () => ({
  CodingTools: { name: "coding-tools", tools: [] },
}));
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
  storageCopy: <T>(value: T): T => value,
  frozenEntry: (snapshot: WorkBlueprint, name: string) =>
    snapshot.templates[name],
  workRoot: (snapshot: WorkBlueprint) => snapshot.templates[snapshot.agent],
  readBlueprint: (snapshot: WorkBlueprint): WorkBlueprint => snapshot,
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
    skillRepositories: [],
    telegram: { allowedChatIds: [] },
    templates: {
      root: {
        name: "root",
        description: "front desk",
        model: { provider: "anthropic", modelId: "root-model" },
        instructions: "Root profile",
        sandbox: false,
        tools: [],
        skills: [],
        delegates: ["worker"],
      },
      worker: {
        name: "worker",
        description: "worker",
        model: { provider: "openai", modelId: "worker-model" },
        instructions: "Worker profile",
        sandbox: true,
        tools: [],
        skills: ["demo/skills:guide"],
        delegates: ["root"],
      },
    },
  };
}
function workSurface(): WorkToolSurface {
  const tools = [tool("start_work"), tool("list_work"), tool("cancel_work")];
  return { extension: { name: "kaeno-work", tools }, tools };
}
it("binds through the injected skill contract and rejects unknown selections", () => {
  const skills: AgentSkills = {
    bindSkills: vi.fn<AgentSkills["bindSkills"]>().mockReturnValue([]),
  };
  const factory = new AgentFactory(configuration(), skills);
  expect(factory.bindAgent("worker").template.name).toBe("worker");
  expect(skills.bindSkills).toHaveBeenCalledWith(["demo/skills:guide"]);
  expect(() => factory.bindAgent("missing")).toThrow(/Unknown agent/);
});
it("captures each reachable template once, including cycles, with injected image/cwd decisions", () => {
  const skills: AgentSkills = {
    bindSkills: vi.fn<AgentSkills["bindSkills"]>().mockReturnValue([]),
  };
  const factory = new AgentFactory(
    configuration(),
    skills,
    workSurface(),
    "/chosen-workspace",
  );
  const snapshot = factory.captureWorkBlueprint(
    "root",
    { execution: "chosen-image" },
    "chosen-cache",
    { name: "kaeno" },
  );
  expect(Object.keys(snapshot.templates).sort()).toEqual(["root", "worker"]);
  expect(skills.bindSkills).toHaveBeenCalledTimes(2);
  expect(snapshot.images).toEqual({ execution: "chosen-image" });
  expect(snapshot.skillCacheClaim).toBe("chosen-cache");
  expect(snapshot.templates.worker.settings.worker.cwd).toBe(
    "/chosen-workspace",
  );
  expect(snapshot.templates.worker.settings.worker.tools).not.toContain(
    "delegate",
  );
});
it("passes explicit configuration fields to the SDK instead of inheriting settings", async () => {
  const factory = new AgentFactory(
    configuration(),
    { bindSkills: () => [] },
    workSurface(),
  );
  const tx = createMockTransaction();
  const id = conversationId(12);
  const extension = {
    name: "kaeno",
    tools: [tool("delegate"), tool("read_skill")],
  };
  const bound = await factory.configureAgent(
    tx,
    id,
    { role: "chat" },
    extension,
  );
  expect(bound.template.name).toBe("root");
  expect(configure).toHaveBeenCalledWith(
    tx,
    id,
    expect.objectContaining({
      model: { provider: "anthropic", modelId: "root-model" },
      thinkingLevel: null,
      cwd: null,
      tools: workSurface().tools.map((registration) =>
        expect.objectContaining({ name: registration.name }),
      ),
      extensions: expect.any(Array),
      instructions: expect.stringContaining("Root profile"),
    }),
  );
});
it("fails before SDK configuration when CHAT has no work capability provider", async () => {
  const factory = new AgentFactory(configuration(), { bindSkills: () => [] });
  await expect(
    factory.configureAgent(
      createMockTransaction(),
      conversationId(12),
      { role: "chat" },
      { name: "kaeno" },
    ),
  ).rejects.toThrow(/WORK/);
  expect(configure).not.toHaveBeenCalled();
});
