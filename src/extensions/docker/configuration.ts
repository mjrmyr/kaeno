import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  ConfiguredExecution,
  ExecutionConfigurationContext,
  ExecutionProvider,
} from "../execution/index.ts";
import { DockerSandboxProvider } from "./docker.ts";

const configurationSchema = z
  .object({
    image: z.string().trim().min(1).default("kaeno:local"),
    namespace: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/)
      .optional(),
    apiHost: z.string().trim().min(1).default("127.0.0.1"),
    cpus: z.number().positive().default(1),
    memoryBytes: z.number().int().positive().default(1_073_741_824),
  })
  .strict();

/** Docker owns its file format and constructs its runtime without contacting the daemon. */
export async function loadDockerConfiguration(
  path: string,
  context: ExecutionConfigurationContext,
): Promise<ConfiguredExecution> {
  const config = configurationSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  return {
    environment: context.createSandboxEnvironment({
      sandbox: new DockerSandboxProvider({
        namespace: config.namespace ?? context.defaultNamespace,
        apiHost: config.apiHost,
        createEnvironment: context.createEnvironment,
      }),
      image: config.image,
      limits: { cpus: config.cpus, memoryBytes: config.memoryBytes },
    }),
    extensions: [],
  };
}

export const dockerExecutionProvider: ExecutionProvider = {
  name: "docker",
  loadConfiguration: loadDockerConfiguration,
};
