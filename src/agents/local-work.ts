import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { randomBytes } from "node:crypto";
import { defineExtension } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Extension,
  TaskId,
  Tx,
} from "@earendil-works/pi-durable";
import type { EnvTarget, Harness } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { WorkToolSurface } from "./agent-factory.ts";
import type { SandboxProvider } from "../sandbox/index.ts";
import { AgentFactory, type AgentSkills } from "./agent-factory.ts";
import { AgentState, persistAgentBinding } from "./state.ts";
import type {
  WorkAgents,
  WorkBlueprint,
  WorkConfig,
  WorkSetup,
} from "../work/index.ts";
import type { SandboxIdentity, SandboxLimits } from "../sandbox/index.ts";

class EmptySkills implements AgentSkills {
  bindSkills(): [] {
    return [];
  }
}

export class LocalWorkAgents implements WorkAgents {
  readonly extension: Extension;
  private readonly factory: AgentFactory;
  private readonly sandbox: SandboxProvider;
  private readonly image: string;
  private readonly limits: SandboxLimits;
  private readonly maxConcurrent: number;
  private readonly harness: () => Harness;

  constructor(options: {
    config: WorkConfig;
    sandbox: SandboxProvider;
    image: string;
    limits: SandboxLimits;
    maxConcurrent: number;
    work: WorkToolSurface;
    harness: () => Harness;
  }) {
    this.sandbox = options.sandbox;
    this.image = options.image;
    this.limits = options.limits;
    this.maxConcurrent = options.maxConcurrent;
    this.harness = options.harness;
    this.factory = new AgentFactory(
      options.config,
      new EmptySkills(),
      options.work,
    );
    this.extension = defineExtension({ name: "kaeno-work-agent" });
  }

  captureWorkBlueprint(agent: string): WorkBlueprint {
    return this.factory.captureWorkBlueprint(
      agent,
      { execution: this.image },
      "local",
    );
  }

  async configureWorkConversation(
    tx: Tx,
    id: ConversationId,
    setup: WorkSetup,
  ): Promise<void> {
    const binding = await this.factory.configureAgent(
      tx,
      id,
      {
        blueprint: setup.blueprint,
        agent: setup.agent,
        orchestrate: setup.orchestrate,
      },
      this.extension,
    );
    await persistAgentBinding(tx, id, binding, setup.workId);
    const state = await tx.doc(AgentState, id);
    state.sandbox = {
      id: `work-${setup.workId}`,
      token: randomBytes(32).toString("hex"),
      image: setup.blueprint.images.execution,
    };
  }

  async provisionWorkSandbox(
    id: ConversationId,
    workId: TaskId,
    context: Context,
  ): Promise<void> {
    const state = await this.harness().snapshot(AgentState, id, context);
    if (!state?.sandbox) {
      throw new Error(`WORK #${workId} has no persisted sandbox identity`);
    }
    await this.sandbox.ensure(
      state.sandbox,
      { cwd: "/workspace", limits: this.limits },
      context.abortSignal,
    );
  }

  async releaseWorkSandbox(id: ConversationId): Promise<void> {
    const state = await this.harness().snapshot(
      AgentState,
      id,
      BACKGROUND_CONTEXT,
    );
    if (state?.sandbox) {
      await this.sandbox.remove(state.sandbox);
    }
  }

  async getExecutionEnvironment(
    target: EnvTarget,
    context: Context,
  ): Promise<ExecutionEnv | undefined> {
    const state = await target.read.snapshot(
      AgentState,
      target.conversationId,
      context,
    );
    if (!state?.sandbox) {
      return undefined;
    }
    return this.sandbox.executionEnvironment(
      state.sandbox,
      target.cwd ?? "/workspace",
    );
  }

  async sweepOrphanedSandboxes(): Promise<void> {
    const inspection = await this.harness().inspect(BACKGROUND_CONTEXT);
    const active = inspection.tasks.flatMap(({ record }) =>
      record.kind === "kaeno.work" && record.state.status !== "terminal"
        ? [record.id]
        : [],
    );
    const identities: SandboxIdentity[] = [];
    for (const workId of active) {
      const child = (
        await this.harness().commit(
          (tx) => tx.scanConversations({ ownerTaskId: workId }, 1),
          BACKGROUND_CONTEXT,
        )
      ).items[0];
      if (!child) {
        continue;
      }
      const state = await this.harness().snapshot(
        AgentState,
        child.id,
        BACKGROUND_CONTEXT,
      );
      if (state?.sandbox) {
        identities.push(state.sandbox);
      }
    }
    await this.sandbox.reconcile(identities);
  }

  async sandboxPool(): Promise<{ slots: number; summary: string }> {
    return {
      slots: this.maxConcurrent,
      summary: `local Docker pool, maximum ${this.maxConcurrent} containers`,
    };
  }
}
