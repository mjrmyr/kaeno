import {
  bindingSchema,
  ROUTER_EXTENSION,
  WORK_EXTENSION,
  type Binding,
  type KaenoExtension,
} from "../../core/application/index.ts";
import type {
  AgentExtension,
  InstalledExtension,
} from "../../extensions/contributions/index.ts";
import { SkillCatalog, skillBinder } from "../../extensions/skills/index.ts";

/** An extension means all its native tools and skill packages. Named selectors restrict policy. */
export type ContributionSelector =
  | InstalledExtension
  | { readonly tools: readonly string[]; readonly skills?: readonly string[] }
  | { readonly tools?: readonly string[]; readonly skills: readonly string[] };
export interface RolePolicy {
  readonly available: readonly ContributionSelector[];
  readonly defaults: readonly ContributionSelector[];
}
export interface AgentPolicies {
  readonly assistant: RolePolicy;
  readonly worker: RolePolicy;
}
export type ContributionPolicy = (base: {
  readonly assistant: RolePolicy;
  readonly worker: RolePolicy;
}) => AgentPolicies;

interface Selection {
  tools: string[];
  skills: string[];
}
interface ResolvedPolicy {
  available: Selection;
  defaults: Selection;
}
interface ResolvedContributions {
  tools: string[];
  bindings: Binding[];
  skillBinding: Binding | undefined;
}
interface ResolvedExtensions {
  workerTools: readonly string[];
  resolve(role: "assistant" | "worker"): ResolvedContributions;
}
const privateBindingSchema = bindingSchema.omit({ owner: true }).strict();

/** One composition-local ownership view; it neither defines nor executes tools. */
export function resolveExtensions(options: {
  extensions: readonly InstalledExtension[];
  standard: readonly KaenoExtension[];
  sourceSkills: SkillCatalog;
  assistantTools: readonly string[];
  workerTools: readonly string[];
  policy?: ContributionPolicy;
  skills?: readonly string[];
}): ResolvedExtensions {
  const installed = new Set(options.extensions);
  const extensions = options.extensions.filter(
    (extension): extension is AgentExtension => extension.runtime !== undefined,
  );
  const names = new Set([
    WORK_EXTENSION,
    ROUTER_EXTENSION,
    "kaeno-tool-authority",
  ]);
  const tools = new Set<string>();
  const toolOwners = new Map<string, AgentExtension>();
  const skillOwners = new Map<string, AgentExtension>();
  let catalog = options.sourceSkills;

  for (const runtime of [
    ...options.standard,
    ...extensions.map((extension) => extension.runtime),
  ]) {
    if (names.has(runtime.durable.name)) {
      throw new Error(
        `Duplicate or reserved extension: ${runtime.durable.name}`,
      );
    }
    names.add(runtime.durable.name);
    const ownTools = new Set<string>();
    for (const tool of runtime.durable.tools ?? []) {
      if (tools.has(tool.name)) {
        throw new Error(`Duplicate tool: ${tool.name}`);
      }
      tools.add(tool.name);
      ownTools.add(tool.name);
    }
    for (const name of runtime.readOnlyTools ?? []) {
      if (!ownTools.has(name)) {
        throw new Error(
          `Extension ${runtime.durable.name}: read-only tool "${name}" is not owned here`,
        );
      }
    }
  }
  for (const name of new Set([
    ...options.assistantTools,
    ...options.workerTools,
  ])) {
    tools.add(name);
  }
  for (const extension of extensions) {
    for (const tool of extension.runtime.durable.tools ?? []) {
      if (
        options.assistantTools.includes(tool.name) ||
        options.workerTools.includes(tool.name)
      ) {
        throw new Error(`Duplicate standard tool: ${tool.name}`);
      }
      toolOwners.set(tool.name, extension);
    }
    for (const { id } of extension.skills?.list() ?? []) {
      skillOwners.set(id, extension);
    }
    if (extension.skills) {
      catalog = catalog.merge(extension.skills);
    }
  }

  function select(selectors: readonly ContributionSelector[]): Selection {
    const selectedTools = new Set<string>();
    const selectedSkills = new Set<string>();
    for (const selector of selectors) {
      if ("runtime" in selector || "definitionReaders" in selector) {
        if (!installed.has(selector)) {
          const name =
            selector.runtime?.durable.name ??
            selector.definitionReaders?.map((reader) => reader.name).join(", ");
          throw new Error(
            `Policy references an uninstalled extension: ${name}`,
          );
        }
        for (const tool of selector.runtime?.durable.tools ?? []) {
          selectedTools.add(tool.name);
        }
        for (const { id } of selector.skills?.list() ?? []) {
          selectedSkills.add(id);
        }
      } else {
        for (const name of selector.tools ?? []) {
          if (!tools.has(name)) {
            throw new Error(`Policy tool "${name}" is not installed`);
          }
          selectedTools.add(name);
        }
        for (const id of catalog.select(selector.skills ?? [])) {
          selectedSkills.add(id);
        }
      }
    }
    return { tools: [...selectedTools], skills: [...selectedSkills] };
  }
  function within(
    label: string,
    selected: Selection,
    ceiling: Selection,
  ): void {
    for (const kind of ["tools", "skills"] as const) {
      for (const id of selected[kind]) {
        if (!ceiling[kind].includes(id)) {
          throw new Error(
            `${label}: ${kind === "tools" ? "tool" : "skill"} "${id}" is outside policy availability`,
          );
        }
      }
    }
  }
  function policyOf(policy: RolePolicy, label: string): ResolvedPolicy {
    const available = select(policy.available);
    const defaults = select(policy.defaults);
    within(`${label} defaults`, defaults, available);
    return { available, defaults };
  }
  const sourceSkills: ContributionSelector = {
    skills: options.sourceSkills.list().map(({ id }) => id),
  };
  const base = {
    assistant: {
      available: [{ tools: options.assistantTools }, sourceSkills],
      defaults: [
        { tools: options.assistantTools },
        {
          skills:
            options.skills ?? options.sourceSkills.list().map(({ id }) => id),
        },
      ],
    },
    worker: {
      available: [{ tools: options.workerTools }, sourceSkills],
      defaults: [
        { tools: options.workerTools },
        {
          skills:
            options.skills ?? options.sourceSkills.list().map(({ id }) => id),
        },
      ],
    },
  };
  const policy: AgentPolicies = options.policy?.(base) ?? base;
  const roles = {
    assistant: policyOf(policy.assistant, "Assistant"),
    worker: policyOf(policy.worker, "Worker"),
  };

  return {
    workerTools: roles.worker.available.tools,
    resolve(role: "assistant" | "worker"): ResolvedContributions {
      const selected = roles[role].defaults;
      const skillBinding = skillBinder(catalog)(selected.skills);
      const bindings: Binding[] = [];
      for (const extension of extensions) {
        const assigned = {
          tools: selected.tools.filter(
            (name) => toolOwners.get(name) === extension,
          ),
          skills: selected.skills.filter(
            (id) => skillOwners.get(id) === extension,
          ),
        };
        if (
          !extension.bind ||
          (assigned.tools.length === 0 && assigned.skills.length === 0)
        ) {
          continue;
        }
        const raw = extension.bind(assigned);
        if (raw === undefined) {
          continue;
        }
        const binding: Binding = {
          owner: extension.runtime.durable.name,
          ...privateBindingSchema.parse(raw),
        };
        extension.runtime.validateBinding(binding);
        bindings.push(binding);
      }
      return {
        tools: [...selected.tools],
        bindings,
        skillBinding,
      };
    },
  };
}
