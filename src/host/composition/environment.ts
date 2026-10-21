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
  type DefinitionPackage,
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
  for (const source of sources) {
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
  agentSources?: readonly DefinitionSource[];
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
      function select(id: string): AgentDefinition {
        const agent = parsed.agents.find((candidate) => candidate.id === id);
        if (!agent) {
          throw new Error(
            `Configuration: selected agent ${id} is missing or invalid. ${diagnostics.map((item) => `${item.location}: ${item.message}`).join("; ")}`,
          );
        }
        return agent;
      }
      const assistantDefinition = select(config.kaeno);
      const workerDefinitions = config.workers.map(select);
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
