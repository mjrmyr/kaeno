import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { genericAdapter, type WebhookSource } from "./webhooks.ts";

const RESERVED = ["telegram", "pi", "http"];

const configSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    sources: z
      .array(
        z
          .object({
            name: z
              .string()
              .regex(/^[a-z0-9-]{1,40}$/)
              .refine((name) => !RESERVED.includes(name), {
                message: `Source names ${RESERVED.join(", ")} belong to Kaeno's channels`,
              }),
            kind: z.literal("generic"),
            secretFile: z.string().min(1),
            trust: z.union([
              z.literal("all"),
              z.object({ actors: z.array(z.string().min(1)).min(1) }).strict(),
            ]),
          })
          .strict(),
      )
      .min(1)
      .refine(
        (sources) =>
          new Set(sources.map((source) => source.name)).size === sources.length,
        { message: "Source names must be unique" },
      ),
  })
  .strict();

/** Owner configuration and host-only secrets; never included in agent setup or prompts. */
export async function loadWebhooks(
  env: NodeJS.ProcessEnv,
): Promise<{ port: number; sources: WebhookSource[] } | undefined> {
  const path = env.KAENO_WEBHOOKS_CONFIG;
  if (!path) {
    return undefined;
  }
  const absolute = resolve(path);
  const config = configSchema.parse(
    JSON.parse(await readFile(absolute, "utf8")),
  );
  const sources: WebhookSource[] = [];
  for (const source of config.sources) {
    const secret = (
      await readFile(resolve(dirname(absolute), source.secretFile), "utf8")
    ).trim();
    if (secret.length < 32) {
      throw new Error(
        `Webhook source ${source.name}: its secret must be at least 32 characters`,
      );
    }
    sources.push({
      name: source.name,
      adapter: genericAdapter(secret),
      trust: source.trust,
    });
  }
  return { port: config.port, sources };
}
