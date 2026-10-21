// Markdown agent definitions: `<root>/<name>.md` with YAML frontmatter (name and description
// required; model, skills and tools optional) and the system prompt as body. Pure resolution: this module
// has no durable definitions and performs no I/O beyond what its caller already loaded.
import { basename } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { z } from "zod";
import type {
  AgentProfile,
  Binding,
  ConversationSetup,
} from "../../core/application/index.ts";
import {
  agentOriginBinding,
  discoveryMetadata,
  parseManifest,
  type DefinitionOrigin,
  type AgentDocument,
  type Diagnostic,
} from "../definitions/index.ts";

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
  readonly origin?: DefinitionOrigin;
}

/** Turns skill references into one binding, or none when there is nothing to bind; satisfied by the skills extension. */
export type SkillBinder = (
  references: readonly string[],
) => Binding | undefined;

export interface AgentDefaults {
  /** Model for definitions without one; absent makes such agents fail to resolve. */
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

/** Parse one flat agent record. Throws an actionable error for invalid known fields. */
export function parseAgent(
  text: string,
  source: string,
  location: string,
): AgentDefinition {
  const manifest = parseManifest(text, location);
  const { name, description } = discoveryMetadata(manifest, location);
  if (basename(location) !== `${name}.md`) {
    throw new Error(
      `${location}: expected filename "${name}.md" for declared name "${name}"; rename the file or correct name`,
    );
  }
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

/** Parse flat documents from agent sources; invalid records become diagnostics. */
export function parseAgents(documents: readonly AgentDocument[]): {
  agents: AgentDefinition[];
  diagnostics: Diagnostic[];
} {
  const agents: AgentDefinition[] = [];
  const duplicates = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const definition of documents) {
    const location = definition.manifestPath;
    try {
      const agent = parseAgent(
        definition.manifest,
        definition.source,
        location,
      );
      agents.push({
        ...agent,
        ...(definition.origin
          ? { origin: structuredClone(definition.origin) }
          : {}),
      });
    } catch (error) {
      diagnostics.push({
        location,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const agent of agents) {
    const locations = agents
      .filter((other) => other.id === agent.id)
      .map((other) => other.location)
      .sort();
    if (locations.length > 1 && !duplicates.has(agent.id)) {
      duplicates.add(agent.id);
      diagnostics.push({
        location: locations[0],
        message: `Duplicate agent ${agent.id}: ${locations.join(", ")}`,
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
 * Bindings are the host's (copied per agent), then the definition's origin, then its skills.
 * An agent with an origin needs the definition-origins extension installed.
 */
export function resolveAgentSetup(
  agent: AgentDefinition,
  defaults: AgentDefaults,
  skills?: SkillBinder,
  hostBindings: readonly Binding[] = [],
): ConversationSetup {
  const model = agent.model ? parseModelRef(agent.model) : defaults.model;
  if (!model) {
    throw new Error(`no model configured and no default model available`);
  }
  const references = agent.skills ?? [];
  const bindings: Binding[] = structuredClone([...hostBindings]);
  if (agent.origin) {
    bindings.push(agentOriginBinding(agent.id, agent.origin));
  }
  const tools = agent.tools ?? [...new Set(defaults.tools)];
  if (references.length > 0 && !skills) {
    throw new Error(`skills are assigned but no skill catalog is installed`);
  }
  const skillBinding = skills?.(references);
  if (skillBinding) {
    bindings.push(skillBinding);
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
 * WORK agents from definitions, in definition order. Throws on the first definition that cannot
 * resolve (for example without a model). Tool and binding fit is checked by core when Kaeno opens.
 */
export function resolveAgents(options: {
  agents: readonly AgentDefinition[];
  defaults: AgentDefaults;
  /** Skill binder per agent (native contributions may differ by agent). */
  skills?: (agent: AgentDefinition) => SkillBinder;
  /** Extension-owned scope supplied by trusted host composition, never by agent frontmatter. */
  bindings?: readonly Binding[];
}): AgentProfile[] {
  return options.agents.map((agent) => {
    try {
      return {
        id: agent.id,
        description: agent.description,
        setup: resolveAgentSetup(
          agent,
          options.defaults,
          options.skills?.(agent),
          options.bindings,
        ),
      };
    } catch (error) {
      throw new Error(
        `Agent ${agent.id} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}
