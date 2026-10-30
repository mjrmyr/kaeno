// WORK: one durable agent conversation, optionally in its own environment. CHAT starts root WORK; WORK may
// start child WORK up to maxDepth. Communication follows parent↔child edges only: messages go down, messages and
// reports go up. Every agent may delegate to every agent in the plan frozen at root admission.
import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  type ConversationId,
  type Extension,
  type TaskId,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Binding } from "../conversation/index.ts";
import type { Origin } from "../turns/index.ts";
import { cancelWork, createWorkCommands } from "./commands.ts";
import { listWork } from "./directory.ts";
import type {
  WorkRuntime,
  WorkSettings,
  WorkTurns,
  WorkView,
} from "./model.ts";
import { describeAgents, resolveAgentId } from "./plan.ts";
import {
  assertSavedWorkFits,
  reconcileEnvironment,
  validateSavedBindings,
} from "./recovery.ts";
import { createWorkTask } from "./task.ts";
import { WORK_EXTENSION } from "./tools.ts";
/** Public WORK API and composition; mutable lifecycle state remains in durable records. */
export class Work {
  readonly extension: Extension;
  /** Tools for whoever may start and steer child WORK: CHAT, and WORK below the depth limit. */
  readonly orchestrationTools: ToolRegistration[];
  /** Tools every WORK has for talking to its parent. */
  readonly parentTools: ToolRegistration[];
  private readonly harness: () => WorkRuntime;
  private readonly turns: WorkTurns;
  private readonly settings: WorkSettings;
  private readonly launchRoot: ReturnType<
    typeof createWorkCommands
  >["launchRoot"];
  constructor(
    harness: () => WorkRuntime,
    turns: WorkTurns,
    settings: WorkSettings,
  ) {
    this.harness = harness;
    this.turns = turns;
    this.settings = settings;
    const task = createWorkTask(harness, turns, settings);
    const commands = createWorkCommands(harness, turns, settings, task);
    this.orchestrationTools = commands.orchestrationTools;
    this.parentTools = commands.parentTools;
    this.launchRoot = commands.launchRoot;
    this.extension = defineExtension({
      name: WORK_EXTENSION,
      tools: [...this.orchestrationTools, ...this.parentTools],
      tasks: [task],
    });
  }
  /** Model-facing guidance for CHAT, listing every agent it may start. */
  describeForChat(): string {
    return [
      "You support delegation with start_work. Delegate substantial or parallelizable work when an agent is available.",
      "Use a complete, self-contained brief. Work runs asynchronously; continue responding instead of waiting for it.",
      "Use list_work and inspect_work for progress, message_work for clarification, and cancel_work to stop work. You may start follow-on work, steer workers and cancel unnecessary work when processing their reports, without waiting for another user message. Stay within the user's objective. Progress updates do not pause work and need no reply; resolve worker questions yourself when you have enough context, otherwise ask the user and forward their answer with message_work.",
      "Available agents (use the ID with start_work):",
      describeAgents(this.settings.agents) ||
        "No worker agents are configured. You cannot start new work until an agent is configured; this does not remove your delegation capability or prevent managing existing work.",
    ].join("\n");
  }
  async assertSavedWorkFits(context: Context): Promise<void> {
    await assertSavedWorkFits(this.harness, this.settings, context);
  }
  async validateSavedBindings(
    validate: (binding: Binding) => void,
    context: Context,
  ): Promise<void> {
    await validateSavedBindings(this.harness, validate, context);
  }
  async reconcileEnvironment(context: Context): Promise<void> {
    await reconcileEnvironment(this.harness, this.settings, context);
  }
  /** The configured agent a requested name refers to; throws when unknown or ambiguous. */
  resolveAgent(requested: string): string {
    return resolveAgentId(
      requested,
      this.settings.agents.map((agent) => agent.id),
    );
  }
  /**
   * Start root WORK for the host, reporting to `origin` like work started there. The same `key`
   * always finds the same work, so a retried start never launches twice.
   */
  startWork(
    request: {
      origin: Origin;
      key: string;
      agent: string;
      title: string;
      brief: string;
    },
    context: Context,
  ): Promise<TaskId> {
    return this.launchRoot(request, context);
  }
  async listWork(conversationId: ConversationId): Promise<WorkView[]> {
    return listWork(this.harness, conversationId);
  }
  async cancelWork(
    conversationId: ConversationId,
    id?: TaskId,
  ): Promise<TaskId[]> {
    return cancelWork(this.harness, this.turns, conversationId, id);
  }
}
