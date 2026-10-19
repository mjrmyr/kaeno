import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { configurationSchema, kubernetesExtension } from "./extension.ts";
import type {
  ConfiguredExecution,
  ExecutionConfigurationContext,
  ExecutionProvider,
} from "../execution/index.ts";

const serviceAccountRoot = "/var/run/secrets/kubernetes.io/serviceaccount";
const fileSchema = configurationSchema
  .extend({
    tokenFile: z.string().min(1).default(`${serviceAccountRoot}/token`),
    caFile: z
      .string()
      .min(1)
      .nullable()
      .default(`${serviceAccountRoot}/ca.crt`),
  })
  .strict();

/** Kubernetes owns its file format. Relative credential paths are relative to this file. */
export async function loadKubernetesConfiguration(
  path: string,
  context: ExecutionConfigurationContext,
): Promise<ConfiguredExecution> {
  const absolute = resolve(path);
  const { tokenFile, caFile, ...config } = fileSchema.parse(
    JSON.parse(await readFile(absolute, "utf8")),
  );
  const tokenPath = resolve(dirname(absolute), tokenFile);
  const ca =
    caFile === null
      ? undefined
      : await readFile(resolve(dirname(absolute), caFile), "utf8");
  const configured = kubernetesExtension({
    ...config,
    ca,
    readToken: () => readFile(tokenPath, "utf8"),
    createEnvironment: context.createEnvironment,
  });
  return {
    environment: configured.environment,
    extensions: [configured.extension],
  };
}

export const kubernetesExecutionProvider: ExecutionProvider = {
  name: "kubernetes",
  loadConfiguration: loadKubernetesConfiguration,
};
