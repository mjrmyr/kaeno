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
  .union([
    z.string().transform((value) => {
      const separator = value.indexOf(":");
      return {
        repository: separator < 0 ? value : value.slice(0, separator),
        ref: separator < 0 ? "HEAD" : value.slice(separator + 1),
        path: "",
      };
    }),
    z
      .object({
        repository: z.string(),
        ref: z.string().default("HEAD"),
        path: z.string().default(""),
      })
      .strict(),
  ])
  .pipe(
    z.object({
      repository: repositoryName.transform((value) => value.toLowerCase()),
      ref: reference,
      path: subtree,
    }),
  );
const directoryDeclaration = z
  .object({
    alias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    directory: z.string().min(1),
  })
  .strict();
const qualified = z.string().regex(/^[^:\s]+:[^:\s*]+$/);
const schema = z
  .object({
    sourceDirectory: z.string().min(1),
    agentRepositories: z.array(repositoryDeclaration).default([]),
    skillRepositories: z.array(repositoryDeclaration).default([]),
    localDefinitions: z
      .object({
        agents: z.array(directoryDeclaration).default([]),
        skills: z.array(directoryDeclaration).default([]),
      })
      .strict()
      .default({ agents: [], skills: [] }),
    kaeno: z
      .object({
        agent: qualified,
        skills: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    workers: z.array(qualified).default([]),
    defaultModel: z.string().min(1).optional(),
  })
  .strict();
export interface EnvironmentConfiguration {
  sourceDirectory: string;
  repositories: RepositoryDefinitionSource[];
  directories: DirectoryDefinitionSource[];
  kaeno: { agent: string; skills?: string[] };
  workers: string[];
  defaultModel?: string;
}

export function parseEnvironmentConfiguration(
  value: unknown,
  configFile: string,
): EnvironmentConfiguration {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid Kaeno configuration ${configFile}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  const config = parsed.data;
  if (new Set(config.workers).size !== config.workers.length) {
    throw new Error("Configuration: duplicate worker selection");
  }
  const repositories: RepositoryDefinitionSource[] = [];
  const directories: DirectoryDefinitionSource[] = [];
  const refs = new Map<string, string>();
  for (const kind of ["agents", "skills"] as const) {
    const aliases = new Set<string>();
    const declarations =
      kind === "agents" ? config.agentRepositories : config.skillRepositories;
    for (const item of declarations) {
      if (aliases.has(item.repository)) {
        throw new Error(
          `Configuration: duplicate ${kind} repository ${item.repository}`,
        );
      }
      if (refs.has(item.repository) && refs.get(item.repository) !== item.ref) {
        throw new Error(
          `Configuration: conflicting refs for ${item.repository}`,
        );
      }
      aliases.add(item.repository);
      refs.set(item.repository, item.ref);
      repositories.push({ kind, ...item });
    }
    for (const item of config.localDefinitions[kind]) {
      if (aliases.has(item.alias)) {
        throw new Error(
          `Configuration: duplicate ${kind} source alias ${item.alias}`,
        );
      }
      aliases.add(item.alias);
      directories.push({
        kind,
        alias: item.alias,
        directory: resolve(dirname(configFile), item.directory),
      });
    }
  }
  return {
    sourceDirectory: resolve(dirname(configFile), config.sourceDirectory),
    repositories,
    directories,
    kaeno: config.kaeno,
    workers: config.workers,
    defaultModel: config.defaultModel,
  };
}
