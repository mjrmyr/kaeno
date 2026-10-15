import { SANDBOX_RESOURCES } from "./values.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { vi } from "vitest";
import {
  AgentFactory,
  type Agent,
  type WorkToolSurface,
} from "../../src/agents/index.ts";
import { parseConfig, type Config } from "../../src/config/index.ts";
import type { BoundSkill } from "../../src/skills/index.ts";
import { createAgents, createNoopWorkSurface } from "./composition.ts";
export const guide: BoundSkill[] = [
  {
    id: "demo/skills:guide",
    description: "Frozen guide",
    disableModelInvocation: false,
    repositoryCommit: "a".repeat(40),
    treeHash: "b".repeat(64),
    sandboxRoot: "/workspace/.agents/skills/demo/skills/guide",
    documents: { "SKILL.md": "FROZEN CONTENT" },
  },
];
export interface AgentFixture {
  config: Config;
  catalog: {
    bindSkills: (ids: readonly string[]) => BoundSkill[];
  };
  factory: AgentFactory;
  agents: Agent;
  work: WorkToolSurface;
}
export function createAgentFixture(): AgentFixture {
  const config = parseConfig({
    agent: "chat",
    sandboxResources: SANDBOX_RESOURCES,
    skillRepositories: ["demo/skills"],
    templates: {
      chat: {
        description: "primary",
        model: "anthropic/chat",
        instructions: "CHAT PROFILE",
        delegates: ["swe", "leaf"],
      },
      swe: {
        description: "engineer",
        model: "openai/swe",
        instructions: "SWE PROFILE",
        thinkingLevel: "high",
        delegates: ["swe", "leaf"],
        skills: ["demo/skills:guide"],
      },
      leaf: {
        description: "reasoning",
        model: "openai/leaf",
        instructions: "LEAF PROFILE",
      },
    },
  });
  const catalog = {
    bindSkills: vi.fn<(ids: readonly string[]) => BoundSkill[]>((ids) =>
      ids.length ? structuredClone(guide) : [],
    ),
  };
  const work = createNoopWorkSurface();
  const factory = new AgentFactory(config, catalog, work, "/custom-workspace");
  const agents = createAgents({
    factory,
    harness: () => {
      throw new Error("Unexpected harness access");
    },
    images: { execution: "frozen-image" },
    skillCacheClaim: "frozen-cache",
  });
  return { config, catalog, work, factory, agents };
}
export function openAgentHarness(): Promise<Harness> {
  return Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
}
