import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { Binding, KaenoExtension } from "../application/index.ts";
import {
  GITHUB_TOOLS,
  githubBinding,
  githubExtension,
} from "../github/index.ts";

const configSchema = z
  .object({
    appId: z.string().regex(/^\d+$/),
    privateKeyFile: z.string().min(1),
    installationId: z.number().int().positive(),
  })
  .strict();

/** Optional owner-controlled CLI composition. No core or Markdown GitHub configuration. */
export async function loadGitHubConfiguration(path: string): Promise<{
  extensions: KaenoExtension[];
  tools: readonly string[];
  bindingsFor(): readonly Binding[];
}> {
  const absolute = resolve(path);
  const config = configSchema.parse(
    JSON.parse(await readFile(absolute, "utf8")),
  );
  const privateKey = await readFile(
    resolve(dirname(absolute), config.privateKeyFile),
    "utf8",
  );
  const binding = githubBinding(config.installationId);
  return {
    extensions: [
      githubExtension({
        appId: config.appId,
        privateKey,
        installationId: config.installationId,
      }),
    ],
    tools: GITHUB_TOOLS,
    bindingsFor: () => [binding],
  };
}
