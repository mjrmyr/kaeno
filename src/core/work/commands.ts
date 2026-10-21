// Caller-side authority, replay-safe admission, steering and cancellation.
import { copyJson, type Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ConversationId,
  type TaskId,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { parseTaskId, requireConversation } from "../durable/index.ts";
import type { Origin } from "../turns/index.ts";
import { inspectWork, listWork, liveWork, requireChild } from "./directory.ts";
import {
  WorkIndex,
  WorkScope,
  jsonValueSchema,
  type WorkParent,
  type WorkRuntime,
  type WorkSettings,
  type WorkTask,
  type WorkTurns,
} from "./model.ts";
import {
  assertPlanFits,
  planFor,
  readPlan,
  resolveAgentId,
  storedPlan,
  type WorkPlan,
} from "./plan.ts";
import {
  CANCEL_WORK,
  INSPECT_WORK,
  LIST_WORK,
  MESSAGE_PARENT,
  MESSAGE_WORK,
  START_WORK,
} from "./tools.ts";
const FINISHED = ["completed", "failed", "aborted", "faulted", "orphaned"];
interface WorkCommands {
  orchestrationTools: ToolRegistration[];
  parentTools: ToolRegistration[];
}
export function createWorkCommands(
  harness: () => WorkRuntime,
  turns: WorkTurns,
  settings: WorkSettings,
  task: WorkTask,
): WorkCommands {
  const maxActive = settings.maxActive ?? 32;
  /** Pure: the root plan for a requested agent, from the agents loaded at startup. */
  function prepareRootPlan(requested: string): WorkPlan {
    const agents = settings.agents;
    if (agents.length === 0) {
      throw new Error(
        "No worker agents are configured. Configure at least one available agent before starting work. You can still list, inspect, message or cancel existing work.",
      );
    }
    return planFor(
      resolveAgentId(
        requested,
        agents.map((agent) => agent.id),
      ),
      agents,
    );
  }
  async function resolveAuthorizedOrigin(
    api: ToolExecutionApi,
    context: Context,
  ): Promise<Origin> {
    const turn = await turns.getActiveTurn(api.conversationId, context);
    if (
      await harness().commit(
        (tx) => turns.isOriginFenced(tx, turn.origin),
        context,
      )
    ) {
      throw new Error("This turn was fenced by stop/reset");
    }
    if (turn.source.kind === "activity-result") {
      throw new Error(
        "Work-result turns are read-only; only a user can start, message or cancel work",
      );
    }
    return turn.origin;
  }
  const start = defineTool({
    name: START_WORK,
    description:
      "Start a WORK agent. Returns immediately; its messages and final report arrive later as messages. Pick an agent listed in your instructions and give a complete, self-contained brief.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent ID from your instructions" }),
      title: Type.String({ minLength: 1, maxLength: 160 }),
      brief: Type.String({ minLength: 1, maxLength: 64000 }),
    }),
    replay: "safe",
    execute: async ({ agent, title, brief }, api, context) => {
      const caller = await api.snapshot(WorkScope, api.conversationId, context);
      const isRoot = caller === undefined || caller.workId === null;
      const parent: WorkParent = isRoot
        ? {
            kind: "chat",
            origin: await resolveAuthorizedOrigin(api, context),
          }
        : { kind: "work", conversationId: api.conversationId };
      // A replayed call that already launched its work keeps it; a new root plan is prepared outside
      // the admission transaction from the agents loaded at startup, then saved inside it.
      const launched = (
        await api.snapshot(WorkIndex, api.conversationId, context)
      )?.launches[String(api.taskId)];
      const rootPlan =
        launched === undefined && isRoot ? prepareRootPlan(agent) : undefined;
      const capacity =
        launched === undefined
          ? await settings.environment?.capacity?.(context)
          : undefined;
      const limit = Math.min(
        settings.maxConcurrent,
        capacity ?? settings.maxConcurrent,
      );
      const id = await api.commit(async (tx) => {
        if (
          parent.kind === "chat" &&
          (await turns.isOriginFenced(tx, parent.origin))
        ) {
          throw new Error("This turn was fenced by stop/reset");
        }
        const index = await tx.doc(WorkIndex, api.conversationId);
        // The tool call is the idempotency key: a replayed call finds its work; separate calls start separate work.
        const existing = index.launches[String(api.taskId)];
        if (existing) {
          return existing;
        }
        let plan: WorkPlan;
        let agentId: string;
        let depth: number;
        if (isRoot) {
          if (!rootPlan) {
            throw new Error("Work launch changed during admission; retry");
          }
          plan = rootPlan;
          agentId = rootPlan.root;
          depth = 1;
        } else {
          plan = readPlan(caller.plan);
          if (caller.maxDepth === null || caller.depth >= caller.maxDepth) {
            throw new Error(
              "This WORK is at the maximum nesting depth and cannot start child work",
            );
          }
          agentId = resolveAgentId(agent, Object.keys(plan.agents));
          depth = caller.depth + 1;
        }
        assertPlanFits(plan, settings.surface());
        // Every unfinished WORK may hold an environment until it is terminal, and a parent keeps its
        // own while it waits for children. Starting work only when a slot is free now means no WORK
        // waits for one, so parents and children cannot deadlock. Counted inside this commit, so
        // concurrent start_work calls cannot overbook.
        const used = (await liveWork(tx)).length;
        if (used >= limit) {
          throw new Error(
            `No free work slot: ${used} of ${limit} are in use by unfinished works. Wait for a running work to report or cancel one, then retry.`,
          );
        }
        const live = await liveWork(tx, api.conversationId);
        if (live.length >= maxActive) {
          throw new Error(
            `${maxActive} works are already active here; cancel or wait before adding more`,
          );
        }
        const retained = new Set<number>(live);
        if (parent.kind === "chat") {
          for (const reportId of await turns.getPendingReportIds(
            tx,
            api.conversationId,
          )) {
            retained.add(reportId);
          }
        }
        const history = Object.entries(index.launches);
        for (const [key, launched] of history.slice(
          0,
          Math.max(0, history.length - 511),
        )) {
          if (!retained.has(launched)) {
            delete index.launches[key];
          }
        }
        const created = await tx.createTask(
          task,
          {
            title,
            brief,
            agent: agentId,
            depth,
            maxDepth: caller?.maxDepth ?? settings.maxDepth,
            parent: jsonValueSchema.parse(
              copyJson(parent, { omitUndefinedProperties: true }),
            ),
            plan: storedPlan(plan),
            environment: settings.environment?.identity ?? null,
          },
          {
            ownership: { kind: "conversation" },
            conversationId: api.conversationId,
            background: true,
          },
        );
        index.launches[String(api.taskId)] = created;
        return created;
      }, context);
      const next =
        parent.kind === "chat"
          ? "It runs independently; do not wait for it. Explain your plan and answer the user now."
          : "Its messages and report arrive later as messages. End your turn when you have nothing else to do.";
      return {
        content: [
          {
            type: "text",
            text: `Started work #${id}: ${title} (agent ${agent}). ${next}`,
          },
        ],
        details: { workId: id, agent },
      };
    },
  });
  const list = defineTool({
    name: LIST_WORK,
    description: "List the works you started and their current status.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await listWork(harness, api.conversationId)),
        },
      ],
    }),
  });
  const inspect = defineTool({
    name: INSPECT_WORK,
    description:
      "Inspect one work you started, or any work below it: status, unanswered message, its latest answer and its children.",
    parameters: Type.Object({ id: Type.Integer({ minimum: 1 }) }),
    replay: "safe",
    execute: async ({ id }, api, context) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await inspectWork(
              harness,
              api.conversationId,
              parseTaskId(id),
              context,
            ),
          ),
        },
      ],
    }),
  });
  const message = defineTool({
    name: MESSAGE_WORK,
    description:
      "Send a message to a work you started: a reply to its message, a clarification or a correction. A busy work sees it after its current tool round; an idle one resumes.",
    parameters: Type.Object({
      id: Type.Integer({ minimum: 1 }),
      text: Type.String({ minLength: 1, maxLength: 64000 }),
    }),
    replay: "safe",
    execute: async ({ id, text }, api, context) => {
      const caller = await api.snapshot(WorkScope, api.conversationId, context);
      const isRoot = caller === undefined || caller.workId === null;
      const origin = isRoot
        ? await resolveAuthorizedOrigin(api, context)
        : undefined;
      const target = await requireChild(
        harness,
        api.conversationId,
        parseTaskId(id),
        context,
      );
      if (target.conversation === undefined) {
        throw new Error(`Work #${id} is still starting; retry shortly`);
      }
      // Commit the effect intent with its origin fence and ownership checks. Submission is
      // dispatched afterward and may finish in flight after a later stop/reset, like other
      // admitted effects; it must never acquire authority from an earlier invocation-only check.
      await api.commit(async (tx) => {
        if (origin && (await turns.isOriginFenced(tx, origin))) {
          throw new Error("This turn was fenced by stop/reset");
        }
        const child = await tx.task(parseTaskId(id));
        if (
          !child ||
          child.kind !== "kaeno.work" ||
          child.conversationId !== api.conversationId ||
          child.abortRequested ||
          child.state.status === "terminal"
        ) {
          throw new Error(`Work #${id} is no longer a live child here`);
        }
        const index = await tx.doc(WorkIndex, api.conversationId);
        const messages = (index.messages ??= {});
        messages[String(api.taskId)] = parseTaskId(id);
        const keys = Object.keys(messages);
        for (const key of keys.slice(0, Math.max(0, keys.length - 512))) {
          delete messages[key];
        }
      }, context);
      const conversation = await requireConversation(
        api,
        target.conversation,
        context,
      );
      await conversation.submit(
        {
          type: "input",
          content: `Message from your ${isRoot ? "CHAT" : "parent WORK"}:\n\n${text}`,
          requestId: `message:${api.taskId}`,
          whenBusy: "steer",
        },
        context,
      );
      return {
        content: [{ type: "text", text: `Message delivered to work #${id}.` }],
      };
    },
  });
  const cancel = defineTool({
    name: CANCEL_WORK,
    description:
      "Cancel a work you started. Its own children are cancelled too, and their environments are removed.",
    parameters: Type.Object({ id: Type.Integer({ minimum: 1 }) }),
    replay: "safe",
    execute: async ({ id }, api, context) => {
      const workId = parseTaskId(id);
      const caller = await api.snapshot(WorkScope, api.conversationId, context);
      const isRoot = caller === undefined || caller.workId === null;
      if (isRoot) {
        const origin = await resolveAuthorizedOrigin(api, context);
        await api.commit(async (tx) => {
          if (await turns.isOriginFenced(tx, origin)) {
            throw new Error("This turn was fenced by stop/reset");
          }
          return turns.admitWorkCancellation(tx, api.conversationId, workId);
        }, context);
      } else {
        await requireChild(harness, api.conversationId, workId, context);
        await harness().abortTask(workId, context);
      }
      return {
        content: [
          { type: "text", text: `Cancellation requested for work #${id}.` },
        ],
      };
    },
  });
  const messageParent = defineTool({
    name: MESSAGE_PARENT,
    description:
      "Send a message to whoever started you, for a decision or input you cannot get yourself. Ends your turn; the reply arrives as a message.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 16000 }),
    }),
    replay: "safe",
    execute: async ({ text }, api, context) => {
      await api.commit(async (tx) => {
        const scope = await tx.doc(WorkScope, api.conversationId);
        if (scope.workId === null) {
          throw new Error("Only WORK has a parent to message");
        }
        // Task supervision consumes this mailbox into a durable message checkpoint.
        scope.message = text;
      }, context);
      return {
        content: [
          {
            type: "text",
            text: "Message sent. End your turn; the reply arrives as a message.",
          },
        ],
        control: { terminate: true },
      };
    },
  });
  return {
    orchestrationTools: [start, list, inspect, message, cancel],
    parentTools: [messageParent],
  };
}
export async function cancelWork(
  harness: () => WorkRuntime,
  turns: WorkTurns,

  conversationId: ConversationId,
  id?: TaskId,
): Promise<TaskId[]> {
  const jobs = await listWork(harness, conversationId);
  if (id !== undefined && !jobs.some((job) => job.id === id)) {
    throw new Error(`No work #${id} belongs to this chat`);
  }
  const targeted = jobs.filter((job) => id === undefined || job.id === id);
  // Suppress before marking: a finishing Work's concurrently created result Turn must not slip through.
  await harness().commit(
    (tx) =>
      turns.suppressWorkReports(
        tx,
        conversationId,
        targeted.map((job) => job.id),
      ),
    BACKGROUND_CONTEXT,
  );
  const chosen = targeted.filter((job) => !FINISHED.includes(job.status));
  for (const job of chosen) {
    await harness().abortTask(job.id, BACKGROUND_CONTEXT);
  }
  return chosen.map((job) => job.id);
}
