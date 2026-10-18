// Markdown agent definitions: `<root>/<directory>/AGENT.md` with YAML frontmatter (name and description
// required; model, skills and tools optional) and the system prompt as body. Pure resolution: this module
// has no durable definitions and performs no I/O beyond what its caller already loaded.
import type { JsonValue } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { z } from "zod";
import type {
  Binding,
  ConversationSetup,
  ParticipantPlan,
  Participants,
  ParticipantSummary,
  WorkPlan,
} from "../application/index.ts";
import {
  discoveryMetadata,
  parseManifest,
  type DefinitionPackage,
  type Diagnostic,
} from "../definitions/index.ts";

export const AGENT_MANIFEST = "AGENT.md";

export interface AgentDefinition {
  /** `<source alias>:<name>`; the ID used with start_work. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly model?: string;
  readonly thinkingLevel?: ModelThinkingLevel;
  readonly skills?: readonly string[];
  readonly tools?: readonly string[];
  /** Markdown body: the agent's system prompt. */
  readonly prompt: string;
  /** Frontmatter keys this version does not use; kept, never interpreted. */
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly location: string;
}

/** Turns skill references into a binding; satisfied by the skills extension. Optional. */
export interface SkillBinder {
  readonly tools: readonly string[];
  bind(references: readonly string[]): Binding;
}

export interface AgentDefaults {
  /** Model for definitions without one; absent makes such agents discoverable but unavailable. */
  readonly model?: ModelRef;
  /** Tools for definitions that omit `tools`. */
  readonly tools: readonly string[];
}

const KNOWN = new Set([
  "name",
  "description",
  "model",
  "thinkingLevel",
  "skills",
  "tools",
]);
const optionalFields = z.object({
  model: z.string().trim().min(1).optional(),
  thinkingLevel: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh"])
    .optional(),
  skills: z.array(z.string().trim().min(1)).optional(),
  tools: z.array(z.string().trim().min(1)).optional(),
});

/** Parse one `AGENT.md`. Throws an actionable error for invalid known fields. */
export function parseAgent(
  text: string,
  source: string,
  location: string,
): AgentDefinition {
  const manifest = parseManifest(text, location);
  const { name, description } = discoveryMetadata(manifest, location);
  const fields = optionalFields.safeParse(manifest.metadata);
  if (!fields.success) {
    throw new Error(
      `${location}: invalid agent fields: ${fields.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  return {
    id: `${source}:${name}`,
    name,
    description,
    ...fields.data,
    prompt: manifest.body,
    metadata: Object.fromEntries(
      Object.entries(manifest.metadata).filter(([key]) => !KNOWN.has(key)),
    ),
    location,
  };
}

/** Parse packages from definition sources; invalid packages become diagnostics. */
export function parseAgents(packages: readonly DefinitionPackage[]): {
  agents: AgentDefinition[];
  diagnostics: Diagnostic[];
} {
  const agents: AgentDefinition[] = [];
  const duplicates = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const definition of packages) {
    const location = `${definition.directory}/${AGENT_MANIFEST}`;
    try {
      const agent = parseAgent(
        definition.manifest,
        definition.source,
        location,
      );
      if (agents.some((existing) => existing.id === agent.id)) {
        duplicates.add(agent.id);
        throw new Error(
          `${location}: duplicate agent name "${agent.name}" in source ${definition.source}`,
        );
      }
      agents.push(agent);
    } catch (error) {
      diagnostics.push({
        location,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    agents: agents.filter((agent) => !duplicates.has(agent.id)),
    diagnostics,
  };
}

/** `provider/model-id` into a model reference; the model registry decides availability. */
export function parseModelRef(value: string): ModelRef {
  const [provider, ...rest] = value.split("/");
  const modelId = rest.join("/");
  if (!provider || !modelId) {
    throw new Error(`model "${value}" must be provider/model-id`);
  }
  return { provider, modelId };
}

/**
 * Effective setup of a definition: defaults for omitted fields, explicit lists kept exact.
 * Omitted `tools` get the binder's discovery/reading tools even without assigned skills.
 * Explicit lists remain exact; the knowledge extension may render its instructions inline
 * when its reader tool is unavailable.
 */
export function resolveAgentSetup(
  agent: AgentDefinition,
  defaults: AgentDefaults,
  skills?: SkillBinder,
): ConversationSetup {
  const model = agent.model ? parseModelRef(agent.model) : defaults.model;
  if (!model) {
    throw new Error(`no model configured and no default model available`);
  }
  const references = agent.skills ?? [];
  const bindings: Binding[] = [];
  const tools = agent.tools ?? [
    ...new Set([...defaults.tools, ...(skills?.tools ?? [])]),
  ];
  if (references.length > 0) {
    if (!skills) {
      throw new Error(`skills are assigned but no skill catalog is installed`);
    }
    bindings.push(skills.bind(references));
  }
  return {
    model,
    ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
    instructions: agent.prompt,
    tools: [...tools],
    bindings,
  };
}

/**
 * WORK participants from agent definitions. Resolved once at construction; every available agent
 * is root-selectable and may delegate to every other one.
 */
export function agentParticipants(options: {
  agents: readonly AgentDefinition[];
  defaults: AgentDefaults;
  skills?: SkillBinder;
  /** Installed, host-approved worker tool names; absence leaves validation to the core host. */
  tools?: readonly string[];
}): Participants {
  const resolved = options.agents.map(
    (
      agent,
    ):
      | { agent: AgentDefinition; plan: ParticipantPlan }
      | { agent: AgentDefinition; reason: string } => {
      try {
        const setup = resolveAgentSetup(
          agent,
          options.defaults,
          options.skills,
        );
        const missing = (setup.tools ?? []).filter(
          (tool) =>
            options.tools !== undefined && !options.tools.includes(tool),
        );
        if (missing.length > 0) {
          throw new Error(
            `tools are not installed/approved: ${missing.join(", ")}`,
          );
        }
        return {
          agent,
          plan: {
            id: agent.id,
            description: agent.description,
            setup,
          } satisfies ParticipantPlan,
        };
      } catch (error) {
        return {
          agent,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  const plans: Record<string, ParticipantPlan> = {};
  for (const entry of resolved) {
    if ("plan" in entry) {
      plans[entry.agent.id] = entry.plan;
    }
  }
  return {
    list: (): ParticipantSummary[] =>
      resolved.map((entry) =>
        "plan" in entry
          ? {
              id: entry.agent.id,
              description: entry.agent.description,
              available: true,
            }
          : {
              id: entry.agent.id,
              description: entry.agent.description,
              available: false,
              reason: entry.reason,
            },
      ),
    plan: (root: string): WorkPlan => {
      if (!Object.hasOwn(plans, root)) {
        const entry = resolved.find((candidate) => candidate.agent.id === root);
        throw new Error(
          entry && "reason" in entry
            ? `Agent ${root} is unavailable: ${entry.reason}`
            : `Unknown agent ${root}`,
        );
      }
      return { root, participants: structuredClone(plans) };
    },
  };
}
