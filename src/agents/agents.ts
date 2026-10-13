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
import { randomBytes } from "node:crypto";
import {
  readSkillDocument,
  skillPrompt,
  type SandboxImages,
  type SkillCopySelection,
} from "../skills/index.ts";
import type { WorkBlueprint } from "../work/index.ts";
import { AgentFactory } from "./agent-factory.ts";
import { agentLogHooks, type AgentTraceLogger } from "./agent-logs.ts";
import { AgentState, persistAgentBinding, podName } from "./agent-state.ts";
export interface AgentRuntime extends Pick<Harness, "snapshot"> {}
export interface ManagedSandboxRecord {
  pod: string;
  token: string;
  images: SandboxImages;
  skillCacheClaim: string;
}
/** Agent-owned requirement, fulfilled structurally by SandboxManager. */
export interface AgentSandboxes {
  ensureSandbox(
    launch: {
      sandbox: ManagedSandboxRecord;
      selection: SkillCopySelection;
      conversationId: string;
      taskId: TaskId;
      template: string;
    },
    ctx: Context,
  ): Promise<void>;
  removeSandbox(pod: string): Promise<void>;
  getExecutionEnvironment(
    sandbox: ManagedSandboxRecord,
    cwd: string,
  ): ExecutionEnv;
  sweepOrphanedSandboxes(): Promise<void>;
}
export class Agent {
  readonly extension: Extension;
  private readonly factory: AgentFactory;
  private readonly harness: () => AgentRuntime;
  private readonly sandboxes: AgentSandboxes;
  private readonly images: SandboxImages;
  private readonly skillCacheClaim: string;
  constructor(
    factory: AgentFactory,
    harness: () => AgentRuntime,
    sandboxes: AgentSandboxes,
    images: SandboxImages,
    skillCacheClaim: string,
    logger: AgentTraceLogger,
  ) {
    this.factory = factory;
    this.harness = harness;
    this.sandboxes = sandboxes;
    this.images = images;
    this.skillCacheClaim = skillCacheClaim;
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
      tools: [readSkill],
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
    );
  }
  /** Configure a WORK conversation and reserve its sandbox identity; the pod starts in provisionWorkSandbox. */
  async configureWorkConversation(
    tx: Tx,
    id: ConversationId,
    setup: {
      blueprint: WorkBlueprint;
      agent: string;
      workId: TaskId;
      orchestrate: boolean;
    },
  ): Promise<void> {
    const binding = await this.factory.configureAgent(
      tx,
      id,
      {
        role: "work",
        blueprint: setup.blueprint,
        agent: setup.agent,
        orchestrate: setup.orchestrate,
      },
      this.extension,
    );
    await persistAgentBinding(tx, id, binding, {
      role: "work",
      workId: setup.workId,
    });
    const state = await tx.doc(AgentState, id);
    state.sandbox = {
      pod: podName(id),
      token: randomBytes(24).toString("hex"),
      images: { execution: setup.blueprint.images.execution },
      skillCacheClaim: setup.blueprint.skillCacheClaim,
    };
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
  async provisionWorkSandbox(
    id: ConversationId,
    workId: TaskId,
    ctx: Context,
  ): Promise<void> {
    const state = await this.harness().snapshot(AgentState, id, ctx);
    if (!state?.sandbox || !state.template) {
      throw new Error(`WORK conversation ${id} has no sandbox record`);
    }
    await this.sandboxes.ensureSandbox(
      {
        sandbox: state.sandbox,
        selection: (state.skills ?? []).map((skill) => ({
          id: skill.id,
          treeHash: skill.treeHash,
        })),
        conversationId: String(id),
        taskId: workId,
        template: state.template,
      },
      ctx,
    );
  }
  async releaseWorkSandbox(id: ConversationId): Promise<void> {
    const sandbox = (
      await this.harness().snapshot(AgentState, id, BACKGROUND_CONTEXT)
    )?.sandbox;
    if (sandbox) {
      await this.sandboxes.removeSandbox(sandbox.pod);
    }
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
}
