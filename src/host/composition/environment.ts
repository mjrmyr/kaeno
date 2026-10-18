import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  WORK_TOOLS,
  type Binding,
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
  resolveAgents,
  type AgentDefinition,
} from "../../extensions/agents/index.ts";
import {
  definitionOriginsExtension,
  withDefinitionSources,
  type DefinitionPackage,
  type DefinitionSource,
  type Diagnostic,
  type RepositoryReader,
} from "../../extensions/definitions/index.ts";
import { githubRepositoryReader } from "../../extensions/github/index.ts";
import {
  loadSkills,
  skillBinder,
  skillsExtension,
  SKILLS_EXTENSION,
  SKILL_TOOLS,
  SkillCatalog,
  type BoundSkill,
} from "../../extensions/skills/index.ts";
import { parseEnvironmentConfiguration } from "./configuration.ts";

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
  /** Extension data every selected agent carries (e.g. a GitHub installation). */
  bindings?: readonly Binding[];
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
      const assistantDefinition = select(config.kaeno.agent);
      const workerDefinitions = config.workers.map(select);
      const defaults = {
        model:
          options.defaultModel ??
          (config.defaultModel
            ? parseModelRef(config.defaultModel)
            : undefined),
      };
      const bindings = options.bindings ?? [];
      if (bindings.some((binding) => binding.owner === SKILLS_EXTENSION)) {
        throw new Error(
          "Use skillsFor for native skill contributions; bindings must not supply a second skills binding",
        );
      }
      const binderFor = (
        agent: AgentDefinition,
        role: "assistant" | "worker",
      ) => skillBinder(catalog, options.skillsFor?.(agent, role));
      const assistantBinder = binderFor(assistantDefinition, "assistant");
      const assistant = resolveAgentSetup(
        assistantDefinition,
        {
          ...defaults,
          tools: [...ORCHESTRATION, ...(options.tools ?? []), ...SKILL_TOOLS],
        },
        assistantBinder,
        bindings,
      );
      const workerTools = [
        ...new Set([...WORKER_TOOLS, ...SKILL_TOOLS, ...(options.tools ?? [])]),
      ];
      // Selected workers must resolve; tool and binding fit is checked by core when Kaeno opens.
      const agents = resolveAgents({
        agents: workerDefinitions,
        defaults: {
          ...defaults,
          tools: [...WORKER_TOOLS, ...(options.tools ?? []), ...SKILL_TOOLS],
        },
        skills: (agent) => binderFor(agent, "worker"),
        bindings,
      });
      return {
        assistant,
        extensions: [
          { durable: CodingTools },
          skillsExtension(),
          definitionOriginsExtension(),
          ...(options.extensions ?? []),
        ],
        work: {
          agents,
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
