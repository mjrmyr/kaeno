import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  parseSandboxResources,
  type SandboxResources,
} from "../sandboxes/index.ts";
import {
  parseSkillRepositories,
  parseSkillSelection,
  type RepositorySpec,
} from "../skills/index.ts";
export const PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type Provider = (typeof PROVIDERS)[number];
/** Providers are optional: a missing key only makes templates using it unavailable. */
export const PROVIDER_KEYS: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};
export interface Template {
  name: string;
  description: string;
  model: {
    provider: Provider;
    modelId: string;
  };
  thinkingLevel?: ModelThinkingLevel;
  instructions: string;
  delegates: string[];
  skills: string[];
}
export interface Config {
  agent: string;
  /** WORK levels below CHAT. 1: only CHAT starts work; 2: those WORK agents may start leaf WORK too. */
  maxDepth: number;
  /** Omitted means enabled, for compatibility with existing callers and deployments. */
  work?: boolean;
  /** Required when WORK is enabled; minimal conversations have no sandbox. */
  sandboxResources?: SandboxResources;
  skillRepositories: RepositorySpec[];
  templates: Record<string, Template>;
  telegram: {
    allowedChatIds: number[];
  };
}
const nonempty = z.string().refine((value) => value.trim().length > 0);
// Strict: removed per-template execution switches (sandbox/tools) must fail loudly, not be ignored.
const templateSchema = z
  .object({
    description: nonempty,
    model: nonempty,
    thinkingLevel: z.enum(THINKING).optional(),
    instructions: nonempty,
    delegates: z.array(z.string()).default([]),
    skills: z.unknown().optional(),
  })
  .strict();
// Strict: removed settings (sandboxCapacity) and typos must fail loudly, not be ignored.
const configSchema = z
  .object({
    agent: nonempty,
    maxDepth: z.number().int().min(1).max(8).default(2),
    work: z.boolean().default(true),
    sandboxResources: z.unknown().optional(),
    skillRepositories: z.unknown().optional(),
    templates: z.record(
      z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
      templateSchema,
    ),
    telegram: z
      .object({
        allowedChatIds: z.array(z.coerce.number().int().safe()).default([]),
      })
      .default({ allowedChatIds: [] }),
  })
  .strict();
export function eligibleWorkTemplates(config: Config): Template[] {
  return [
    ...new Set([config.agent, ...config.templates[config.agent].delegates]),
  ].map((name) => config.templates[name]);
}
export function parseConfig(raw: unknown): Config {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid kaeno config: ${parsed.error.message}`);
  }
  const config = parsed.data;
  const skillRepositories = parseSkillRepositories(config.skillRepositories);
  if (config.work && config.sandboxResources === undefined) {
    throw new Error(
      "Invalid kaeno config: sandboxResources is required when WORK is enabled",
    );
  }
  const sandboxResources =
    config.work || config.sandboxResources !== undefined
      ? boundary(() => parseSandboxResources(config.sandboxResources))
      : undefined;
  const templates: Record<string, Template> = {};
  for (const [name, template] of Object.entries(config.templates)) {
    const [providerName, ...rest] = template.model.split("/");
    const provider = z.enum(PROVIDERS).safeParse(providerName);
    if (!provider.success || rest.length === 0 || !rest.join("/")) {
      throw new Error(
        `Invalid kaeno config: ${name}.model must be one of ${PROVIDERS.join(", ")}/<model-id>`,
      );
    }
    templates[name] = {
      name,
      description: template.description,
      model: { provider: provider.data, modelId: rest.join("/") },
      thinkingLevel: template.thinkingLevel,
      instructions: template.instructions,
      delegates: template.delegates,
      skills: parseSkillSelection(template.skills, skillRepositories),
    };
  }
  for (const template of Object.values(templates)) {
    for (const delegate of template.delegates) {
      if (!Object.hasOwn(templates, delegate)) {
        throw new Error(
          `Invalid kaeno config: ${template.name}.delegates: unknown template ${delegate}`,
        );
      }
    }
  }
  if (!Object.hasOwn(templates, config.agent)) {
    throw new Error(
      `Invalid kaeno config: agent: unknown template ${config.agent}`,
    );
  }
  return {
    agent: config.agent,
    maxDepth: config.maxDepth,
    work: config.work,
    sandboxResources,
    skillRepositories,
    templates,
    telegram: config.telegram,
  };
}
function boundary<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new Error(
      `Invalid kaeno config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
export async function loadConfig(path: string): Promise<Config> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  return parseConfig(raw);
}
