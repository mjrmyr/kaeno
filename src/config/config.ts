import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  parseSkillRepositories,
  parseSkillSelection,
  type RepositorySpec,
} from "../skills/index.ts";
export const PROVIDERS = ["anthropic", "openai"] as const;
export const CODING_TOOLS = ["read", "write", "edit", "bash"] as const;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type CodingTool = (typeof CODING_TOOLS)[number];
export interface Template {
  name: string;
  description: string;
  model: {
    provider: Provider;
    modelId: string;
  };
  thinkingLevel?: ModelThinkingLevel;
  instructions: string;
  sandbox: boolean;
  tools: CodingTool[];
  delegates: string[];
  skills: string[];
}
export interface Config {
  agent: string;
  skillRepositories: RepositorySpec[];
  templates: Record<string, Template>;
  telegram: {
    allowedChatIds: number[];
  };
}
const nonempty = z.string().refine((value) => value.trim().length > 0);
const templateSchema = z.object({
  description: nonempty,
  model: nonempty,
  thinkingLevel: z.enum(THINKING).optional(),
  instructions: nonempty,
  sandbox: z.boolean().default(false),
  tools: z.array(z.enum(CODING_TOOLS)).default([]),
  delegates: z.array(z.string()).default([]),
  skills: z.unknown().optional(),
});
const configSchema = z.object({
  agent: nonempty,
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
});
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
  const templates: Record<string, Template> = {};
  for (const [name, template] of Object.entries(config.templates)) {
    const [providerName, ...rest] = template.model.split("/");
    const provider = z.enum(PROVIDERS).safeParse(providerName);
    if (!provider.success || rest.length === 0 || !rest.join("/")) {
      throw new Error(
        `Invalid kaeno config: ${name}.model must be one of ${PROVIDERS.join(", ")}/<model-id>`,
      );
    }
    if (template.tools.length > 0 && !template.sandbox) {
      throw new Error(
        `Invalid kaeno config: ${name}: coding tools require sandbox: true`,
      );
    }
    templates[name] = {
      name,
      description: template.description,
      model: { provider: provider.data, modelId: rest.join("/") },
      thinkingLevel: template.thinkingLevel,
      instructions: template.instructions,
      sandbox: template.sandbox,
      tools: template.tools,
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
    skillRepositories,
    templates,
    telegram: config.telegram,
  };
}
export async function loadConfig(path: string): Promise<Config> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  return parseConfig(raw);
}
