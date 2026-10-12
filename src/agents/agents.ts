import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type ConversationId,
  type EnvTarget,
  type Extension,
  type Harness,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
  readSkillDocument,
  skillPrompt,
  type SandboxImages,
} from "../skills/index.ts";
import { readBlueprint, type WorkBlueprint } from "../work/index.ts";
import { AgentFactory } from "./agent-factory.ts";
import { agentLogHooks, type AgentTraceLogger } from "./agent-logs.ts";
import { AgentState, persistAgentBinding } from "./agent-state.ts";
import { AgentDelegation, type AgentSandboxes } from "./delegation.ts";
export interface AgentRuntime extends Pick<Harness, "getTask" | "snapshot"> {}
export class Agent {
  readonly extension: Extension;
  private readonly factory: AgentFactory;
  private readonly delegation: AgentDelegation;
  private readonly harness: () => AgentRuntime;
  private readonly sandboxes: AgentSandboxes;
  private readonly images: SandboxImages;
  private readonly skillCacheClaim: string;
  constructor(
    factory: AgentFactory,
    delegation: AgentDelegation,
    harness: () => AgentRuntime,
    sandboxes: AgentSandboxes,
    images: SandboxImages,
    skillCacheClaim: string,
    logger: AgentTraceLogger,
  ) {
    this.factory = factory;
    this.delegation = delegation;
    this.harness = harness;
    this.sandboxes = sandboxes;
    this.images = images;
    this.skillCacheClaim = skillCacheClaim;
    const delegate = defineTool({
      name: "delegate",
      description:
        "Delegate a self-contained task to a new sub-agent created from an agent template and get its final report back. Sandboxed templates get their own isolated container, which is deleted when the task ends.",
      parameters: Type.Object({
        agent: Type.String({ description: "Agent template to use" }),
        task: Type.String({
          description:
            "Complete, self-contained instructions; the sub-agent sees nothing else",
        }),
      }),
      replay: "safe",
      execute: (args, api, ctx) =>
        this.delegation.executeDelegation(args, api, ctx, this.extension),
    });
    const readSkill = defineTool({
      name: "read_skill",
      description:
        "Load instructions or a referenced text file from a skill assigned to this agent. Does not grant new tools.",
      parameters: Type.Object({
        skill: Type.String({ description: "Qualified owner/repo:skill-name" }),
        file: Type.Optional(
          Type.String({
            description: "Relative text file, defaults to SKILL.md",
          }),
        ),
      }),
      replay: "safe",
      execute: async (args, api, ctx) => {
        const binding =
          (await api.snapshot(AgentState, api.conversationId, ctx))?.skills ??
          [];
        const loaded = readSkillDocument(binding, args);
        return {
          content: [
            {
              type: "text",
              text: `Skill directory: ${loaded.sandboxRoot}\n\n${loaded.text}`,
            },
          ],
        };
      },
    });
    this.extension = defineExtension({
      name: "kaeno",
      tools: [delegate, readSkill],
      hooks: agentLogHooks(AgentState, logger),
      sections: [
        section("skills", async ({ conversationId, read }, ctx) =>
          skillPrompt(
            (await read.snapshot(AgentState, conversationId, ctx))?.skills ??
              [],
          ),
        ),
      ],
    });
  }
  captureWorkBlueprint(agent: string): WorkBlueprint {
    return this.factory.captureWorkBlueprint(
      agent,
      this.images,
      this.skillCacheClaim,
      this.extension,
    );
  }
  async configureWorkConversation(
    tx: Tx,
    id: ConversationId,
    value: WorkBlueprint,
    workId?: TaskId,
  ): Promise<void> {
    const blueprint = readBlueprint(value);
    const binding = await this.factory.configureAgent(
      tx,
      id,
      { role: "work", blueprint },
      this.extension,
    );
    await persistAgentBinding(tx, id, binding, {
      role: "work",
      workId,
      blueprint,
    });
  }
  async configureChatConversation(tx: Tx, id: ConversationId): Promise<void> {
    const binding = await this.factory.configureAgent(
      tx,
      id,
      { role: "chat" },
      this.extension,
    );
    await persistAgentBinding(tx, id, binding, { role: "chat" });
  }
  async isWorkClean(workId: TaskId): Promise<boolean> {
    for (const reservation of await this.sandboxes.listReservations()) {
      const task = await this.harness().getTask(
        reservation.id,
        BACKGROUND_CONTEXT,
      );
      if (
        task &&
        (
          await this.harness().snapshot(
            AgentState,
            task.conversationId,
            BACKGROUND_CONTEXT,
          )
        )?.workId === workId
      ) {
        return false;
      }
    }
    return true;
  }
  getExecutionEnvironment = async (
    { conversationId, cwd, read }: EnvTarget,
    ctx: Context,
  ): Promise<ExecutionEnv | undefined> => {
    const sandbox = (await read.snapshot(AgentState, conversationId, ctx))
      ?.sandbox;
    if (!sandbox) {
      return undefined;
    }
    return this.sandboxes.getExecutionEnvironment(
      sandbox,
      cwd ?? this.factory.sandboxCwd,
    );
  };
  sweepOrphanedSandboxes(): Promise<void> {
    return this.sandboxes.sweepOrphanedSandboxes();
  }
  shutdown(): void {
    this.delegation.shutdown();
  }
}
