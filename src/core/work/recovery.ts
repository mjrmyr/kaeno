// Paused-startup compatibility and idempotent environment reconciliation.
import type { Context } from "@earendil-works/chord";
import { z } from "zod";
import type { Binding } from "../conversation/index.ts";
import type { WorkRuntime, WorkSettings } from "./model.ts";
import { assertPlanFits, readPlan, type WorkInstance } from "./plan.ts";
import { workConversation } from "./directory.ts";
/**
 * Paused-startup check: every unfinished WORK must retain its execution backend/target and its
 * saved plan must fit the installed worker surface. Reject changes before any resource reconciliation.
 */
export async function assertSavedWorkFits(
  harness: () => WorkRuntime,
  settings: WorkSettings,
  context: Context,
): Promise<void> {
  const problems: string[] = [];
  for (const { record } of (await harness().inspect(context)).tasks) {
    if (record.kind !== "kaeno.work" || record.state.status === "terminal") {
      continue;
    }
    try {
      const saved = z
        .object({
          plan: z.unknown(),
          environment: z.string().nullable().optional(),
        })
        .parse(record.input);
      if (saved.environment === undefined) {
        throw new Error(
          "Saved WORK has no execution environment identity; drain it with the previous release before upgrading",
        );
      }
      if (saved.environment !== (settings.environment?.identity ?? null)) {
        throw new Error(
          "Execution environment changed; restore the previous backend/target and finish or cancel this work before switching",
        );
      }
      assertPlanFits(readPlan(saved.plan), settings.surface());
    } catch (error) {
      problems.push(
        `Work #${record.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      [
        "Saved WORK no longer fits the installed worker surface or execution environment:",
        ...problems.map((problem) => `- ${problem}`),
        "Restore the previous environment and tools/extensions; finish or cancel the affected work before changing configuration.",
      ].join("\n"),
    );
  }
}
/** Check extension-owned data even for agents whose conversations haven't been created yet. */
export async function validateSavedBindings(
  harness: () => WorkRuntime,
  validate: (binding: Binding) => void,
  context: Context,
): Promise<void> {
  for (const { record } of (await harness().inspect(context)).tasks) {
    if (record.kind !== "kaeno.work" || record.state.status === "terminal") {
      continue;
    }
    const plan = readPlan(
      z.object({ plan: z.unknown() }).parse(record.input).plan,
    );
    for (const agent of Object.values(plan.agents)) {
      for (const binding of agent.setup.bindings ?? []) {
        validate(binding);
      }
    }
  }
}
/** Remove environment resources that no longer back an unfinished WORK. */
export async function reconcileEnvironment(
  harness: () => WorkRuntime,
  settings: WorkSettings,
  context: Context,
): Promise<void> {
  const environment = settings.environment;
  if (!environment) {
    return;
  }
  const live: WorkInstance[] = [];
  for (const { record } of (await harness().inspect(context)).tasks) {
    if (record.kind !== "kaeno.work" || record.state.status === "terminal") {
      continue;
    }
    const conversation = await harness().commit(
      (tx) => workConversation(tx, record),
      context,
    );
    if (conversation !== undefined) {
      live.push({ workId: record.id, conversationId: conversation });
    }
  }
  await environment.reconcile(live, harness());
}
