import type { Context } from "@earendil-works/chord";
import {
  AssistantEntry,
  UsageDoc,
  type Extension,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { randomBytes } from "node:crypto";
import { requireConversation } from "../durable/index.ts";
import type {
  ManagedSandbox,
  SandboxLaunch,
  SandboxReservation,
} from "../sandboxes/index.ts";
import type { SandboxImages } from "../skills/index.ts";
import { frozenEntry, readBlueprint, workRoot } from "../work/index.ts";
import { AgentFactory } from "./agent-factory.ts";
import {
  AgentState,
  persistAgentBinding,
  podName,
  sumUsage,
  textOf,
} from "./agent-state.ts";
export interface AgentSandboxes {
  ensureSandbox(
    launch: SandboxLaunch,
    saveImages: (images: SandboxImages) => Promise<void>,
    ctx: Context,
  ): Promise<void>;
  removeSandbox(pod: string): Promise<void>;
  getExecutionEnvironment(sandbox: ManagedSandbox, cwd: string): ExecutionEnv;
  sweepOrphanedSandboxes(): Promise<void>;
  listReservations(): Promise<SandboxReservation[]>;
}
export interface DelegationRuntime extends Pick<
  ToolExecutionApi,
  | "conversationId"
  | "taskId"
  | "snapshot"
  | "commit"
  | "details"
  | "conversation"
> {}
export interface DelegateRequest {
  agent: string;
  task: string;
}
function failure(text: string): ToolExecutionResult {
  return { content: [{ type: "text", text }], isError: true };
}
export class AgentDelegation {
  private readonly factory: AgentFactory;
  private readonly sandboxes: AgentSandboxes;
  private readonly images: SandboxImages;
  private readonly skillCacheClaim: string;
  private closing = false;
  constructor(
    factory: AgentFactory,
    sandboxes: AgentSandboxes,
    images: SandboxImages,
    skillCacheClaim: string,
  ) {
    this.factory = factory;
    this.sandboxes = sandboxes;
    this.images = images;
    this.skillCacheClaim = skillCacheClaim;
  }
  shutdown(): void {
    this.closing = true;
  }
  async executeDelegation(
    { agent, task }: DelegateRequest,
    api: DelegationRuntime,
    ctx: Context,
    extension: Extension,
  ): Promise<ToolExecutionResult> {
    const callerState = await api.snapshot(AgentState, api.conversationId, ctx);
    if (callerState?.role === "chat") {
      return failure("CHAT starts work; foreground delegation belongs to WORK");
    }
    if (callerState?.role === "worker") {
      return failure("WORKERs are leaves; WORK owns delegation and fanout");
    }
    if (callerState?.role === "work" && !callerState.blueprint) {
      return failure("WORK has no frozen blueprint; cannot delegate safely");
    }
    const blueprint =
      callerState?.blueprint === undefined
        ? undefined
        : readBlueprint(callerState.blueprint);
    const caller = blueprint
      ? workRoot(blueprint).template
      : this.factory.config.templates[
          callerState?.template ?? this.factory.config.agent
        ];
    if (!caller?.delegates.includes(agent)) {
      return failure(
        `Unknown agent template "${agent}". Available: ${caller?.delegates.join(", ") || "none"}`,
      );
    }
    if (blueprint && !Object.hasOwn(blueprint.templates, agent)) {
      return failure(`Missing frozen delegate template "${agent}"`);
    }
    const template = blueprint
      ? frozenEntry(blueprint, agent).template
      : this.factory.config.templates[agent];
    const images = blueprint?.images ?? this.images;
    const skillCacheClaim = blueprint?.skillCacheClaim ?? this.skillCacheClaim;
    const child = await api.commit(async (tx) => {
      const [existing] = (
        await tx.scanConversations({ ownerTaskId: api.taskId }, 1)
      ).items;
      if (existing) {
        const state = await tx.doc(AgentState, existing.id);
        return {
          id: existing.id,
          sandbox: state.sandbox
            ? {
                ...state.sandbox,
                images: state.sandbox.images
                  ? { ...state.sandbox.images }
                  : undefined,
              }
            : undefined,
          selection: (state.skills ?? []).map((skill) => ({
            id: skill.id,
            treeHash: skill.treeHash,
          })),
        };
      }
      const created = await tx.createConversation({
        ownership: { kind: "task", taskId: api.taskId },
      });
      const binding = await this.factory.configureAgent(
        tx,
        created.id,
        { role: "worker", agent, blueprint },
        extension,
      );
      await persistAgentBinding(tx, created.id, binding, {
        role: "worker",
        workId: callerState?.workId,
        blueprint,
      });
      const state = await tx.doc(AgentState, created.id);
      if (template.sandbox) {
        state.sandbox = {
          pod: podName(created.id),
          token: randomBytes(24).toString("hex"),
          images: { execution: images.execution },
          skillCacheClaim,
        };
      }
      return {
        id: created.id,
        sandbox: state.sandbox
          ? { ...state.sandbox, images: { execution: images.execution } }
          : undefined,
        selection: binding.skills.map((skill) => ({
          id: skill.id,
          treeHash: skill.treeHash,
        })),
      };
    }, ctx);
    const details = {
      conversationId: child.id,
      agent,
      ...(child.sandbox ? { pod: child.sandbox.pod } : {}),
    };
    await api.details(details, ctx);
    try {
      if (child.sandbox) {
        await this.sandboxes.ensureSandbox(
          {
            sandbox: child.sandbox,
            selection: child.selection,
            conversationId: String(child.id),
            taskId: api.taskId,
            template: agent,
          },
          (images) =>
            api.commit(async (tx) => {
              const state = await tx.doc(AgentState, child.id);
              if (!state.sandbox) {
                throw new Error(
                  `Stored sandbox for conversation ${child.id} is missing`,
                );
              }
              state.sandbox.images = { ...images };
            }, ctx),
          ctx,
        );
      }
      const conversation = await requireConversation(api, child.id, ctx);
      const submission = await conversation.submit(
        { type: "input", content: task, requestId: `delegate:${api.taskId}` },
        ctx,
      );
      const settled = await submission.wait(ctx);
      const usage = sumUsage(
        (await api.snapshot(UsageDoc, child.id, ctx))?.models ?? {},
      );
      if (settled.status !== "done" || settled.type !== "input") {
        return {
          ...failure(`Sub-agent ${agent} did not finish: ${settled.reason}`),
          details,
          usage,
        };
      }
      const answer = await api.commit(
        (tx) => tx.entry(AssistantEntry, settled.answer),
        ctx,
      );
      return {
        content: [
          {
            type: "text",
            text: textOf(answer?.model?.[0]) || "(empty answer)",
          },
        ],
        details,
        usage,
      };
    } catch (error) {
      if (this.closing) {
        throw error;
      }
      // Recovery: represent the failed child as a tool result so WORK can select another action.
      return {
        ...failure(
          `Sub-agent ${agent} failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
        details,
      };
    } finally {
      if (child.sandbox && !this.closing) {
        await this.sandboxes.removeSandbox(child.sandbox.pod);
      }
    }
  }
}
