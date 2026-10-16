import {
  configure,
  type ConversationId,
  type Extension,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { eligibleWorkTemplates, type Config } from "../config/index.ts";
import type { BoundSkill, SandboxImages } from "../skills/index.ts";
import {
  immutableCopy,
  sealBlueprint,
  type BoundAgent,
  type WorkBlueprint,
} from "../work/index.ts";
/** Factory-owned requirement, fulfilled structurally by the skill catalog. */
export interface AgentSkills {
  bindSkills(ids: readonly string[]): BoundSkill[];
}
/** All conversation capabilities and instructions are supplied by the composing role. */
export interface AgentConfiguration {
  extensions: readonly Extension[];
  tools: readonly ToolRegistration[];
  instructions: string;
  cwd: string | null;
}
export class AgentFactory {
  readonly config: Config;
  readonly sandboxCwd: string;
  private readonly skills: AgentSkills;
  constructor(config: Config, skills: AgentSkills, sandboxCwd = "/workspace") {
    this.config = config;
    this.skills = skills;
    this.sandboxCwd = sandboxCwd;
  }
  bindAgent(agent: string): BoundAgent {
    if (!Object.hasOwn(this.config.templates, agent)) {
      throw new Error(`Unknown agent template "${agent}"`);
    }
    const template = this.config.templates[agent];
    return immutableCopy({
      template,
      skills: this.skills.bindSkills(template.skills),
    });
  }
  captureWorkBlueprint(
    agent: string,
    images: SandboxImages,
    skillCacheClaim: string,
  ): WorkBlueprint {
    if (
      !eligibleWorkTemplates(this.config).some(
        (template) => template.name === agent,
      )
    ) {
      throw new Error(`Ineligible WORK template "${agent}"`);
    }
    const templates: Record<string, BoundAgent> = {};
    const visit = (name: string): void => {
      if (Object.hasOwn(templates, name)) {
        return;
      }
      templates[name] = this.bindAgent(name);
      for (const delegate of templates[name].template.delegates) {
        visit(delegate);
      }
    };
    visit(agent);
    return sealBlueprint({
      schema: 2,
      agent,
      maxDepth: this.config.maxDepth,
      templates,
      images: { execution: images.execution },
      skillCacheClaim,
    });
  }
  async configureAgent(
    tx: Tx,
    id: ConversationId,
    binding: BoundAgent,
    configuration: AgentConfiguration,
  ): Promise<void> {
    await configure(tx, id, {
      model: { ...binding.template.model },
      thinkingLevel: binding.template.thinkingLevel ?? null,
      extensions: [...configuration.extensions],
      tools: [...configuration.tools],
      instructions: configuration.instructions,
      cwd: configuration.cwd,
    });
  }
}
