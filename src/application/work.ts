import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ArtifactStore } from "../artifacts/index.ts";
import type { Kaeno, KaenoExtension } from "./kaeno.ts";
import type { SandboxLimits, SandboxProvider } from "../sandbox/index.ts";
import { LocalWorkAgents } from "../agents/index.ts";
import type { WorkConfig } from "../work/index.ts";
import { eligibleWorkTemplates, Work, workTurns } from "../work/index.ts";

export interface WorkExtensionOptions {
  config: WorkConfig;
  sandbox: SandboxProvider;
  sandboxImage: string;
  sandboxLimits: SandboxLimits;
  maxConcurrent: number;
  artifacts?: ArtifactStore;
}

/** Compose durable work policy with one replaceable execution provider. */
export function createWorkExtensions(
  options: WorkExtensionOptions,
): KaenoExtension[] {
  for (const template of Object.values(options.config.templates)) {
    if (template.skills.length > 0) {
      throw new Error(
        "WORK skills are not enabled in the local Docker extension yet",
      );
    }
  }

  let core: Kaeno | undefined;
  let agents: LocalWorkAgents;
  const requireCore = (): Kaeno => {
    if (!core) {
      throw new Error("WORK extension started before Kaeno was ready");
    }
    return core;
  };
  const templates = {
    listWorkTemplates: () =>
      eligibleWorkTemplates(options.config).map(({ name, description }) => ({
        name,
        description,
      })),
  };
  const work = new Work(
    () => requireCore().harness,
    workTurns(() => requireCore().turns),
    templates,
    () => agents,
    options.artifacts,
  );
  agents = new LocalWorkAgents({
    config: options.config,
    sandbox: options.sandbox,
    image: options.sandboxImage,
    limits: options.sandboxLimits,
    maxConcurrent: options.maxConcurrent,
    work,
    harness: () => requireCore().harness,
  });

  const workTools = work.orchestrationTools.map((tool) => tool.name);
  const instructions = [
    "Delegate substantial or parallelizable work with start_work rather than attempting shell work yourself.",
    "Use a complete, self-contained brief. Work runs asynchronously; continue responding instead of waiting for it.",
    "Use list_work and inspect_work for progress, message_work for clarification, and cancel_work to stop work.",
    "Available WORK templates:",
    ...eligibleWorkTemplates(options.config).map(
      (template) => `- ${template.name}: ${template.description}`,
    ),
  ].join("\n");

  const workExtension: KaenoExtension = {
    durable: work.extension,
    assistantTools: workTools,
    assistantInstructions: instructions,
    readOnlyTools: ["list_work", "inspect_work"],
    environment: (target, context) =>
      agents.getExecutionEnvironment(target, context),
    start: async (opened, signal) => {
      core = opened;
      await agents.sweepOrphanedSandboxes();
      const timer = setInterval(() => {
        void agents.sweepOrphanedSandboxes().catch((error: unknown) => {
          console.error("work sandbox reconciliation:", error);
        });
      }, 5 * 60_000);
      signal.addEventListener("abort", () => clearInterval(timer), {
        once: true,
      });
      return async () => clearInterval(timer);
    },
  };
  const codingTools: KaenoExtension = {
    durable: CodingTools,
    assistantTools: [],
  };
  const workAgent: KaenoExtension = {
    durable: agents.extension,
    assistantTools: [],
  };
  return [codingTools, workAgent, workExtension];
}
