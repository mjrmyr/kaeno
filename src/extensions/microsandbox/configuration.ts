import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  ConfiguredExecution,
  ExecutionConfigurationContext,
} from "../execution/index.ts";
import { MicrosandboxSandboxProvider } from "./microsandbox.ts";
import { MicrosandboxEngine } from "./vm.ts";

const configurationSchema = z
  .object({
    image: z.string().trim().min(1).default("kaeno:local"),
    namespace: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/)
      .optional(),
    cpus: z.number().positive().default(1),
    memoryBytes: z.number().int().min(1_048_576).default(1_073_741_824),
  })
  .strict();

/** The microVM extension owns settings, defaults and SDK construction. */
export async function loadMicrosandboxConfiguration(
  path: string,
  context: ExecutionConfigurationContext,
): Promise<ConfiguredExecution> {
  const config = configurationSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  return {
    environment: context.createSandboxEnvironment({
      sandbox: new MicrosandboxSandboxProvider({
        engine: new MicrosandboxEngine(),
        namespace: config.namespace ?? context.defaultNamespace,
        createEnvironment: context.createEnvironment,
      }),
      image: config.image,
      limits: { cpus: config.cpus, memoryBytes: config.memoryBytes },
    }),
    extensions: [],
  };
}
