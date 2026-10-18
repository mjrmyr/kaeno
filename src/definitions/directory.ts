import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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
export async function readManifestFile(
  path: string,
): Promise<string | undefined> {
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
  const bytes = await readFile(path);
  if (bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error(`${path}: manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
