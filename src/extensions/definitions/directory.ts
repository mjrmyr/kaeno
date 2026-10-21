import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Diagnostic } from "./manifest.ts";
import type { DefinitionOrigin } from "./origin.ts";

/** One `<root>/<directory>/<manifest>` package found by a source. */
export interface DefinitionPackage {
  /** Stable source alias; the first part of definition IDs such as `local:reviewer`. */
  readonly source: string;
  /** Package directory, for diagnostics and package-relative files. */
  readonly directory: string;
  /** Raw manifest text, parsed by the consuming extension. */
  readonly manifest: string;
  readonly origin?: DefinitionOrigin;
}

export interface DefinitionSource {
  readonly alias: string;
  snapshot(manifestName: string): Promise<{
    packages: readonly DefinitionPackage[];
    diagnostics: readonly Diagnostic[];
  }>;
}

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PACKAGES = 512;

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Read the manifest file of one package without following links. Returns undefined when the
 * file does not exist.
 */
async function readManifestBytes(path: string): Promise<Buffer | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (missing(error)) {
      return undefined;
    }
    throw error;
  }
  if (!info.isFile()) {
    throw new Error(`${path}: must be a regular file, not a link`);
  }
  if (info.size > MAX_MANIFEST_BYTES) {
    throw new Error(`${path}: manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== info.dev ||
      before.ino !== info.ino ||
      before.size !== info.size ||
      before.mtimeMs !== info.mtimeMs ||
      before.ctimeMs !== info.ctimeMs ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.length !== before.size
    ) {
      throw new Error(`${path}: manifest changed during capture`);
    }
    if (bytes.length > MAX_MANIFEST_BYTES) {
      throw new Error(`${path}: manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Decode a captured manifest, preserving the existing UTF-8/BOM semantics. */
export async function readManifestFile(
  path: string,
): Promise<string | undefined> {
  const bytes = await readManifestBytes(path);
  return bytes === undefined
    ? undefined
    : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Packages in the immediate subdirectories of `root`, each with its own manifest. A missing root
 * is an empty source. Links, oversized manifests and unreadable entries become diagnostics.
 * Local and external directories use the same source; only their alias differs.
 */
export function directorySource(alias: string, root: string): DefinitionSource {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias)) {
    throw new Error(`Invalid definition source alias "${alias}"`);
  }
  return {
    alias,
    async snapshot(manifestName) {
      if (
        !/^[A-Za-z0-9._-]+$/.test(manifestName) ||
        manifestName === "." ||
        manifestName === ".."
      ) {
        throw new Error("Manifest must be a filename, not a path");
      }
      const packages: DefinitionPackage[] = [];
      const diagnostics: Diagnostic[] = [];
      let names: string[];
      try {
        names = (await readdir(root)).sort();
      } catch (error) {
        if (missing(error)) {
          return { packages, diagnostics };
        }
        throw error;
      }
      for (const name of names) {
        const directory = join(root, name);
        if (name.startsWith(".")) {
          continue;
        }
        try {
          const info = await lstat(directory);
          if (info.isSymbolicLink()) {
            throw new Error(`${directory}: linked packages are not supported`);
          }
          if (!info.isDirectory()) {
            continue;
          }
          const manifest = await readManifestFile(
            join(directory, manifestName),
          );
          if (manifest === undefined) {
            continue;
          }
          if (packages.length >= MAX_PACKAGES) {
            throw new Error(`${root}: more than ${MAX_PACKAGES} packages`);
          }
          packages.push({ source: alias, directory, manifest });
        } catch (error) {
          diagnostics.push({
            location: directory,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { packages, diagnostics };
    },
  };
}

/** A flat agent record, not a skill directory package. */
export interface AgentDocument {
  readonly source: string;
  readonly manifestPath: string;
  readonly manifest: string;
  readonly origin?: DefinitionOrigin;
}
export interface AgentSource {
  readonly alias: string;
  snapshot(): Promise<{
    documents: readonly AgentDocument[];
    diagnostics: readonly Diagnostic[];
  }>;
}

/** Immediate flat records only. Legacy packages are diagnosed, never loaded. */
export function agentSource(
  alias: string,
  root: string,
  origin?: (path: string, contentHash: string) => DefinitionOrigin,
): AgentSource {
  return {
    alias,
    async snapshot() {
      const documents: AgentDocument[] = [];
      const diagnostics: Diagnostic[] = [];
      let names: string[];
      try {
        if (
          !(await lstat(root)).isDirectory() ||
          (await realpath(root)) !== resolve(root)
        ) {
          throw new Error(
            `${root}: agent root must be a directory without links`,
          );
        }
        names = (await readdir(root)).sort();
      } catch (error) {
        if (!missing(error)) {
          throw error;
        }
        return {
          documents,
          diagnostics: [{ location: root, message: "Agent root is missing" }],
        };
      }
      let candidates = 0;
      for (const name of names) {
        if (name.startsWith(".")) {
          continue;
        }
        const path = join(root, name);
        const info = await lstat(path);
        const markdown = /\.md$/i.test(name);
        if (markdown && ++candidates > MAX_PACKAGES) {
          diagnostics.push({
            location: root,
            message: `More than ${MAX_PACKAGES} agent candidates`,
          });
          break;
        }
        try {
          if (
            info.isSymbolicLink() ||
            (!info.isDirectory() && !info.isFile())
          ) {
            throw new Error(
              `${path}: linked or special agent entries are not supported`,
            );
          }
          if (info.isDirectory()) {
            if (markdown) {
              throw new Error(
                `${path}: agent candidate must be a regular file`,
              );
            }
            if (
              (await readManifestFile(join(path, "AGENT.md"))) !== undefined
            ) {
              throw new Error(
                `${path}/AGENT.md: legacy agent package; move to ${join(root, name + ".md")} and match the declared name`,
              );
            }
          } else if (markdown) {
            if (!name.endsWith(".md")) {
              throw new Error(`${path}: agent filename must use lowercase .md`);
            }
            const bytes = await readManifestBytes(path);
            if (bytes === undefined) {
              throw new Error(`${path}: agent disappeared during capture`);
            }
            documents.push({
              source: alias,
              manifestPath: path,
              manifest: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              ...(origin
                ? {
                    origin: origin(
                      path,
                      createHash("sha256").update(bytes).digest("hex"),
                    ),
                  }
                : {}),
            });
          }
        } catch (error) {
          diagnostics.push({
            location: path,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        if (diagnostics.length >= MAX_PACKAGES) {
          break;
        }
      }
      return { documents, diagnostics };
    },
  };
}
