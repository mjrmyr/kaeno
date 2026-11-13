import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  ROUTER_TOOLS,
  WORK_TOOLS,
  type ConversationSetup,
  type KaenoExtension,
  type ModelRef,
  type WorkEnvironment,
  type WorkOptions,
} from "../../core/application/index.ts";
import { DEFAULT_MODEL, KAENO_PERSONA, parseModelRef } from "./persona.ts";
import {
  definitionOriginsExtension,
  withDefinitionSources,
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
const WORKER_TOOLS = [
  ...CODING,
  ...ORCHESTRATION,
  ...WORK_TOOLS.parent,
  ...ROUTER_TOOLS.ticket,
];

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
  const aliases = [
    ...config.repositories.map((source) => source.repository),
    ...config.directories.map((source) => source.alias),
    ...(options.skillSources ?? []).map((source) => source.alias),
  ];
  if (new Set(aliases).size !== aliases.length) {
    throw new Error("Duplicate skill source alias");
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
      const skillPackages = await packagesFrom(
        [...sources.skills, ...(options.skillSources ?? [])],
        (source) => source.snapshot("SKILL.md"),
      );
      const loaded = await loadSkills(skillPackages.packages);
      const catalog = loaded.catalog.merge(
        new SkillCatalog([], skillPackages.invalidSources),
      );
      const diagnostics = [...skillPackages.diagnostics, ...loaded.diagnostics];
      if (config.skills === undefined && diagnostics.length > 0) {
        throw new Error(
          `Cannot select all configured skills: invalid skill packages. ${diagnostics.map((item) => `${item.location}: ${item.message}`).join("; ")}`,
        );
      }
      const model =
        options.defaultModel ??
        (config.defaultModel
          ? parseModelRef(config.defaultModel)
          : DEFAULT_MODEL);
      const standard: KaenoExtension[] = [
        { durable: CodingTools },
        skillsExtension(),
        definitionOriginsExtension(),
      ];
      const contributions = resolveExtensions({
        extensions: options.extensions ?? [],
        standard,
        sourceSkills: catalog,
        assistantTools: [...ROUTER_TOOLS.router, ...SKILL_TOOLS],
        workerTools: [...WORKER_TOOLS, ...SKILL_TOOLS],
        policy: options.policy,
        skills: config.skills,
      });
      function setupFor(role: "assistant" | "worker"): ConversationSetup {
        const assigned = contributions.resolve(role);
        return {
          model,
          instructions: role === "assistant" ? KAENO_PERSONA : "",
          tools: assigned.tools,
          bindings: [
            ...assigned.bindings,
            ...(assigned.skillBinding ? [assigned.skillBinding] : []),
          ],
        };
      }
      const assistant = setupFor("assistant");
      const setup = setupFor("worker");
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
          setup,
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
