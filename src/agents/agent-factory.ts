import {
  configure,
  type ConversationId,
  type Extension,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { WorkConfig } from "../work/index.ts";
import type { BoundSkill, SandboxImages } from "../skills/index.ts";
import {
  frozenEntry,
  immutableCopy,
  sealBlueprint,
  type BoundAgent,
  type WorkBlueprint,
} from "../work/index.ts";

export interface AgentSelection {
  blueprint: WorkBlueprint;
  agent: string;
  orchestrate: boolean;
}
/** Factory-owned requirement, fulfilled structurally by Work. */
export interface AgentSkills {
  bindSkills(ids: readonly string[]): BoundSkill[];
}
export interface WorkToolSurface {
  readonly extension: Extension;
  readonly orchestrationTools: readonly ToolRegistration[];
  readonly parentTools: readonly ToolRegistration[];
}
export class AgentFactory {
  readonly config: WorkConfig;
  readonly sandboxCwd: string;
  private readonly skills: AgentSkills;
  private readonly work: WorkToolSurface;
  constructor(
    config: WorkConfig,
    skills: AgentSkills,
    work: WorkToolSurface,
    sandboxCwd = "/workspace",
  ) {
    this.config = config;
    this.skills = skills;
    this.work = work;
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
    selection: AgentSelection,
    extension: Extension,
  ): Promise<BoundAgent> {
    const binding = frozenEntry(selection.blueprint, selection.agent);
    const tools: ToolRegistration[] = [
      ...(CodingTools.tools ?? []),
      ...this.work.parentTools,
    ];
    if (selection.orchestrate) {
      tools.push(...this.work.orchestrationTools);
    }
    if (binding.skills.length > 0) {
      const readSkill = extension.tools?.find(
        (tool) => tool.name === "read_skill",
      );
      if (!readSkill) {
        throw new Error("Agent extension lacks read_skill");
      }
      tools.push(readSkill);
    }
    await configure(tx, id, {
      model: { ...binding.template.model },
      thinkingLevel: binding.template.thinkingLevel ?? null,
      extensions: [CodingTools, extension, this.work.extension],
      tools,
      instructions: this.renderInstructions(binding, selection),
      cwd: this.sandboxCwd,
    });
    return binding;
  }
  private renderInstructions(
    binding: BoundAgent,
    selection: AgentSelection,
  ): string {
    let instructions = `${binding.template.instructions}\n\nYou are Kaeno WORK, responsible for one task. You run in your own sandbox with shell and file tools: do the work yourself and verify it. Messages from whoever started you may arrive while you work. If you cannot proceed without a decision or input, call message_parent and stop. Your final answer is your report: concise, verified and complete.`;
    if (selection.orchestrate) {
      const choices = binding.template.delegates
        .map((name) =>
          this.describeTemplate(frozenEntry(selection.blueprint, name)),
        )
        .join("\n");
      instructions += `\n\nYou may hand independent parts to child WORK with start_work; each gets its own sandbox and sees only its brief. Child messages and reports arrive later as messages: reply with message_work. While children run, end your turn; their messages wake you. Do not give your final report while children are still running.\n\nChild work templates:\n${choices}`;
    }
    return instructions;
  }
  private describeTemplate(binding: BoundAgent): string {
    const skills = binding.skills
      .filter((skill) => !skill.disableModelInvocation)
      .map((skill) => `\n  skill ${skill.id}: ${skill.description}`)
      .join("");
    return `- ${binding.template.name}: ${binding.template.description}${skills}`;
  }
}
