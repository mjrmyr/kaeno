import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  WORK_TOOLS,
  type ConversationSetup,
  type KaenoExtension,
  type ModelRef,
  type WorkEnvironment,
  type WorkOptions,
} from "../../core/application/index.ts";
import {
  parseModelRef,
  parseAgents,
  resolveAgentSetup,
  type AgentDefinition,
} from "../../extensions/agents/index.ts";
import {
  definitionOriginsExtension,
  withDefinitionSources,
  type AgentSource,
  type DefinitionSource,
  type Diagnostic,
} from "../../extensions/definitions/index.ts";
import {
  loadSkills,
  skillsExtension,
  SKILL_TOOLS,
  SkillCatalog,
} from "../../extensions/skills/index.ts";
import type { InstalledExtension } from "../../extensions/contributions/index.ts";
import { resolveExtensions, type ContributionPolicy } from "./contributions.ts";
import {
  parseEnvironmentConfiguration,
  type ExecutionConfiguration,
} from "./configuration.ts";

const ORCHESTRATION = WORK_TOOLS.orchestration;
const CODING = (CodingTools.tools ?? []).map((tool) => tool.name);
const WORKER_TOOLS = [...CODING, ...ORCHESTRATION, ...WORK_TOOLS.parent];

async function packagesFrom<Source extends { alias: string }, Item>(
  sources: readonly Source[],
  snapshotSource: (source: Source) => Promise<{
    packages: readonly Item[];
    diagnostics: readonly Diagnostic[];
  }>,
): Promise<{
  packages: Item[];
  diagnostics: Diagnostic[];
  invalidSources: string[];
}> {
  const packages: Item[] = [];
  const diagnostics: Diagnostic[] = [];
  const invalidSources: string[] = [];
  for (const source of sources) {
    const snapshot = await snapshotSource(source);
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
  agentSources?: readonly AgentSource[];
  skillSources?: readonly DefinitionSource[];
  environment?: WorkEnvironment;
  maxDepth?: number;
  maxConcurrent?: number;
  defaultModel?: ModelRef;
  extensions?: readonly InstalledExtension[];
  policy?: ContributionPolicy;
  signal?: AbortSignal;
}
export interface LoadedEnvironment {
  execution: ExecutionConfiguration;
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
  // Reject collisions across configured and injected sources before any acquisition.
  for (const kind of ["agents", "skills"] as const) {
    const aliases = [
      ...config.repositories
        .filter((source) => source.kind === kind)
        .map((source) => source.repository),
      ...config.directories
        .filter((source) => source.kind === kind)
        .map((source) => source.alias),
      ...(kind === "agents"
        ? (options.agentSources ?? [])
        : (options.skillSources ?? [])
      ).map((source) => source.alias),
    ];
    const sourceSet = new Set<string>();
    for (const alias of aliases) {
      if (sourceSet.has(alias)) {
        throw new Error(`Duplicate definition source alias "${alias}"`);
      }
      sourceSet.add(alias);
    }
  }
  return withDefinitionSources(
    {
      directory: config.sourceDirectory,
      repositories: config.repositories,
      directories: config.directories,
      readers: (options.extensions ?? []).flatMap(
        (extension) => extension.definitionReaders ?? [],
      ),
      mode: options.sourceMode,
      signal: options.signal,
    },
    async (sources) => {
      const agentPackages = await packagesFrom(
        [...sources.agents, ...(options.agentSources ?? [])],
        async (source) => {
          const { documents, diagnostics } = await source.snapshot();
          return { packages: documents, diagnostics };
        },
      );
      const skillPackages = await packagesFrom(
        [...sources.skills, ...(options.skillSources ?? [])],
        (source) => source.snapshot("SKILL.md"),
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
      function select(id: string): AgentDefinition {
        const agent = parsed.agents.find((candidate) => candidate.id === id);
        if (!agent) {
          throw new Error(
            `Configuration: selected agent ${id} is missing or invalid. ${diagnostics.map((item) => `${item.location}: ${item.message}`).join("; ")}`,
          );
        }
        return agent;
      }
      // Document locations that produced no valid agent: parse errors and duplicate IDs.
      const valid = new Set(parsed.agents.map((agent) => agent.location));
      const invalidAgentSources = new Set([
        ...agentPackages.invalidSources,
        ...agentPackages.packages
          .filter((document) => !valid.has(document.manifestPath))
          .map((document) => document.source),
      ]);
      /** Resolve worker IDs and source:* wildcards in stable order, like skill selection. */
      function selectWorkers(references: readonly string[]): AgentDefinition[] {
        const selected = new Map<string, AgentDefinition>();
        for (const reference of references) {
          if (!reference.endsWith(":*")) {
            const agent = select(reference);
            selected.set(agent.id, agent);
            continue;
          }
          const source = reference.slice(0, -2);
          // Never silently drop a malformed record from a wildcard selection.
          if (invalidAgentSources.has(source)) {
            throw new Error(
              `Configuration: cannot expand worker selection ${reference}: source ${source} has invalid agent records. ${diagnostics.map((item) => `${item.location}: ${item.message}`).join("; ")}`,
            );
          }
          // The agent Kaeno runs as is a worker only when selected explicitly.
          const matches = parsed.agents
            .filter(
              (agent) =>
                agent.id.startsWith(`${source}:`) && agent.id !== config.kaeno,
            )
            .sort((left, right) => (left.id < right.id ? -1 : 1));
          if (matches.length === 0) {
            throw new Error(
              `Configuration: empty worker selection ${reference}`,
            );
          }
          for (const agent of matches) {
            selected.set(agent.id, agent);
          }
        }
        return [...selected.values()];
      }
      const assistantDefinition = select(config.kaeno);
      const workerDefinitions = selectWorkers(config.workers);
      const defaults = {
        model:
          options.defaultModel ??
          (config.defaultModel
            ? parseModelRef(config.defaultModel)
            : undefined),
      };
      const standard: KaenoExtension[] = [
        { durable: CodingTools },
        skillsExtension(),
        definitionOriginsExtension(),
      ];
      const contributions = resolveExtensions({
        extensions: options.extensions ?? [],
        standard,
        sourceSkills: catalog,
        assistantTools: [...ORCHESTRATION, ...SKILL_TOOLS],
        workerTools: [...WORKER_TOOLS, ...SKILL_TOOLS],
        policy: options.policy,
      });
      function setupFor(
        agent: AgentDefinition,
        role: "assistant" | "worker",
      ): ConversationSetup {
        try {
          const assigned = contributions.resolve(agent, role);
          return resolveAgentSetup(
            agent,
            { ...defaults, tools: assigned.tools },
            () => assigned.skillBinding,
            assigned.bindings,
          );
        } catch (error) {
          throw new Error(
            `Agent ${agent.id} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
      const assistant = setupFor(assistantDefinition, "assistant");
      const agents = workerDefinitions.map((agent) => ({
        id: agent.id,
        description: agent.description,
        setup: setupFor(agent, "worker"),
      }));
      return {
        execution: config.execution,
        assistant,
        extensions: [
          ...standard,
          ...(options.extensions ?? []).flatMap((extension) =>
            extension.runtime ? [extension.runtime] : [],
          ),
        ],
        work: {
          agents,
          environment: options.environment,
          tools: contributions.workerTools,
          maxDepth: options.maxDepth ?? 2,
          maxConcurrent: options.maxConcurrent ?? 4,
        },
        diagnostics,
      };
    },
  );
}
