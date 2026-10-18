import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type {
  ConversationSetup,
  KaenoExtension,
  ModelRef,
  WorkOptions,
} from "../application/index.ts";
import {
  agentParticipants,
  parseAgent,
  parseModelRef,
  parseAgents,
  resolveAgentSetup,
} from "../agents/index.ts";
import {
  directorySource,
  readManifestFile,
  type DefinitionPackage,
  type DefinitionSource,
  type Diagnostic,
} from "../definitions/index.ts";
import { loadSkills, skillBinder, skillsExtension } from "../skills/index.ts";
import type { WorkEnvironment } from "../work/index.ts";

const ORCHESTRATION = [
  "start_work",
  "list_work",
  "inspect_work",
  "message_work",
  "cancel_work",
];
const WORKER_TOOLS = [
  ...(CodingTools.tools ?? []).map((tool) => tool.name),
  ...ORCHESTRATION,
  "message_parent",
];

async function packagesFrom(
  sources: readonly DefinitionSource[],
  manifest: string,
): Promise<{
  packages: DefinitionPackage[];
  diagnostics: Diagnostic[];
}> {
  const packages: DefinitionPackage[] = [];
  const diagnostics: Diagnostic[] = [];
  const aliases = new Set<string>();
  for (const source of sources) {
    if (aliases.has(source.alias)) {
      throw new Error(`Duplicate definition source alias "${source.alias}"`);
    }
    aliases.add(source.alias);
    try {
      const snapshot = await source.snapshot(manifest);
      packages.push(...snapshot.packages);
      diagnostics.push(...snapshot.diagnostics);
    } catch (error) {
      // A catalog outage must not prevent installed readers from resuming already saved work.
      diagnostics.push({
        location: `source:${source.alias}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { packages, diagnostics };
}

/**
 * Chosen filesystem composition, not core policy. Local roots are relative to the captured startup
 * directory; home roots are external sources. Kaeno's local AGENT.md overrides the home AGENT.md,
 * while catalogs use qualified aliases and never silently override names.
 */
export async function loadFileEnvironment(
  options: {
    root?: string;
    home?: string;
    agentSources?: readonly DefinitionSource[];
    skillSources?: readonly DefinitionSource[];
    environment?: WorkEnvironment;
    maxDepth?: number;
    maxConcurrent?: number;
    defaultModel?: ModelRef;
  } = {},
): Promise<{
  assistant: ConversationSetup;
  extensions: KaenoExtension[];
  work?: WorkOptions;
  diagnostics: Diagnostic[];
}> {
  const root = await realpath(options.root ?? process.cwd());
  const home = await realpath(options.home ?? homedir());
  const separate = root !== home;
  const agentSources = options.agentSources ?? [
    directorySource("global", join(home, ".agents/agents")),
    ...(separate
      ? [directorySource("local", join(root, ".agents/agents"))]
      : []),
  ];
  const skillSources = options.skillSources ?? [
    directorySource("global", join(home, ".agents/skills")),
    ...(separate
      ? [directorySource("local", join(root, ".agents/skills"))]
      : []),
  ];
  const agentPackages = await packagesFrom(agentSources, "AGENT.md");
  const generalPackages = await packagesFrom(skillSources, "SKILL.md");
  const ownPackages = await packagesFrom(
    [
      directorySource("kaeno-global", join(home, ".kaeno/skills")),
      ...(separate
        ? [directorySource("kaeno-local", join(root, ".kaeno/skills"))]
        : []),
    ],
    "SKILL.md",
  );
  const general = await loadSkills(generalPackages.packages);
  const own = await loadSkills(ownPackages.packages);
  const assistantSkills = general.catalog.merge(own.catalog);
  const parsed = parseAgents(agentPackages.packages);
  const diagnostics = [
    ...agentPackages.diagnostics,
    ...generalPackages.diagnostics,
    ...ownPackages.diagnostics,
    ...parsed.diagnostics,
    ...general.diagnostics,
    ...own.diagnostics,
  ];

  const localPath = join(root, ".kaeno/AGENT.md");
  const homePath = join(home, ".kaeno/AGENT.md");
  const local = separate ? await readManifestFile(localPath) : undefined;
  const path = local === undefined ? homePath : localPath;
  const text = local ?? (await readManifestFile(homePath));
  if (text === undefined) {
    throw new Error(
      `No Kaeno assistant configured. Create ${localPath} or ${homePath} with name, description and model frontmatter.`,
    );
  }
  let definition = parseAgent(text, "kaeno", path);
  // Dedicated .kaeno skills are the assistant's default knowledge, not worker skills. An explicit
  // skills list (including []) is authoritative; it may also reference a general catalog skill.
  if (definition.skills === undefined) {
    definition = {
      ...definition,
      skills: own.catalog.list().map((skill) => skill.id),
    };
  }
  const defaultModel =
    options.defaultModel ??
    (definition.model ? parseModelRef(definition.model) : undefined);
  const participants = agentParticipants({
    agents: parsed.agents,
    defaults: { model: defaultModel, tools: WORKER_TOOLS },
    skills: skillBinder(general.catalog),
    tools: [...WORKER_TOOLS, "read_skill"],
  });
  const assistant = resolveAgentSetup(
    definition,
    {
      model: defaultModel,
      tools: ORCHESTRATION,
    },
    skillBinder(assistantSkills),
  );
  for (const participant of participants.list()) {
    if (!participant.available) {
      diagnostics.push({
        location: participant.id,
        message: participant.reason ?? "unavailable",
      });
    }
  }
  return {
    assistant,
    extensions: [{ durable: CodingTools }, skillsExtension()],
    // Keep fixed WORK definitions installed even when a source disappears. The empty catalog
    // prevents new launches, while saved trees remain recoverable. Assistant orchestration tools
    // stay available independently of the catalog; explicit tool selections remain authoritative.
    work: {
      participants,
      environment: options.environment,
      tools: [...WORKER_TOOLS, "read_skill"],
      maxDepth: options.maxDepth ?? 2,
      maxConcurrent: options.maxConcurrent ?? 4,
    },
    diagnostics,
  };
}
