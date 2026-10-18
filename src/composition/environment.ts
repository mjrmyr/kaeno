import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type {
  Binding,
  ConversationSetup,
  KaenoExtension,
  ModelRef,
  WorkOptions,
} from "../application/index.ts";
import {
  agentParticipants,
  parseModelRef,
  parseAgents,
  resolveAgentSetup,
  type AgentDefinition,
} from "../agents/index.ts";
import {
  agentOriginBinding,
  definitionOriginsExtension,
  withDefinitionSources,
  type DefinitionPackage,
  type DefinitionSource,
  type Diagnostic,
  type RepositoryReader,
} from "../definitions/index.ts";
import { githubRepositoryReader } from "../github/index.ts";
import {
  loadSkills,
  skillBinder,
  skillsExtension,
  SKILLS_EXTENSION,
  SkillCatalog,
  type BoundSkill,
} from "../skills/index.ts";
import type { WorkEnvironment } from "../work/index.ts";
import { parseEnvironmentConfiguration } from "./configuration.ts";

const ORCHESTRATION = [
  "start_work",
  "list_work",
  "inspect_work",
  "message_work",
  "cancel_work",
];
const CODING = (CodingTools.tools ?? []).map((tool) => tool.name);
const WORKER_TOOLS = [...CODING, ...ORCHESTRATION, "message_parent"];

async function packagesFrom(
  sources: readonly DefinitionSource[],
  manifest: string,
): Promise<{
  packages: DefinitionPackage[];
  diagnostics: Diagnostic[];
  invalidSources: string[];
}> {
  const packages: DefinitionPackage[] = [];
  const diagnostics: Diagnostic[] = [];
  const invalidSources: string[] = [];
  const aliases = new Set<string>();
  for (const source of sources) {
    if (aliases.has(source.alias)) {
      throw new Error(`Duplicate definition source alias "${source.alias}"`);
    }
    aliases.add(source.alias);
    const snapshot = await source.snapshot(manifest);
    packages.push(...snapshot.packages);
    diagnostics.push(...snapshot.diagnostics);
    if (snapshot.diagnostics.length) {
      invalidSources.push(source.alias);
    }
  }
  return { packages, diagnostics, invalidSources };
}

export interface LoadEnvironmentOptions {
  configFile: string;
  sourceMode?: "refresh" | "offline";
  repositoryReader?: RepositoryReader;
  agentSources?: readonly DefinitionSource[];
  skillSources?: readonly DefinitionSource[];
  environment?: WorkEnvironment;
  maxDepth?: number;
  maxConcurrent?: number;
  defaultModel?: ModelRef;
  extensions?: readonly KaenoExtension[];
  tools?: readonly string[];
  bindingsFor?: (agent: AgentDefinition) => readonly Binding[];
  skillsFor?: (
    agent: AgentDefinition,
    role: "assistant" | "worker",
  ) => readonly BoundSkill[];
  signal?: AbortSignal;
}
export interface LoadedEnvironment {
  assistant: ConversationSetup;
  extensions: KaenoExtension[];
  work: WorkOptions;
  diagnostics: Diagnostic[];
}

/** The same host operation for local directories, Docker volumes and Kubernetes PVCs. */
export async function loadEnvironment(
  options: LoadEnvironmentOptions,
): Promise<LoadedEnvironment> {
  const configFile = resolve(options.configFile);
  const config = parseEnvironmentConfiguration(
    JSON.parse(await readFile(configFile, "utf8")),
    configFile,
  );
  return withDefinitionSources(
    {
      directory: config.sourceDirectory,
      repositories: config.repositories,
      directories: config.directories,
      reader: options.repositoryReader ?? githubRepositoryReader(),
      mode: options.sourceMode,
      signal: options.signal,
    },
    async (sources) => {
      const agentPackages = await packagesFrom(
        [...sources.agents, ...(options.agentSources ?? [])],
        "AGENT.md",
      );
      const skillPackages = await packagesFrom(
        [...sources.skills, ...(options.skillSources ?? [])],
        "SKILL.md",
      );
      const parsed = parseAgents(agentPackages.packages);
      const loaded = await loadSkills(skillPackages.packages);
      const catalog = loaded.catalog.merge(
        new SkillCatalog([], skillPackages.invalidSources),
      );
      const diagnostics = [
        ...agentPackages.diagnostics,
        ...skillPackages.diagnostics,
        ...parsed.diagnostics,
        ...loaded.diagnostics,
      ];
      const select = (id: string): AgentDefinition => {
        const agent = parsed.agents.find((candidate) => candidate.id === id);
        if (!agent) {
          throw new Error(
            `Configuration: selected agent ${id} is missing or invalid. ${diagnostics.map((item) => `${item.location}: ${item.message}`).join("; ")}`,
          );
        }
        return agent;
      };
      const selected = select(config.kaeno.agent);
      const assistantDefinition =
        config.kaeno.skills === undefined
          ? selected
          : { ...selected, skills: config.kaeno.skills };
      const workerDefinitions = config.workers.map(select);
      const defaults = {
        model:
          options.defaultModel ??
          (config.defaultModel
            ? parseModelRef(config.defaultModel)
            : undefined),
      };
      const bindingsFor = (agent: AgentDefinition): readonly Binding[] => {
        const bindings = [...(options.bindingsFor?.(agent) ?? [])];
        if (bindings.some((binding) => binding.owner === SKILLS_EXTENSION)) {
          throw new Error(
            "Use skillsFor for native skill contributions; bindingsFor must not supply a second skills binding",
          );
        }
        if (agent.origin) {
          bindings.push(agentOriginBinding(agent.id, agent.origin));
        }
        return bindings;
      };
      const binderFor = (
        agent: AgentDefinition,
        role: "assistant" | "worker",
      ) => skillBinder(catalog, options.skillsFor?.(agent, role));
      const assistantBinder = binderFor(assistantDefinition, "assistant");
      const assistant = resolveAgentSetup(
        assistantDefinition,
        { ...defaults, tools: [...ORCHESTRATION, ...(options.tools ?? [])] },
        assistantBinder,
        bindingsFor,
      );
      const assistantTools = [
        ...CODING,
        ...ORCHESTRATION,
        ...assistantBinder.tools,
        ...(options.tools ?? []),
      ];
      const missing = (assistant.tools ?? []).filter(
        (tool) => !assistantTools.includes(tool),
      );
      if (missing.length) {
        throw new Error(
          `Configuration: assistant tools are not installed/approved: ${missing.join(", ")}`,
        );
      }
      const workerTools = [
        ...new Set([
          ...WORKER_TOOLS,
          ...assistantBinder.tools,
          ...(options.tools ?? []),
        ]),
      ];
      const participants = agentParticipants({
        agents: workerDefinitions,
        defaults: {
          ...defaults,
          tools: [...WORKER_TOOLS, ...(options.tools ?? [])],
        },
        skills: (agent) => binderFor(agent, "worker"),
        bindingsFor,
        tools: workerTools,
      });
      for (const worker of participants.list()) {
        if (!worker.available) {
          throw new Error(
            `Configuration: selected worker ${worker.id} is unavailable: ${worker.reason}`,
          );
        }
      }
      return {
        assistant,
        extensions: [
          { durable: CodingTools },
          skillsExtension(),
          definitionOriginsExtension(),
          ...(options.extensions ?? []),
        ],
        work: {
          participants,
          environment: options.environment,
          tools: workerTools,
          maxDepth: options.maxDepth ?? 2,
          maxConcurrent: options.maxConcurrent ?? 4,
        },
        diagnostics,
      };
    },
  );
}
