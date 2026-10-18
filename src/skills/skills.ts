// Skill packages: `<root>/<directory>/SKILL.md` plus relative files. Inspection never follows links or
// executes anything; bound skills are immutable snapshots of the text documents at startup.
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  discoveryMetadata,
  parseManifest,
  type DefinitionOrigin,
  type DefinitionPackage,
  type Diagnostic,
} from "../definitions/index.ts";

/** One skill as assigned to a conversation. */
export interface BoundSkill {
  id: string;
  origin?: DefinitionOrigin;
  description: string;
  disableModelInvocation: boolean;
  /** Content hash of the complete tree, including binary files and executable bits. */
  treeHash: string;
  /** Text documents by package-relative path; `SKILL.md` is always present. */
  documents: Record<string, string>;
  /** Complete file bytes and executable bits, including non-text assets. */
  assets?: Record<string, { base64: string; executable: boolean }>;
}
export interface SkillMetadata {
  name: string;
  description: string;
  disableModelInvocation: boolean;
}
export interface InspectedSkill {
  treeHash: string;
  documents: Record<string, string>;
  assets: Record<string, { base64: string; executable: boolean }>;
  metadata: SkillMetadata;
}
export interface SkillSummary {
  id: string;
  description: string;
}

const MAX_TREE_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_DOCUMENTS_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 4096;
const MAX_BOUND_BYTES = 8 * 1024 * 1024;

function fail(message: string): never {
  throw new Error(`Skills: ${message}`);
}

export function skillMetadata(text: string, location: string): SkillMetadata {
  const manifest = parseManifest(text, location);
  const { name, description } = discoveryMetadata(manifest, location);
  const disabled = z
    .boolean()
    .optional()
    .safeParse(manifest.metadata["disable-model-invocation"]);
  if (!disabled.success) {
    fail(`${location}: "disable-model-invocation" must be a boolean`);
  }
  return { name, description, disableModelInvocation: disabled.data === true };
}

/** Walk without following links. */
export async function skillFiles(
  root: string,
): Promise<{ path: string; mode: number; bytes: Buffer }[]> {
  const files: { path: string; mode: number; bytes: Buffer }[] = [];
  let total = 0;
  async function walk(relative: string): Promise<void> {
    const path = join(root, relative);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      fail(`${path}: links and special files are not supported`);
    }
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (name === ".git") {
          continue;
        }
        await walk(relative ? `${relative}/${name}` : name);
      }
      return;
    }
    total += info.size;
    if (total > MAX_TREE_BYTES || files.length >= MAX_FILES) {
      fail(`${root}: skill tree exceeds size/file limit`);
    }
    files.push({
      path: relative,
      mode: info.mode & 0o777,
      bytes: await readFile(path),
    });
  }
  await walk("");
  return files;
}

/** Content hash includes executable bits; timestamps are not inputs. */
export async function inspectSkill(root: string): Promise<InspectedSkill> {
  const files = await skillFiles(root);
  const hash = createHash("sha256");
  const documents: Record<string, string> = {};
  const assets: Record<string, { base64: string; executable: boolean }> = {};
  let textBytes = 0;
  for (const file of files) {
    hash.update(
      JSON.stringify([file.path, file.mode & 0o111, file.bytes.length]) + "\n",
    );
    hash.update(file.bytes);
    Object.defineProperty(assets, file.path, {
      value: {
        base64: file.bytes.toString("base64"),
        executable: (file.mode & 0o111) !== 0,
      },
      enumerable: true,
    });
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    } catch {
      continue;
    }
    if (text.includes("\0")) {
      continue;
    }
    textBytes += file.bytes.length;
    if (
      file.bytes.length > MAX_DOCUMENT_BYTES ||
      textBytes > MAX_DOCUMENTS_BYTES
    ) {
      fail(`${root}/${file.path}: skill text exceeds document limit`);
    }
    Object.defineProperty(documents, file.path, {
      value: text,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (!Object.hasOwn(documents, "SKILL.md")) {
    fail(`${root}: missing text SKILL.md`);
  }
  return {
    treeHash: hash.digest("hex"),
    documents,
    assets,
    metadata: skillMetadata(documents["SKILL.md"], `${root}/SKILL.md`),
  };
}

/** One bounded union of snapshots; identical IDs must describe identical content and provenance. */
export function snapshotSkills(skills: readonly BoundSkill[]): BoundSkill[] {
  const entries = new Map<string, BoundSkill>();
  for (const skill of skills) {
    const existing = entries.get(skill.id);
    if (existing) {
      if (!isDeepStrictEqual(existing, skill)) {
        fail(`conflicting skill snapshots for ${skill.id}`);
      }
      continue;
    }
    entries.set(skill.id, skill);
  }
  const snapshots = [...entries.values()];
  if (
    Buffer.byteLength(JSON.stringify({ skills: snapshots })) > MAX_BOUND_BYTES
  ) {
    fail("assigned skill snapshots exceed 8 MiB");
  }
  return structuredClone(snapshots);
}

/** Skills loaded at startup; immutable for the process lifetime. */
export class SkillCatalog {
  private readonly entries: ReadonlyMap<string, BoundSkill>;
  private readonly invalidSources: ReadonlySet<string>;
  constructor(
    skills: readonly BoundSkill[],
    invalidSources: readonly string[] = [],
  ) {
    const entries = new Map<string, BoundSkill>();
    for (const skill of skills) {
      if (entries.has(skill.id)) {
        fail(`duplicate skill ${skill.id}`);
      }
      entries.set(skill.id, structuredClone(skill));
    }
    this.entries = entries;
    this.invalidSources = new Set(invalidSources);
  }
  /** Combine independently loaded catalogs without rereading mutable source files. */
  merge(other: SkillCatalog): SkillCatalog {
    return new SkillCatalog(
      [...this.entries.values(), ...other.entries.values()],
      [...this.invalidSources, ...other.invalidSources],
    );
  }
  list(): SkillSummary[] {
    return [...this.entries.values()].map(({ id, description }) => ({
      id,
      description,
    }));
  }
  /** Resolve `source:name`, or a bare name when exactly one source has it. */
  resolve(reference: string): string {
    if (this.entries.has(reference)) {
      return reference;
    }
    const matches = [...this.entries.keys()].filter((id) =>
      id.endsWith(`:${reference}`),
    );
    if (matches.length === 1) {
      return matches[0];
    }
    fail(
      matches.length > 1
        ? `ambiguous skill "${reference}": use one of ${matches.join(", ")}`
        : `unknown skill "${reference}"`,
    );
  }
  /** Expand only `source:*`; sort its members, preserving selector order and deduplicating overlaps. */
  bind(references: readonly string[]): BoundSkill[] {
    const ids = new Set<string>();
    for (const reference of references) {
      if (!reference.includes("*")) {
        ids.add(this.resolve(reference));
        continue;
      }
      const wildcard = /^([^:*]+):\*$/.exec(reference);
      if (!wildcard) {
        fail(`invalid skill wildcard "${reference}": expected source:*`);
      }
      const source = wildcard[1];
      if (this.invalidSources.has(source)) {
        fail(
          `cannot expand "${reference}": source ${source} has invalid skill packages`,
        );
      }
      const matches = [...this.entries.keys()]
        .filter((id) => id.startsWith(`${source}:`))
        .sort();
      if (matches.length === 0) {
        fail(`empty skill wildcard "${reference}"`);
      }
      for (const id of matches) {
        ids.add(id);
      }
    }
    return snapshotSkills(
      [...ids].map((id) => {
        const skill = this.entries.get(id);
        if (!skill) {
          fail(`unknown skill "${id}"`);
        }
        return skill;
      }),
    );
  }
}

/** Inspect packages from definition sources. Invalid packages become diagnostics, not skips. */
export async function loadSkills(
  packages: readonly DefinitionPackage[],
): Promise<{ catalog: SkillCatalog; diagnostics: Diagnostic[] }> {
  const skills: BoundSkill[] = [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const invalidSources = new Set<string>();
  for (const definition of packages) {
    try {
      const inspected = await inspectSkill(definition.directory);
      if (inspected.documents["SKILL.md"] !== definition.manifest) {
        fail(
          `${definition.directory}: manifest changed while the source snapshot was loading`,
        );
      }
      const id = `${definition.source}:${inspected.metadata.name}`;
      if (seen.has(id)) {
        duplicates.add(id);
        fail(
          `duplicate skill name "${inspected.metadata.name}" in source ${definition.source}`,
        );
      }
      seen.add(id);
      skills.push({
        id,
        description: inspected.metadata.description,
        disableModelInvocation: inspected.metadata.disableModelInvocation,
        treeHash: inspected.treeHash,
        documents: inspected.documents,
        assets: inspected.assets,
        ...(definition.origin
          ? { origin: structuredClone(definition.origin) }
          : {}),
      });
    } catch (error) {
      invalidSources.add(definition.source);
      diagnostics.push({
        location: definition.directory,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    catalog: new SkillCatalog(
      skills.filter((skill) => !duplicates.has(skill.id)),
      [...invalidSources],
    ),
    diagnostics,
  };
}

/** Only automatically discoverable, assigned metadata; never instruction bodies or assets. */
export function listSkills(binding: readonly BoundSkill[]): SkillSummary[] {
  return binding
    .filter((skill) => !skill.disableModelInvocation)
    .map(({ id, description }) => ({ id, description }));
}

export function skillPrompt(
  binding: readonly BoundSkill[],
  tools: readonly string[],
): string | undefined {
  const instructions: string[] = [];
  if (tools.includes("list_skills")) {
    instructions.push(
      "Use list_skills to discover skills assigned to you when relevant to the task. An empty list means no skills are available for automatic use. Skills are guidance; they grant no tools or access.",
    );
  }
  if (tools.includes("read_skill")) {
    instructions.push(
      "Use read_skill to load a discovered skill's instructions, and read_skill with a file to load documents it references.",
    );
    if (!tools.includes("list_skills")) {
      instructions.push(
        ...listSkills(binding).map((skill) => JSON.stringify(skill)),
      );
    }
  } else {
    instructions.push(
      ...binding
        .filter((skill) => !skill.disableModelInvocation)
        .map(
          (skill) =>
            `Assigned skill ${skill.id} (guidance only; grants no tools or access):\n${skill.documents["SKILL.md"]}`,
        ),
    );
  }
  return instructions.join("\n\n") || undefined;
}

export function readSkillDocument(
  binding: readonly BoundSkill[],
  request: { skill: string; file?: string },
): string {
  const skill =
    binding.find((candidate) => candidate.id === request.skill) ??
    (() => {
      const matches = binding.filter((candidate) =>
        candidate.id.endsWith(`:${request.skill}`),
      );
      return matches.length === 1 ? matches[0] : undefined;
    })();
  if (!skill) {
    fail(`skill not assigned: ${request.skill}`);
  }
  const file = request.file ?? "SKILL.md";
  if (
    !file ||
    file.includes("\\") ||
    file.includes("\0") ||
    posix.isAbsolute(file) ||
    file.split("/").some((part) => !part || part === "." || part === "..") ||
    (!Object.hasOwn(skill.documents, file) &&
      !Object.hasOwn(skill.assets ?? {}, file))
  ) {
    fail(`${request.skill}: unavailable text document ${file}`);
  }
  if (Object.hasOwn(skill.documents, file)) {
    return skill.documents[file];
  }
  const asset = skill.assets?.[file];
  if (!asset) {
    fail(`${request.skill}: unavailable asset ${file}`);
  }
  return `Binary skill asset ${file} (base64; executable: ${asset.executable}):\n${asset.base64}`;
}
