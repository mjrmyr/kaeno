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
  qualifiedIdMatches,
  setupSchema,
  type ConversationSetup,
  type SetupSurface,
} from "../conversation/index.ts";

/**
 * An agent WORK can start: the ID the model picks it by, a description for choosing it, and the
 * resolved setup it runs with. Where it came from (Markdown, a repository, code) is not core's concern.
 */
export interface AgentProfile {
  readonly id: string;
  readonly description: string;
  readonly setup: ConversationSetup;
}

/**
 * Agents frozen when CHAT admits a root WORK. Every agent may delegate to every other one;
 * children always start from this saved plan, never from the agents configured now.
 */
export interface WorkPlan {
  readonly root: string;
  readonly agents: Readonly<Record<string, AgentProfile>>;
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
  /** Stable, non-secret backend/target identity. Saved at admission; changes cannot resume unfinished work. */
  readonly identity: string;
  /** Working directory given to participants inside the environment. */
  readonly cwd: string;
  /** Optional live limit on unfinished works, checked at admission to avoid parent/child deadlocks. */
  capacity?(context: Context): Promise<number>;
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

/**
 * Boundary: parse a stored or supplied plan. The stored key stays `participants` (kaeno.work v3,
 * kaeno.work-node v1); only this codec knows it.
 */
export function readPlan(value: unknown): WorkPlan {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `WORK has no valid saved plan; cannot resume safely (cancel and submit a new request): ${parsed.error.message}`,
    );
  }
  return { root: parsed.data.root, agents: parsed.data.participants };
}

/** Storage copy of a validated plan. */
export function storedPlan(plan: WorkPlan): JsonValue {
  return jsonValueSchema.parse(
    copyJson(
      { root: plan.root, participants: plan.agents },
      { omitUndefinedProperties: true },
    ),
  );
}

/** The frozen plan for a root: every configured agent, normalized exactly as a stored plan is read. */
export function planFor(
  root: string,
  agents: readonly AgentProfile[],
): WorkPlan {
  return readPlan({
    root,
    participants: Object.fromEntries(
      agents.map((agent) => [
        agent.id,
        { id: agent.id, description: agent.description, setup: agent.setup },
      ]),
    ),
  });
}

/** Validate every agent against the worker surface before it is saved or resumed. */
export function assertPlanFits(plan: WorkPlan, surface: SetupSurface): void {
  for (const agent of Object.values(plan.agents)) {
    assertSetupFits(`Agent ${agent.id}`, agent.setup, surface);
  }
}

/** Resolve a requested name to one agent ID: exact, or the unique `<source>:<name>` match. */
export function resolveAgentId(
  requested: string,
  ids: readonly string[],
): string {
  const matches = qualifiedIdMatches(requested, ids);
  if (matches.length === 1) {
    return matches[0];
  }
  throw new Error(
    matches.length > 1
      ? `Ambiguous agent "${requested}": use one of ${matches.join(", ")}`
      : `Unknown agent "${requested}". Available: ${ids.join(", ") || "none"}`,
  );
}

/** Model-facing agent listing. */
export function describeAgents(
  agents: readonly { id: string; description: string }[],
): string {
  return agents
    .map((agent) => `- ${agent.id}: ${agent.description}`)
    .join("\n");
}
