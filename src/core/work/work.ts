import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  type ConversationId,
  type Extension,
  type TaskId,
  type ToolRegistration,
  type UserInput,
} from "@earendil-works/pi-durable";
import type { Binding } from "../conversation/index.ts";
import { createWorkCommands, NoWorkSlot } from "./commands.ts";
import type { WorkReports, WorkRuntime, WorkSettings } from "./model.ts";
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
  readonly orchestrationTools: ToolRegistration[];
  /** Tools every WORK has for talking to its parent. */
  readonly parentTools: ToolRegistration[];
  private readonly harness: () => WorkRuntime;
  private readonly settings: WorkSettings;
  private readonly launchAssignment: ReturnType<
    typeof createWorkCommands
  >["launchAssignment"];
  constructor(
    harness: () => WorkRuntime,
    reports: WorkReports,
    settings: WorkSettings,
  ) {
    this.harness = harness;
    this.settings = settings;
    const task = createWorkTask(harness, reports, settings);
    const commands = createWorkCommands(harness, reports, settings, task);
    this.orchestrationTools = commands.orchestrationTools;
    this.parentTools = commands.parentTools;
    this.launchAssignment = commands.launchAssignment;
    this.extension = defineExtension({
      name: WORK_EXTENSION,
      tools: [...this.orchestrationTools, ...this.parentTools],
      tasks: [task],
    });
  }
  describeAgents(): string {
    return describeAgents(this.settings.agents);
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
   * Start one Assignment of a ticket on its conversation. The same `key` always finds the same work, so a
   * retried launch never starts twice. Throws `NoWorkSlot` when every slot is taken.
   */
  launch(
    request: {
      owner: ConversationId;
      key: string;
      ticket: string;
      agent: string;
      title: string;
      content: UserInput;
      conversation: ConversationId;
      reserve: number;
    },
    context: Context,
  ): Promise<TaskId> {
    return this.launchAssignment(request, context);
  }
  isNoSlot(error: unknown): boolean {
    return error instanceof NoWorkSlot;
  }
}
