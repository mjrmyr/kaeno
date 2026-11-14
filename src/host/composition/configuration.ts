import { dirname, resolve, posix } from "node:path";
import { z } from "zod";
import type {
  DirectoryDefinitionSource,
  RepositoryDefinitionSource,
} from "../../extensions/definitions/index.ts";

function hasControl(value: string): boolean {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

const repositoryName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine((value) =>
    value.split("/").every((part) => part !== "." && part !== ".."),
  );
const reference = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !value.startsWith("-") &&
      !hasControl(value) &&
      !/[\s~^:?*[\\]/.test(value) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith("."),
    "invalid Git ref",
  );
const subtree = z
  .string()
  .refine(
    (value) =>
      value === "" ||
      (!posix.isAbsolute(value) &&
        !value.includes("\\") &&
        !value
          .split("/")
          .some(
            (part) =>
              part === ".." || part === "." || part === "" || part === ".git",
          ) &&
        !hasControl(value)),
    "expected a safe relative discovery path",
  );
const repositoryDeclaration = z
  .object({
    provider: z.string().min(1),
    repository: repositoryName.transform((value) => value.toLowerCase()),
    ref: reference.default("HEAD"),
    path: subtree.optional(),
  })
  .strict();
const directoryDeclaration = z
  .object({
    alias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    directory: z.string().min(1),
  })
  .strict();
// The host selects installed code and a file; each extension owns the contents of that file.
const executionSchema = z
  .object({
    provider: z.string().min(1),
    configFile: z.string().min(1),
  })
  .strict();
export type ExecutionConfiguration = z.output<typeof executionSchema>;

const schema = z
  .object({
    sourceDirectory: z.string().min(1),
    skillRepositories: z.array(repositoryDeclaration).default([]),
    localDefinitions: z
      .object({
        skills: z.array(directoryDeclaration).default([]),
      })
      .strict()
      .default({ skills: [] }),
    skills: z.array(z.string().min(1)).optional(),
    defaultModel: z.string().min(1).optional(),
    execution: executionSchema.prefault({
      provider: "docker",
      configFile: "./docker.json",
    }),
  })
  .strict();
export interface EnvironmentConfiguration {
  sourceDirectory: string;
  repositories: RepositoryDefinitionSource[];
  directories: DirectoryDefinitionSource[];
  skills?: string[];
  defaultModel?: string;
  execution: ExecutionConfiguration;
}

export function parseEnvironmentConfiguration(
  value: unknown,
  configFile: string,
): EnvironmentConfiguration {
  if (typeof value === "object" && value !== null) {
    const legacy = ["agentRepositories", "kaeno", "workers"].filter(
      (key) => key in value,
    );
    const local =
      "localDefinitions" in value ? value.localDefinitions : undefined;
    if (
      legacy.length ||
      (typeof local === "object" && local !== null && "agents" in local)
    ) {
      throw new Error(
        "Agent definitions are no longer supported. Remove agentRepositories, kaeno, workers and localDefinitions.agents; configure skillRepositories/localDefinitions.skills and optional skills/defaultModel instead.",
      );
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid Kaeno configuration ${configFile}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  const config = parsed.data;
  const repositories: RepositoryDefinitionSource[] = [];
  const directories: DirectoryDefinitionSource[] = [];
  const aliases = new Set<string>();
  for (const item of config.skillRepositories) {
    if (aliases.has(item.repository)) {
      throw new Error(
        `Configuration: duplicate skills repository ${item.repository}`,
      );
    }
    aliases.add(item.repository);
    repositories.push({ kind: "skills", ...item, path: item.path ?? "" });
  }
  for (const item of config.localDefinitions.skills) {
    if (aliases.has(item.alias)) {
      throw new Error(
        `Configuration: duplicate skills source alias ${item.alias}`,
      );
    }
    aliases.add(item.alias);
    directories.push({
      kind: "skills",
      alias: item.alias,
      directory: resolve(dirname(configFile), item.directory),
    });
  }
  return {
    sourceDirectory: resolve(dirname(configFile), config.sourceDirectory),
    repositories,
    directories,
    skills: config.skills,
    defaultModel: config.defaultModel,
    execution: {
      ...config.execution,
      configFile: resolve(dirname(configFile), config.execution.configFile),
    },
  };
}
