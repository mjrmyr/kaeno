import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lock } from "proper-lockfile";
import { z } from "zod";
import {
  directorySource,
  readManifestFile,
  type DefinitionPackage,
  type DefinitionSource,
} from "./directory.ts";
import type { DefinitionOrigin } from "./origin.ts";
import type { Diagnostic } from "./manifest.ts";

export interface RepositoryReader {
  /** Write a credential-free regular-file export into the supplied private directory. */
  read(
    request: { repository: string; ref: string },
    destination: string,
    signal?: AbortSignal,
  ): Promise<{ commit: string }>;
}
/** A stable, nonsecret registration name identifies the reader's source/authorization namespace. */
export interface DefinitionReader extends RepositoryReader {
  readonly name: string;
}
export interface RepositoryDefinitionSource {
  kind: "skills";
  provider: string;
  repository: string;
  ref: string;
  path: string;
}
export interface DirectoryDefinitionSource {
  kind: "skills";
  alias: string;
  directory: string;
}
export interface DefinitionSources {
  skills: DefinitionSource[];
}
// Keep the completed-load format stable for existing skills-only offline caches.
const RECORD_VERSION = 2;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const pinSchema = z
  .object({
    key: hashSchema,
    hash: hashSchema,
    commit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(RECORD_VERSION),
    recipe: hashSchema,
    pins: z.array(pinSchema),
  })
  .strict();
type Pin = z.infer<typeof pinSchema>;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 16384;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** A bounded, no-links tree hash. File names, bytes and executable bits are inputs. */
export async function definitionTreeHash(
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  let files = 0;
  async function walk(path: string): Promise<void> {
    signal?.throwIfAborted();
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error(
        `Definitions: links/special files are not supported: ${path}`,
      );
    }
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (name === ".git") {
          throw new Error("Definitions: Git metadata must not be exported");
        }
        await walk(join(path, name));
      }
      return;
    }
    bytes += info.size;
    files++;
    if (
      bytes > MAX_BYTES ||
      files > MAX_FILES ||
      info.size > 64 * 1024 * 1024
    ) {
      throw new Error("Definitions: source exceeds export size/file limit");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new Error("Definitions: source changed during capture");
      }
      const content = await handle.readFile();
      const after = await handle.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        content.length !== info.size
      ) {
        throw new Error("Definitions: source changed during capture");
      }
      hash.update(
        JSON.stringify([
          relative(root, path).split(sep).join("/"),
          (info.mode & 0o111) === 0 ? 0 : 1,
          content.length,
        ]) + "\n",
      );
      hash.update(content);
    } finally {
      await handle.close();
    }
  }
  await walk(root);
  return hash.digest("hex");
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function sealTree(root: string): Promise<void> {
  for (const name of await readdir(root)) {
    const path = join(root, name);
    const info = await lstat(path);
    if (info.isDirectory()) {
      await sealTree(path);
      await syncDirectory(path);
    } else {
      await chmod(path, info.mode & 0o111 ? 0o555 : 0o444);
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  await syncDirectory(root);
}
async function copyDirectory(
  source: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  for (const name of await readdir(source)) {
    signal.throwIfAborted();
    const from = join(source, name);
    const to = join(target, name);
    const info = await lstat(from);
    if (info.isDirectory()) {
      await mkdir(to);
      await copyDirectory(from, to, signal);
    } else if (info.isFile()) {
      await copyFile(from, to, constants.COPYFILE_EXCL);
      await chmod(to, info.mode & 0o111 ? 0o700 : 0o600);
    } else {
      throw new Error(`Definitions: linked or special local input: ${from}`);
    }
  }
}

function sourceView(options: {
  alias: string;
  root: string;
  recursive: boolean;
  origin: (path: string, contentHash: string) => DefinitionOrigin;
}): DefinitionSource {
  return {
    alias: options.alias,
    async snapshot(manifestName) {
      if (manifestName !== "SKILL.md") {
        throw new Error("Definitions: unsupported manifest");
      }
      if (!options.recursive) {
        const result = await directorySource(
          options.alias,
          options.root,
        ).snapshot(manifestName);
        const packages = await Promise.all(
          result.packages.map(async (item) => ({
            ...item,
            origin: options.origin(
              item.directory,
              await definitionTreeHash(item.directory),
            ),
          })),
        );
        return { packages, diagnostics: result.diagnostics };
      }
      const packages: DefinitionPackage[] = [];
      const diagnostics: Diagnostic[] = [];
      async function discover(
        directory: string,
        parentPackage?: string,
      ): Promise<void> {
        let text: string | undefined;
        try {
          text = await readManifestFile(join(directory, manifestName));
        } catch (error) {
          diagnostics.push({
            location: join(directory, manifestName),
            message: error instanceof Error ? error.message : String(error),
          });
        }
        if (text !== undefined) {
          if (parentPackage) {
            throw new Error(
              `Definitions: overlapping ${manifestName} packages: ${parentPackage} and ${directory}`,
            );
          }
          packages.push({
            source: options.alias,
            directory,
            manifest: text,
            origin: options.origin(
              directory,
              await definitionTreeHash(directory),
            ),
          });
          if (packages.length > 512) {
            throw new Error("Definitions: too many packages");
          }
        }
        for (const name of (await readdir(directory)).sort()) {
          if (
            !name.startsWith(".") &&
            (await lstat(join(directory, name))).isDirectory()
          ) {
            await discover(
              join(directory, name),
              text === undefined ? parentPackage : directory,
            );
          }
        }
      }
      await discover(options.root);
      return { packages, diagnostics };
    },
  };
}

/** One private cache transaction; publication follows successful consumer resolution. */
export async function withDefinitionSources<Result>(
  options: {
    directory: string;
    repositories: readonly RepositoryDefinitionSource[];
    directories: readonly DirectoryDefinitionSource[];
    readers: readonly DefinitionReader[];
    mode?: "refresh" | "offline";
    signal?: AbortSignal;
  },
  consume: (sources: DefinitionSources) => Promise<Result>,
): Promise<Result> {
  const readers = new Map<string, DefinitionReader>();
  for (const reader of options.readers) {
    if (!reader.name) {
      throw new Error("Definitions: reader name must not be empty");
    }
    if (readers.has(reader.name)) {
      throw new Error(`Definitions: duplicate reader "${reader.name}"`);
    }
    readers.set(reader.name, reader);
  }
  const inputs = new Map<
    string,
    | {
        provider: string;
        repository: string;
        ref: string;
        reader: RepositoryReader;
      }
    | { directory: string }
  >();
  const repositories = options.repositories.map((source) => {
    const reader = readers.get(source.provider);
    if (!reader) {
      throw new Error(`Definitions: unknown reader "${source.provider}"`);
    }
    if (
      !/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(source.repository) ||
      source.path.startsWith("/") ||
      source.path.includes("\\") ||
      source.path
        .split("/")
        .some((part) => part === ".." || part === "." || part === ".git")
    ) {
      throw new Error(
        "Definitions: invalid repository identity or discovery path",
      );
    }
    const input = {
      provider: source.provider,
      repository: source.repository,
      ref: source.ref,
    };
    const key = digest(JSON.stringify(input));
    inputs.set(key, { ...input, reader });
    return { source, key };
  });
  for (const item of options.directories) {
    const input = { directory: item.directory };
    inputs.set(digest(JSON.stringify(input)), input);
  }
  const root = join(options.directory, "definitions-v1");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const compromised = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, compromised.signal])
    : compromised.signal;
  signal.throwIfAborted();
  const deadline = Date.now() + 120_000;
  async function acquire(): Promise<() => Promise<void>> {
    while (true) {
      signal.throwIfAborted();
      try {
        return await lock(root, {
          stale: 30_000,
          update: 5_000,
          retries: 0,
          onCompromised: (error) => compromised.abort(error),
        });
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ELOCKED"
          ) ||
          Date.now() >= deadline
        ) {
          throw error;
        }
        await delay(100, undefined, { signal });
      }
    }
  }
  const release = await acquire();
  let staging: string | undefined;
  try {
    signal.throwIfAborted();
    const trees = join(root, "trees");
    const records = join(root, "loads");
    await mkdir(trees, { recursive: true, mode: 0o700 });
    await mkdir(records, { recursive: true, mode: 0o700 });
    await syncDirectory(root);
    await syncDirectory(options.directory);
    function recipeFor(version: number): string {
      return digest(
        JSON.stringify({
          version,
          repositories: options.repositories,
          directories: options.directories,
        }),
      );
    }
    const recipe = recipeFor(RECORD_VERSION);
    const record = join(records, `${recipe}.json`);
    const pins: Pin[] = [];
    if (options.mode === "offline") {
      let parsed: z.infer<typeof manifestSchema>;
      try {
        parsed = manifestSchema.parse(
          JSON.parse(await readFile(record, "utf8")),
        );
      } catch {
        throw new Error(
          "Definitions: no verified complete offline input set for this source configuration",
        );
      }
      if (
        parsed.recipe !== recipe ||
        parsed.pins.length !== inputs.size ||
        new Set(parsed.pins.map((pin) => pin.key)).size !== inputs.size ||
        parsed.pins.some((pin) => !inputs.has(pin.key))
      ) {
        throw new Error("Definitions: invalid offline input set");
      }
      for (const pin of parsed.pins) {
        const input = inputs.get(pin.key);
        if (input && "repository" in input && !pin.commit) {
          throw new Error("Definitions: offline input has no commit");
        }
        if (
          (await definitionTreeHash(join(trees, pin.hash), signal)) !== pin.hash
        ) {
          throw new Error("Definitions: corrupt offline export");
        }
        pins.push(pin);
      }
    } else {
      staging = await mkdtemp(join(root, "staging-"));
      for (const [key, input] of inputs) {
        signal.throwIfAborted();
        const destination = join(staging, key);
        await mkdir(destination);
        let commit: string | undefined;
        if ("repository" in input) {
          const result = await input.reader.read(
            { repository: input.repository, ref: input.ref },
            destination,
            signal,
          );
          commit = z
            .string()
            .regex(/^[a-f0-9]{40,64}$/)
            .parse(result.commit);
        } else {
          const before = await definitionTreeHash(input.directory, signal);
          await copyDirectory(input.directory, destination, signal);
          if (
            (await definitionTreeHash(input.directory, signal)) !== before ||
            (await definitionTreeHash(destination, signal)) !== before
          ) {
            throw new Error("Definitions: local input changed during capture");
          }
        }
        signal.throwIfAborted();
        const hash = await definitionTreeHash(destination, signal);
        const published = join(trees, hash);
        if (await exists(published)) {
          if ((await definitionTreeHash(published, signal)) !== hash) {
            await rename(published, `${published}.corrupt-${randomUUID()}`);
          }
        }
        if (!(await exists(published))) {
          await sealTree(destination);
          signal.throwIfAborted();
          await rename(destination, published);
          await syncDirectory(trees);
        }
        pins.push({
          key,
          hash,
          ...(commit ? { commit } : {}),
        });
      }
    }
    const sources: DefinitionSources = { skills: [] };
    for (const { source: item, key } of repositories) {
      const pin = pins.find((candidate) => candidate.key === key);
      if (!pin?.commit) {
        throw new Error("Definitions: repository input missing");
      }
      const exportRoot = join(trees, pin.hash);
      const commit = pin.commit;
      function origin(path: string, contentHash: string): DefinitionOrigin {
        return {
          kind: "repository",
          provider: item.provider,
          repository: item.repository,
          ref: item.ref,
          commit,
          path: relative(exportRoot, path).split(sep).join("/"),
          contentHash,
        };
      }
      sources.skills.push(
        sourceView({
          alias: item.repository,
          root: join(exportRoot, item.path),
          recursive: true,
          origin,
        }),
      );
    }
    for (const item of options.directories) {
      const pin = pins.find(
        (candidate) =>
          candidate.key ===
          digest(JSON.stringify({ directory: item.directory })),
      );
      if (!pin) {
        throw new Error("Definitions: directory input missing");
      }
      const exportRoot = join(trees, pin.hash);
      function origin(path: string, contentHash: string): DefinitionOrigin {
        return {
          kind: "directory",
          source: item.alias,
          path: join(item.directory, relative(exportRoot, path)),
          contentHash,
        };
      }
      sources.skills.push(
        sourceView({
          alias: item.alias,
          root: exportRoot,
          recursive: false,
          origin,
        }),
      );
    }
    const result = await consume(sources);
    signal.throwIfAborted();
    if (options.mode !== "offline") {
      const temporary = join(staging ?? root, `load-${randomUUID()}.json`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({
            version: RECORD_VERSION,
            recipe,
            pins,
          }),
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      signal.throwIfAborted();
      await rename(temporary, record);
      await syncDirectory(records);
    }
    return result;
  } finally {
    try {
      if (staging) {
        await rm(staging, { recursive: true, force: true });
      }
    } finally {
      await release();
    }
  }
}
