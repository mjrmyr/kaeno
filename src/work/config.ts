import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { PROVIDERS, type Provider } from "../config/index.ts";

export interface Template {
  name: string;
  description: string;
  model: { provider: Provider; modelId: string };
  thinkingLevel?: ModelThinkingLevel;
  instructions: string;
  delegates: string[];
  skills: string[];
}

export interface WorkConfig {
  maxDepth: number;
  templates: Record<string, Template>;
}

const templateSchema = z
  .object({
    description: z.string().trim().min(1),
    model: z.string().trim().min(1),
    thinkingLevel: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh"])
      .optional(),
    instructions: z.string().trim().min(1),
    delegates: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
  })
  .strict();

/** Parse the WORK-only portion of configuration without coupling it to a sandbox backend. */
export function parseWorkConfig(raw: unknown): WorkConfig {
  const parsed = z
    .object({
      maxDepth: z.number().int().min(1).max(8).default(2),
      templates: z.record(
        z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
        templateSchema,
      ),
    })
    .strict()
    .parse(raw);
  const templates: Record<string, Template> = {};
  for (const [name, template] of Object.entries(parsed.templates)) {
    const [provider, ...modelId] = template.model.split("/");
    const modelProvider = z.enum(PROVIDERS).parse(provider);
    if (!modelId.join("/").trim()) {
      throw new Error(`Template ${name}.model must be provider/model-id`);
    }
    templates[name] = {
      name,
      description: template.description,
      model: { provider: modelProvider, modelId: modelId.join("/") },
      thinkingLevel: template.thinkingLevel,
      instructions: template.instructions,
      delegates: template.delegates,
      skills: template.skills,
    };
  }
  for (const template of Object.values(templates)) {
    for (const delegate of template.delegates) {
      if (!Object.hasOwn(templates, delegate)) {
        throw new Error(
          `Unknown delegate template ${delegate} in ${template.name}`,
        );
      }
    }
  }
  return { ...parsed, templates };
}

export async function loadWorkConfig(path: string): Promise<WorkConfig> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  return parseWorkConfig(raw);
}
