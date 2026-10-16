// Deterministic policy on native WORK receipts. Reports are retained data, never commands or subsequent inputs.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineTask,
  type ConversationId,
  type Harness,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import type { Stored } from "../durable/index.ts";
import type { Origin } from "../turns/index.ts";
import { storageCopy, type WorkBlueprint } from "./work-blueprint.ts";
export const planRequestSchema = z.strictObject({
  requestId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]{7,127}$/)
    .refine(
      (value) => !["__proto__", "constructor", "prototype"].includes(value),
    ),
  scope: z.literal("reasoning"),
  phases: z
    .array(
      z.strictObject({
        agent: z.string().min(1).max(128),
        title: z.string().trim().min(1).max(160),
        brief: z.string().trim().min(1).max(8000),
      }),
    )
    .min(1)
    .max(4),
  limits: z.strictObject({
    deadlineMs: z.number().int().min(1).max(600000),
    maxRequests: z.number().int().min(1).max(4),
    maxPhases: z.literal(4),
    maxDepth: z.literal(1),
    fanout: z.literal(1),
  }),
});
export type PlanRequest = z.infer<typeof planRequestSchema>;
interface PlanInput {
  request: PlanRequest;
  origin: Origin;
  deadline: number;
  blueprints: Stored<WorkBlueprint>[];
}
export interface PlanView {
  id: TaskId;
  request: PlanRequest;
  origin: Origin;
  deadline: number;
  status:
    | "running"
    | "completing"
    | "pausing"
    | "cancelling"
    | "completed"
    | "paused"
    | "cancelled";
  cursor: number;
  requests: number;
  launches: Record<string, TaskId>;
  reason?: string;
  results: { workId: TaskId; text: string }[];
}
export const PlanLedger = defineDoc<{
  plans: Record<string, Stored<PlanView>>;
}>({
  kind: "kaeno.plans",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ plans: {} }),
});
export interface PlanAdmission {
  capturePlanOrigin(
    tx: Tx,
    id: ConversationId,
    requestId: string,
  ): Promise<Origin>;
}
interface PlanPolicy {
  isOriginFenced(tx: Tx, origin: Origin): Promise<boolean>;
}
interface PlanRuntime extends Pick<
  Harness,
  "snapshot" | "commit" | "abortTask" | "waitForTask"
> {}
function settledStatus(status: PlanView["status"]): PlanView["status"] {
  switch (status) {
    case "completing":
      return "completed";
    case "pausing":
      return "paused";
    case "cancelling":
      return "cancelled";
    default:
      return status;
  }
}
function isSettled(status: PlanView["status"]): boolean {
  return ["completed", "paused", "cancelled"].includes(status);
}
const receiptSchema = z.object({
  status: z.literal("completed"),
  text: z.string(),
});
export class ReasoningPlans {
  readonly task;
  private readonly harness: () => PlanRuntime;
  private readonly policy: PlanPolicy;
  private readonly admission?: PlanAdmission;
  private readonly capture: (agent: string) => WorkBlueprint;
  constructor(
    harness: () => PlanRuntime,
    policy: PlanPolicy,
    capture: (agent: string) => WorkBlueprint,
    launch: (
      tx: Tx,
      input: {
        phase: PlanRequest["phases"][number];
        blueprint: Stored<WorkBlueprint>;
        planId: TaskId;
        conversationId: ConversationId;
      },
    ) => Promise<TaskId>,
    admission?: PlanAdmission,
  ) {
    this.harness = harness;
    this.policy = policy;
    this.capture = capture;
    this.admission = admission;
    this.task = defineTask<Stored<PlanInput>, { phase: "supervise" }, null>({
      name: "kaeno.plan",
      version: 1,
      initial: () => ({ phase: "supervise" }),
      phases: {
        supervise: async (task, runtime, context) => {
          for (;;) {
            let finished = false;
            let cleanup: TaskId[] = [];
            await runtime.commit(async (tx) => {
              const ledger = await tx.doc(PlanLedger, task.conversationId);
              const plan = ledger.plans[task.input.request.requestId];
              // All SDK table reads precede createTask. Document edits flush at commit.
              const fenced = await this.policy.isOriginFenced(
                tx,
                task.input.origin,
              );
              const key = `${task.id}:${plan.cursor}`;
              const childId = plan.launches[key];
              const child =
                childId === undefined ? undefined : await tx.task(childId);
              if (plan.status === "running" && fenced) {
                plan.status = "cancelling";
                plan.reason = "Origin fenced by stop/reset";
              }
              if (
                plan.status === "running" &&
                runtime.now() >= task.input.deadline
              ) {
                plan.status = "pausing";
                plan.reason = "Deadline exhausted";
              }
              if (plan.status === "running" && childId !== undefined) {
                if (!child || child.kind !== "kaeno.work") {
                  plan.status = "pausing";
                  plan.reason = "Missing native WORK receipt";
                } else if (child.state.status === "terminal") {
                  const outcome = child.state.outcome;
                  const result = receiptSchema.safeParse(
                    outcome.status === "completed" ? outcome.result : undefined,
                  );
                  if (!child.abortRequested && result.success) {
                    plan.results.push({
                      workId: childId,
                      text: result.data.text,
                    });
                    plan.cursor++;
                    if (plan.cursor === task.input.request.phases.length) {
                      plan.status = "completing";
                    }
                  } else {
                    plan.status = "pausing";
                    plan.reason ??= `Phase ${plan.cursor + 1} failed (${outcome.status})`;
                  }
                }
              } else if (plan.status === "running") {
                if (plan.requests >= task.input.request.limits.maxRequests) {
                  plan.status = "pausing";
                  plan.reason = "Native request budget exhausted";
                } else {
                  const created = await launch(tx, {
                    phase: task.input.request.phases[plan.cursor],
                    blueprint: task.input.blueprints[plan.cursor],
                    planId: task.id,
                    conversationId: task.conversationId,
                  });
                  // The plan ID + cursor key and native child are one atomic write, including after reopen.
                  plan.launches[key] = created;
                }
              }
              finished = plan.status !== "running";
              if (finished) {
                cleanup = Object.values(plan.launches);
              }
              return undefined;
            }, context);
            if (finished) {
              for (const child of cleanup) {
                await this.harness().abortTask(child, context);
                await runtime.waitForTask(child, context);
              }
              await runtime.commit(async (tx) => {
                const plan = (await tx.doc(PlanLedger, task.conversationId))
                  .plans[task.input.request.requestId];
                plan.status = settledStatus(plan.status);
                return {
                  status: "terminal",
                  outcome: { status: "completed", result: null },
                };
              }, context);
              return;
            }
            await runtime.sleep(runtime.now() + 25, context);
          }
        },
      },
      abort: async (task, runtime, context) => {
        const ids = await this.markCancelled(
          task.conversationId,
          task.input.request.requestId,
        );
        for (const child of ids) {
          await this.harness().abortTask(child, context);
          await runtime.waitForTask(child, context);
        }
        await runtime.commit(async (tx) => {
          const plan = (await tx.doc(PlanLedger, task.conversationId)).plans[
            task.input.request.requestId
          ];
          plan.status = settledStatus(plan.status);
          return { status: "terminal", outcome: { status: "aborted" } };
        }, context);
      },
    });
  }
  /** Only the authenticated structured HTTP boundary calls this, never a model tool. */
  async admit(conversationId: ConversationId, raw: unknown): Promise<PlanView> {
    const request = planRequestSchema.parse(raw);
    if (!this.admission) {
      throw new Error("Plan admission is not configured");
    }
    const admission = this.admission;
    await this.harness().commit(async (tx) => {
      const ledger = await tx.doc(PlanLedger, conversationId);
      const existing = Object.hasOwn(ledger.plans, request.requestId)
        ? ledger.plans[request.requestId]
        : undefined;
      if (existing) {
        if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
          throw new Error(
            "Plan request ID already admitted with different content",
          );
        }
        return;
      }
      if (Object.keys(ledger.plans).length >= 128) {
        throw new Error("Plan history full (128); use a new thread");
      }
      if (Object.values(ledger.plans).some((plan) => !isSettled(plan.status))) {
        throw new Error(
          "A reasoning plan is already running or cleaning up in this thread",
        );
      }
      const origin = await admission.capturePlanOrigin(
        tx,
        conversationId,
        request.requestId,
      );
      const blueprints = request.phases.map((phase) =>
        storageCopy(this.capture(phase.agent)),
      );
      const deadline = Date.now() + request.limits.deadlineMs;
      const id = await tx.createTask(
        this.task,
        { request, origin, deadline, blueprints },
        {
          ownership: { kind: "conversation" },
          conversationId,
          background: true,
        },
      );
      ledger.plans[request.requestId] = {
        id,
        request,
        origin,
        deadline,
        status: "running",
        cursor: 0,
        requests: 0,
        launches: {},
        results: [],
      };
    }, BACKGROUND_CONTEXT);
    const plans = await this.list(conversationId);
    const plan = plans.find(
      (item) => item.request.requestId === request.requestId,
    );
    if (!plan) {
      throw new Error("Admitted plan is missing");
    }
    return plan;
  }
  async list(conversationId: ConversationId): Promise<PlanView[]> {
    return Object.values(
      (
        await this.harness().snapshot(
          PlanLedger,
          conversationId,
          BACKGROUND_CONTEXT,
        )
      )?.plans ?? {},
    );
  }
  private async markCancelled(
    conversationId: ConversationId,
    requestId: string,
  ): Promise<TaskId[]> {
    return this.harness().commit(async (tx) => {
      const plans = (await tx.doc(PlanLedger, conversationId)).plans;
      const plan = Object.hasOwn(plans, requestId)
        ? plans[requestId]
        : undefined;
      if (!plan) {
        throw new Error("No such plan in this thread");
      }
      if (!isSettled(plan.status)) {
        plan.status = "cancelling";
        plan.reason = "Cancelled by user";
      }
      return Object.values(plan.launches);
    }, BACKGROUND_CONTEXT);
  }
  async cancel(
    conversationId: ConversationId,
    requestId?: string,
  ): Promise<void> {
    const plans = await this.list(conversationId);
    if (
      requestId !== undefined &&
      !plans.some((plan) => plan.request.requestId === requestId)
    ) {
      throw new Error("No such plan in this thread");
    }
    for (const plan of plans.filter(
      (item) => requestId === undefined || item.request.requestId === requestId,
    )) {
      await this.markCancelled(conversationId, plan.request.requestId);
      await this.harness().abortTask(plan.id, BACKGROUND_CONTEXT);
      await this.harness().waitForTask(plan.id, BACKGROUND_CONTEXT);
    }
  }
  /** Count every provider request attempt BEFORE it starts, also on retries/recovery. No billed token/cost promise. */
  async beforeRequest(
    conversationId: ConversationId,
    planId: TaskId,
  ): Promise<void> {
    const reason = await this.harness().commit(async (tx) => {
      const plans = (await tx.doc(PlanLedger, conversationId)).plans;
      const plan = Object.values(plans).find((item) => item.id === planId);
      if (!plan) {
        return "Missing reasoning plan";
      }
      const fenced = await this.policy.isOriginFenced(tx, plan.origin);
      let failure = plan.reason;
      if (plan.status !== "running" || fenced) {
        failure ??= "Plan is fenced or inactive";
      }
      if (Date.now() >= plan.deadline) {
        failure ??= "Deadline exhausted";
      }
      if (plan.requests >= plan.request.limits.maxRequests) {
        failure ??= "Native request budget exhausted";
      }
      if (failure) {
        if (plan.status === "running") {
          plan.status = fenced ? "cancelling" : "pausing";
          plan.reason = failure;
        }
        return failure;
      }
      plan.requests++;
      return undefined;
    }, BACKGROUND_CONTEXT);
    if (reason) {
      throw new Error(reason);
    }
  }
  async pause(
    conversationId: ConversationId,
    planId: TaskId,
    reason: string,
  ): Promise<void> {
    await this.harness().commit(async (tx) => {
      const plan = Object.values(
        (await tx.doc(PlanLedger, conversationId)).plans,
      ).find((item) => item.id === planId);
      if (plan?.status === "running") {
        plan.status = "pausing";
        plan.reason = reason;
      }
    }, BACKGROUND_CONTEXT);
  }
}
