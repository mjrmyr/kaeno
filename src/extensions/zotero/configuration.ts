import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { KaenoExtension } from "../../core/application/index.ts";
import { ZoteroClient } from "./client.ts";
import { zoteroExtension } from "./extension.ts";

const configSchema = z
  .object({
    library: z
      .object({
        type: z.enum(["user", "group"]),
        id: z.number().int().positive(),
      })
      .strict(),
    apiKeyFile: z.string().min(1),
  })
  .strict();

export async function loadZoteroConfiguration(
  path: string,
): Promise<KaenoExtension> {
  const absolute = resolve(path);
  const config = configSchema.parse(
    JSON.parse(await readFile(absolute, "utf8")),
  );
  const apiKey = await readFile(
    resolve(dirname(absolute), config.apiKeyFile),
    "utf8",
  );
  return zoteroExtension(new ZoteroClient(config.library, apiKey));
}
