import { readFile } from "node:fs/promises";
import { z } from "zod";
export const PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_KEYS: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};
export interface Config {
  model: { provider: Provider; modelId: string };
  instructions: string;
}
export function parseConfig(raw: unknown): Config {
  const parsed = z
    .object({ model: z.string().min(1), instructions: z.string().min(1) })
    .strict()
    .parse(raw);
  const [name, ...rest] = parsed.model.split("/");
  const provider = z.enum(PROVIDERS).parse(name);
  if (!rest.join("/").trim()) {
    throw new Error("model must be provider/model-id");
  }
  return {
    model: { provider, modelId: rest.join("/") },
    instructions: parsed.instructions,
  };
}
export async function loadConfig(path: string): Promise<Config> {
  return parseConfig(JSON.parse(await readFile(path, "utf8")));
}
