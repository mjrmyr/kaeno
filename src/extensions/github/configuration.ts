import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { AgentExtension } from "../contributions/index.ts";
import type { RepositoryReader } from "../definitions/index.ts";
import { githubRepositoryReader } from "./definitions.ts";
import { githubExtension } from "./extension.ts";

const configSchema = z
  .object({
    appId: z.string().regex(/^\d+$/),
    privateKeyFile: z.string().min(1),
    installationId: z.number().int().positive(),
  })
  .strict();

/** Optional owner-controlled CLI composition. No core or Markdown GitHub configuration. */
export async function loadGitHubConfiguration(path: string): Promise<{
  extension: AgentExtension;
  repositoryReader: RepositoryReader;
}> {
  const absolute = resolve(path);
  const config = configSchema.parse(
    JSON.parse(await readFile(absolute, "utf8")),
  );
  const privateKey = await readFile(
    resolve(dirname(absolute), config.privateKeyFile),
    "utf8",
  );
  return {
    extension: githubExtension({
      appId: config.appId,
      privateKey,
      installationId: config.installationId,
    }),
    repositoryReader: githubRepositoryReader({
      app: {
        appId: config.appId,
        privateKey,
        installationId: config.installationId,
      },
    }),
  };
}
