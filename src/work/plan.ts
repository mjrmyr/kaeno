import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import type {
  ConversationId,
  EnvTarget,
  Harness,
  TaskId,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { z } from "zod";
import {
  assertSetupFits,
  setupSchema,
  type ConversationSetup,
  type SetupSurface,
} from "../conversation/index.ts";

/** One participant WORK can start: an opaque ID, a description for choosing it, and its setup. */
export interface ParticipantPlan {
  readonly id: string;
  readonly description: string;
  readonly setup: ConversationSetup;
}

/**
 * Participants frozen when CHAT admits a root WORK. Every participant may delegate to every
 * other one; children always start from this saved plan, never from a live catalog.
 */
export interface WorkPlan {
  readonly root: string;
  readonly participants: Readonly<Record<string, ParticipantPlan>>;
}

export interface ParticipantSummary {
  readonly id: string;
  readonly description: string;
  /** False when the definition is discoverable but cannot run, for example without a model. */
  readonly available: boolean;
  readonly reason?: string;
}

/** Consumer-owned: who can participate. Pure over data loaded at startup; no I/O. */
export interface Participants {
  list(): readonly ParticipantSummary[];
  /** Plan rooted at an available participant ID; throws an actionable error otherwise. */
  plan(root: string): WorkPlan;
}

/** A running WORK as its environment sees it. */
export interface WorkInstance {
  readonly workId: TaskId;
  readonly conversationId: ConversationId;
}
export interface WorkEnvironmentRuntime extends Pick<
  Harness,
  "commit" | "snapshot"
> {}

/** Consumer-owned: where participants run. Every method is idempotent and safe after restart. */
export interface WorkEnvironment {
  /** Working directory given to participants inside the environment. */
  readonly cwd: string;
  ensure(
    work: WorkInstance,
    runtime: WorkEnvironmentRuntime,
    context: Context,
  ): Promise<void>;
  release(work: WorkInstance, runtime: WorkEnvironmentRuntime): Promise<void>;
  /** Remove resources no longer backing one of the given live works. */
  reconcile(
    live: readonly WorkInstance[],
    runtime: WorkEnvironmentRuntime,
  ): Promise<void>;
  executionEnvironment(
    target: EnvTarget,
    context: Context,
  ): Promise<ExecutionEnv | undefined>;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const planSchema = z
  .object({
    root: z.string().min(1),
    participants: z.record(
      z.string(),
      z.object({
        id: z.string().min(1),
        description: z.string(),
        setup: setupSchema,
      }),
    ),
  })
  .superRefine((plan, ctx) => {
    if (!Object.hasOwn(plan.participants, plan.root)) {
      ctx.addIssue({ code: "custom", message: "Missing plan root" });
    }
    for (const [id, participant] of Object.entries(plan.participants)) {
      if (participant.id !== id) {
        ctx.addIssue({ code: "custom", message: `Mismatched id ${id}` });
      }
    }
  });

/** Boundary: parse a stored or supplied plan. */
export function readPlan(value: unknown): WorkPlan {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `WORK has no valid saved plan; cannot resume safely (cancel and submit a new request): ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** Storage copy of a validated plan. */
export function storedPlan(plan: WorkPlan): JsonValue {
  return jsonValueSchema.parse(
    copyJson(plan, { omitUndefinedProperties: true }),
  );
}

/** Validate every participant against the worker surface before it is saved or resumed. */
export function assertPlanFits(plan: WorkPlan, surface: SetupSurface): void {
  for (const participant of Object.values(plan.participants)) {
    assertSetupFits(
      `Participant ${participant.id}`,
      participant.setup,
      surface,
    );
  }
}

/** Resolve a requested name to one ID: exact, or the unique `<source>:<name>` match. */
export function resolveParticipantId(
  requested: string,
  ids: readonly string[],
): string {
  if (ids.includes(requested)) {
    return requested;
  }
  const matches = ids.filter((id) => id.endsWith(`:${requested}`));
  if (matches.length === 1) {
    return matches[0];
  }
  throw new Error(
    matches.length > 1
      ? `Ambiguous agent "${requested}": use one of ${matches.join(", ")}`
      : `Unknown agent "${requested}". Available: ${ids.join(", ") || "none"}`,
  );
}

/** Model-facing participant listing. */
export function describeParticipants(
  participants: readonly { id: string; description: string }[],
): string {
  return participants
    .map((participant) => `- ${participant.id}: ${participant.description}`)
    .join("\n");
}
