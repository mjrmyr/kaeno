// A request's durable orchestration scope. CHAT admits it; WORK owns planning/review and disposable delegates.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type ConversationId,
  type Extension,
  type Harness,
  type TaskId,
  type ToolExecutionApi,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { parseTaskId, requireConversation } from "../durable/index.ts";
import type { Origin, Source } from "../turns/index.ts";
import {
  readBlueprint,
  storageCopy,
  workRoot,
  type Stored,
  type WorkBlueprint,
} from "./work-blueprint.ts";
interface WorkInput {
  title: string;
  brief: string;
  origin: Origin;
  blueprint: Stored<WorkBlueprint>;
}
interface WorkResult {
  status: "completed" | "failed";
  text: string;
}
type WorkState =
  | {
      phase: "start";
    }
  | {
      phase: "run";
      child: ConversationId;
    }
  | {
      phase: "report";
      text: string;
      failed?: boolean;
    };
export interface WorkRuntime extends Pick<
  Harness,
  "snapshot" | "getTask" | "commit" | "abortTask"
> {}
export const WorkIndex = defineDoc<{
  launches: Record<string, TaskId<WorkResult>>;
}>({
  kind: "kaeno.work-index",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ launches: {} }),
});
export interface WorkView {
  id: TaskId;
  title: string;
  status: string;
}
export interface WorkAgents {
  configureWorkConversation(
    tx: Tx,
    id: ConversationId,
    blueprint: WorkBlueprint,
    workId: TaskId,
  ): Promise<void>;
  isWorkClean(id: TaskId): Promise<boolean>;
}
export interface WorkTemplateChoice {
  name: string;
  description: string;
}
export interface WorkTemplateSource {
  listWorkTemplates(): readonly WorkTemplateChoice[];
}
export interface WorkBlueprintSource {
  captureWorkBlueprint(agent: string): WorkBlueprint;
}
export interface WorkTurns {
  getActiveTurn(
    id: ConversationId,
    ctx: Context,
  ): Promise<{
    origin: Origin;
    source: Source;
  }>;
  isOriginFenced(tx: Tx, origin: Origin): Promise<boolean>;
  getPendingReportIds(tx: Tx, id: ConversationId): Promise<TaskId[]>;
  suppressWorkReports(
    tx: Tx,
    id: ConversationId,
    ids: readonly TaskId[],
  ): Promise<void>;
  admitWorkReport(
    tx: Tx,
    workId: TaskId,
    title: string,
    text: string,
    origin: Origin,
  ): Promise<TaskId>;
  admitWorkCancellation(
    tx: Tx,
    id: ConversationId,
    workId: TaskId,
  ): Promise<TaskId>;
}
export class Work {
  readonly extension: Extension;
  readonly tools: ToolRegistration[];
  private readonly harness: () => WorkRuntime;
  private readonly turns: WorkTurns;
  private readonly templates: WorkTemplateSource;
  private readonly agents: () => WorkAgents;
  private readonly blueprints: () => WorkBlueprintSource;
  private readonly maxActive: number;
  constructor(
    harness: () => WorkRuntime,
    turns: WorkTurns,
    templates: WorkTemplateSource,
    agents: () => WorkAgents,
    blueprints: () => WorkBlueprintSource,
    maxActive = 32,
  ) {
    this.harness = harness;
    this.turns = turns;
    this.templates = templates;
    this.agents = agents;
    this.blueprints = blueprints;
    this.maxActive = maxActive;
    const Work = defineTask<Stored<WorkInput>, WorkState, Stored<WorkResult>>({
      name: "kaeno.work",
      version: 1,
      initial: () => ({ phase: "start" }),
      phases: {
        start: (task, runtime, context) =>
          runtime.commit(async (tx) => {
            workRoot(task.input.blueprint);
            const found = (
              await tx.scanConversations({ ownerTaskId: task.id }, 1)
            ).items[0];
            const child =
              found ??
              (await tx.createConversation({
                ownership: { kind: "task", taskId: task.id },
              }));
            if (!found) {
              await this.agents().configureWorkConversation(
                tx,
                child.id,
                task.input.blueprint,
                task.id,
              );
            }
            return {
              status: "running",
              checkpoint: { phase: "run", child: child.id },
            };
          }, context),
        run: async (task, runtime, context) => {
          try {
            workRoot(task.input.blueprint);
            const child = await requireConversation(
              runtime,
              task.state.checkpoint.child,
              context,
            );
            const submission = await child.submit(
              {
                type: "input",
                content: task.input.brief,
                requestId: `work:${task.id}`,
              },
              context,
            );
            const settled = await submission.wait(context);
            if (settled.status === "done" && settled.type === "input") {
              await runtime.commit(async (tx) => {
                const entry = await tx.entry(AssistantEntry, settled.answer);
                const content = entry?.model?.[0]?.content ?? [];
                const answer =
                  typeof content === "string"
                    ? content
                    : content
                        .flatMap((contentValue) =>
                          contentValue.type === "text"
                            ? [contentValue.text]
                            : [],
                        )
                        .join("");
                return {
                  status: "running",
                  checkpoint: {
                    phase: "report",
                    text: answer.slice(0, 64000) || "(empty work report)",
                  },
                };
              }, context);
            } else {
              await runtime.commit(
                () => ({
                  status: "running",
                  checkpoint: {
                    phase: "report",
                    failed: true,
                    text: `Work failed: ${settled.reason}`,
                  },
                }),
                context,
              );
            }
          } catch (error) {
            if (runtime.signal.aborted || context.abortSignal?.aborted) {
              throw error;
            }
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: {
                  phase: "report",
                  failed: true,
                  text: `Work failed: ${String(error)}`,
                },
              }),
              context,
            );
          }
        },
        report: (task, runtime, context) =>
          runtime.commit(async (tx) => {
            const { origin, title } = task.input;
            await this.turns.admitWorkReport(
              tx,
              task.id,
              title,
              task.state.checkpoint.text,
              origin,
            );
            return {
              status: "terminal",
              outcome: {
                status: "completed",
                result: {
                  status: task.state.checkpoint.failed ? "failed" : "completed",
                  text: task.state.checkpoint.text,
                },
              },
            };
          }, context),
      },
      abort: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          await this.turns.suppressWorkReports(tx, task.conversationId, [
            task.id,
          ]);
          return { status: "terminal", outcome: { status: "aborted" } };
        }, context),
    });
    const choices = this.templates.listWorkTemplates();
    const start = defineTool({
      name: "start_work",
      description:
        "Start a durable WORK conversation in the background. It can reason itself or delegate execution to workers. Returns immediately; then give the user a concise plan and end this chat turn.",
      parameters: Type.Object({
        agent: Type.String({
          enum: choices.map((template) => template.name),
          description:
            "WORK template to select explicitly: " +
            choices
              .map((template) => `${template.name}: ${template.description}`)
              .join("; "),
        }),
        title: Type.String({ minLength: 1, maxLength: 160 }),
        brief: Type.String({ minLength: 1, maxLength: 64000 }),
      }),
      replay: "safe",
      execute: async ({ agent, title, brief }, api, context) => {
        const origin = await this.resolveAuthorizedOrigin(api, context);
        const admitted = await api.commit(async (tx) => {
          if (await this.turns.isOriginFenced(tx, origin)) {
            throw new Error("This turn was fenced by stop/reset");
          }
          const index = await tx.doc(WorkIndex, api.conversationId);
          const existing = index.launches[origin.requestId];
          if (existing) {
            const record = await tx.task(existing);
            if (!record) {
              throw new Error(`Admitted work ${existing} is missing`);
            }
            const prior = z
              .object({
                title: z.string(),
                brief: z.string(),
                blueprint: z.unknown(),
              })
              .parse(record.input);
            const priorBlueprint = readBlueprint(prior.blueprint);
            if (prior.title !== title || prior.brief !== brief) {
              throw new Error(
                "One WORK conversation owns this request; put all subtasks in its brief",
              );
            }
            workRoot(priorBlueprint);
            // pi-durable execute-phase replay bypasses schema validation. Old admitted calls had no agent.
            if (agent !== undefined && agent !== priorBlueprint.agent) {
              throw new Error(
                "This request already selected a different WORK template",
              );
            }
            return { id: existing, agent: priorBlueprint.agent };
          }
          const eligible = this.templates.listWorkTemplates();
          if (
            typeof agent !== "string" ||
            !eligible.some((template) => template.name === agent)
          ) {
            throw new Error(
              `start_work requires an explicit eligible agent template: ${eligible.map((template) => template.name).join(", ")}; old unadmitted calls cannot be resumed without selection`,
            );
          }
          const blueprint = this.blueprints().captureWorkBlueprint(agent);
          workRoot(blueprint);
          const live = [];
          for (const status of [
            "pending",
            "running",
            "waiting",
            "completing",
          ] as const) {
            live.push(
              ...(
                await tx.scanTasks(
                  {
                    conversationId: api.conversationId,
                    kind: "kaeno.work",
                    status,
                  },
                  this.maxActive + 1,
                )
              ).items,
            );
          }
          if (live.length >= this.maxActive) {
            throw new Error(
              `This chat has ${this.maxActive} active work requests; cancel or wait before adding more`,
            );
          }
          const activeIds = new Set<number>(live.map((task) => task.id));
          for (const reportId of await this.turns.getPendingReportIds(
            tx,
            api.conversationId,
          )) {
            activeIds.add(reportId);
          }
          const history = Object.entries(index.launches);
          for (const [key, id] of history.slice(
            0,
            Math.max(0, history.length - 511),
          )) {
            if (!activeIds.has(id)) {
              delete index.launches[key];
            }
          }
          const created = await tx.createTask(
            Work,
            { title, brief, origin, blueprint: storageCopy(blueprint) },
            {
              ownership: { kind: "conversation" },
              conversationId: api.conversationId,
              background: true,
            },
          );
          index.launches[origin.requestId] = created;
          return { id: created, agent: blueprint.agent };
        }, context);
        const { id, agent: selected } = admitted;
        return {
          content: [
            {
              type: "text",
              text: `Accepted work #${id}: ${title} (template ${selected}). It runs independently; do not wait for it. Explain your plan and answer the user now.`,
            },
          ],
          details: { workId: id, agent: selected },
        };
      },
    });
    const status = defineTool({
      name: "list_work",
      description:
        "List work requests belonging to this chat and their durable status.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(await this.listWork(api.conversationId)),
          },
        ],
      }),
    });
    const stop = defineTool({
      name: "cancel_work",
      description:
        "Request cancellation of one work ID in this chat. Cancellation finishes only after descendants and sandboxes are cleaned up.",
      parameters: Type.Object({ id: Type.Integer({ minimum: 1 }) }),
      replay: "safe",
      execute: async ({ id }, api, context) => {
        const origin = await this.resolveAuthorizedOrigin(api, context);
        await api.commit(async (tx) => {
          if (await this.turns.isOriginFenced(tx, origin)) {
            throw new Error("This turn was fenced by stop/reset");
          }
          return this.turns.admitWorkCancellation(
            tx,
            api.conversationId,
            parseTaskId(id),
          );
        }, context);
        return {
          content: [
            { type: "text", text: `Cancellation requested for work #${id}.` },
          ],
        };
      },
    });
    const extension = defineExtension({
      name: "kaeno-work",
      tools: [start, status, stop],
      tasks: [Work],
    });
    this.extension = extension;
    this.tools = [start, status, stop];
  }
  async listWork(conversationId: ConversationId): Promise<WorkView[]> {
    const index = await this.harness().snapshot(
      WorkIndex,
      conversationId,
      BACKGROUND_CONTEXT,
    );
    const result: WorkView[] = [];
    for (const id of Object.values(index?.launches ?? {})) {
      const record = await this.harness().getTask<WorkResult>(
        id,
        BACKGROUND_CONTEXT,
      );
      if (!record) {
        continue;
      }
      const input = z.object({ title: z.string() }).parse(record.input);
      let status: string = record.state.status;
      if (record.abortRequested && record.state.status !== "terminal") {
        status = "cancelling";
      } else if (record.state.status === "terminal") {
        status =
          record.state.outcome.status === "completed"
            ? record.state.outcome.result.status
            : record.state.outcome.status;
        if (record.abortRequested && !(await this.agents().isWorkClean(id))) {
          status = "cancelling";
        }
      }
      result.push({ id, title: input.title, status });
    }
    return result;
  }
  async cancelWork(
    conversationId: ConversationId,
    id?: TaskId,
  ): Promise<TaskId[]> {
    const jobs = await this.listWork(conversationId);
    if (id !== undefined && !jobs.some((job) => job.id === id)) {
      throw new Error(`No work #${id} belongs to this chat`);
    }
    const chosen = jobs.filter(
      (job) =>
        (id === undefined || job.id === id) &&
        !["completed", "failed", "aborted", "faulted", "orphaned"].includes(
          job.status,
        ),
    );
    // Suppress before marking: a finishing Work's concurrently created result Turn must not slip through.
    await this.harness().commit(
      (tx) =>
        this.turns.suppressWorkReports(
          tx,
          conversationId,
          jobs
            .filter((job) => id === undefined || job.id === id)
            .map((job) => job.id),
        ),
      BACKGROUND_CONTEXT,
    );
    for (const job of chosen) {
      await this.harness().abortTask(job.id, BACKGROUND_CONTEXT);
    }
    return chosen.map((job) => job.id);
  }
  private async resolveAuthorizedOrigin(
    api: ToolExecutionApi,
    context: Context,
  ): Promise<Origin> {
    const turn = await this.turns.getActiveTurn(api.conversationId, context);
    if (
      await this.harness().commit(
        (tx) => this.turns.isOriginFenced(tx, turn.origin),
        context,
      )
    ) {
      throw new Error("This turn was fenced by stop/reset");
    }
    if (turn.source.kind === "work-result") {
      throw new Error(
        "Work-result turns are read-only; only a user can start/cancel work",
      );
    }
    return turn.origin;
  }
}
export interface WorkController {
  readonly extension: Extension;
  readonly tools: ToolRegistration[];
  listWork(id: ConversationId): Promise<WorkView[]>;
  cancelWork(id: ConversationId, workId?: TaskId): Promise<TaskId[]>;
}
