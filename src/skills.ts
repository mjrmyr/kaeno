// Skill domain and artifact boundary. Runtime preparation and init share these invariants; no harness/Kubernetes imports.
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { parse as parseYaml } from "yaml";

export type RepositorySpec = { id: string; ref?: string };
export type BoundSkill = {
  id: string; description: string; disableModelInvocation: boolean; repositoryCommit: string;
  treeHash: string; sandboxRoot: string; documents: Record<string, string>;
};
export type SkillBinding = BoundSkill[];
export type SandboxImages = { execution: string; /** Replay-only for pre-runtime-cache children. Never set on new children. */ skillSource?: string };
export type SkillCopySelection = { id: string; treeHash: string }[];
export type SkillManifest = {
  schema: 1; installer: "skills@1.7.2";
  repositories: (RepositorySpec & { commit: string })[];
  entries: { id: string; treeHash: string }[];
};
export type SkillCatalog = { bind(ids: readonly string[]): SkillBinding };
export const SKILL_ROOT = "/workspace/.agents/skills";
export const INSTALLER = "skills@1.7.2";
const MAX_TREE_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_DOCUMENTS_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 4096;
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function fail(message: string): never { throw new Error(`Skills: ${message}`); }
const repoId = (raw: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(raw) || raw.endsWith(".git") || raw.endsWith(".")) fail(`invalid repository ${raw}`);
  return raw.toLowerCase();
};

export function parseSkillRepositories(raw: unknown): RepositorySpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail("skillRepositories must be an array");
  const seen = new Set<string>();
  return raw.map(value => {
    if (typeof value !== "string") fail("repository declarations must be strings");
    const colon = value.indexOf(":");
    const id = repoId(colon < 0 ? value : value.slice(0, colon));
    const ref = colon < 0 ? undefined : value.slice(colon + 1);
    // Git ref syntax, not a shell command. Accept tags, branches with slashes, and commit IDs.
    if (ref !== undefined && (!ref || ref.startsWith("-") || ref === "@" || /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(ref) || ref.includes("..") || ref.includes("@{") || ref.split("/").some(p => !p || p.startsWith(".") || p.endsWith(".") || p.endsWith(".lock")))) fail(`invalid ref for ${id}`);
    if (seen.has(id)) fail(`duplicate repository ${id}`);
    seen.add(id);
    return { id, ...(ref === undefined ? {} : { ref }) };
  });
}

export function splitSkillId(raw: string): { repository: string; name: string; id: string } {
  const at = raw.indexOf(":");
  const repository = repoId(raw.slice(0, at));
  const name = raw.slice(at + 1);
  if (at < 0 || name.length > 64 || !NAME.test(name)) fail(`invalid skill ID ${raw}; expected owner/repo:skill-name`);
  return { repository, name, id: `${repository}:${name}` };
}

/** Config selectors may be wildcards; persisted skill IDs must still pass splitSkillId. */
export function splitSkillSelector(raw: string): { repository: string; name: string; id: string } {
  if (!raw.endsWith(":*")) return splitSkillId(raw);
  const repository = repoId(raw.slice(0, -2));
  return { repository, name: "*", id: `${repository}:*` };
}

/** Expand against discovered concrete IDs, preserving selector order and sorting wildcard matches. */
export function expandSkillSelection(selectors: readonly string[], available: readonly string[]): string[] {
  const selected = new Set<string>();
  for (const selector of selectors) {
    const { repository, name, id } = splitSkillSelector(selector);
    const matches = name === "*" ? available.filter(id => id.startsWith(`${repository}:`)).sort() : [id];
    if (!matches.length) fail(`${id}: no skills found in repository`);
    for (const match of matches) selected.add(match);
  }
  return [...selected];
}

export function parseSkillSelection(raw: unknown, repositories: readonly RepositorySpec[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 256 || raw.some(v => typeof v !== "string")) fail("template skills must be an array of at most 256 qualified selectors");
  const declared = new Set(repositories.map(r => r.id));
  const seen = new Set<string>();
  return raw.map(value => {
    if (typeof value !== "string") fail("skill IDs must be strings");
    const { id, repository } = splitSkillSelector(value);
    if (!declared.has(repository)) fail(`undeclared repository ${repository} for ${id}`);
    if (seen.has(id)) fail(`duplicate selection ${id}`);
    seen.add(id);
    return id;
  });
}

export const skillRelativeRoot = (id: string): string => {
  const s = splitSkillId(id);
  return `${s.repository}/${s.name}`;
};

export function skillMetadata(text: string, location: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!frontmatter) fail(`${location}: missing YAML frontmatter`);
  const m = parseYaml(frontmatter[1]!, { maxAliasCount: 0 });
  if (!m || typeof m.name !== "string" || m.name.length > 64 || !NAME.test(m.name) || typeof m.description !== "string" || !m.description.trim() || m.description.length > 1024) fail(`${location}: invalid skill name/description`);
  if (m["disable-model-invocation"] !== undefined && typeof m["disable-model-invocation"] !== "boolean") fail(`${location}: disable-model-invocation must be boolean`);
  return { name: m.name as string, description: m.description as string, disableModelInvocation: m["disable-model-invocation"] === true };
}

/** Walk without following links. Used BEFORE npx, which otherwise dereferences source symlinks. */
export async function skillFiles(root: string, skipGit = false): Promise<{ path: string; mode: number; bytes: Buffer }[]> {
  const files: { path: string; mode: number; bytes: Buffer }[] = [];
  let total = 0;
  async function walk(relative: string) {
    const path = join(root, relative);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) fail(`${path}: links and special files are not supported`);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (skipGit && name === ".git") continue;
        await walk(relative ? `${relative}/${name}` : name);
      }
    } else {
      total += info.size;
      if (total > MAX_TREE_BYTES || files.length >= MAX_FILES) fail(`${root}: skill tree exceeds size/file limit`);
      const bytes = await readFile(path);
      files.push({ path: relative, mode: info.mode & 0o777, bytes });
    }
  }
  await walk("");
  return files;
}

/** Content hash includes executable bits; timestamps and installer lockfiles are not inputs. */
export async function inspectSkill(root: string) {
  const files = await skillFiles(root, true); // Git checkout metadata is not a skill asset.
  const hash = createHash("sha256");
  const documents: Record<string, string> = {};
  let textBytes = 0;
  for (const file of files) {
    hash.update(JSON.stringify([file.path, file.mode & 0o111, file.bytes.length]) + "\n");
    hash.update(file.bytes);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); } catch { continue; }
    if (text.includes("\0")) continue;
    textBytes += file.bytes.length;
    if (file.bytes.length > MAX_DOCUMENT_BYTES || textBytes > MAX_DOCUMENTS_BYTES) fail(`${root}/${file.path}: skill text exceeds document limit`);
    Object.defineProperty(documents, file.path, { value: text, enumerable: true, writable: true, configurable: true });
  }
  if (!Object.hasOwn(documents, "SKILL.md")) fail(`${root}: missing text SKILL.md`);
  return { treeHash: hash.digest("hex"), documents, metadata: skillMetadata(documents["SKILL.md"]!, root) };
}

/** Copy only validated regular files, preserving safe permissions (never special permission bits). */
export async function copySkillTree(source: string, destination: string) {
  for (const file of await skillFiles(source, true)) {
    const target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, file.path), target);
    await chmod(target, file.mode);
  }
}

async function manifestAt(root: string): Promise<SkillManifest> {
  const m = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (m?.schema !== 1 || m.installer !== INSTALLER || !Array.isArray(m.repositories) || !Array.isArray(m.entries)) fail("unsupported skill manifest");
  const repositories = parseSkillRepositories(m.repositories.map((r: any) => `${r.id}${r.ref === undefined ? "" : `:${r.ref}`}`));
  m.repositories.forEach((r: any, i: number) => { if (r.id !== repositories[i]!.id || !COMMIT.test(r.commit)) fail("invalid repository provenance"); });
  const declared = new Set(repositories.map(r => r.id)), seen = new Set<string>();
  m.entries.forEach((e: any) => {
    const { id, repository } = splitSkillId(e.id); // Never accept wildcard selectors in artifacts.
    if (e.id !== id || !declared.has(repository) || seen.has(id) || !HASH.test(e.treeHash)) fail("invalid skill manifest entry");
    seen.add(id);
  });
  return m as SkillManifest;
}

export async function openSkillCatalog(root: string, repositories: readonly RepositorySpec[], selections: Readonly<Record<string, readonly string[]>>): Promise<SkillCatalog> {
  const manifest = await manifestAt(root);
  for (const repo of repositories) {
    const bundled = manifest.repositories.find(r => r.id === repo.id);
    if (!bundled || bundled.ref !== repo.ref) fail(`${repo.id}: configured ref does not match the resolved catalogue`);
  }
  const entries = new Map<string, BoundSkill>();
  for (const entry of manifest.entries) {
    const inspected = await inspectSkill(join(root, skillRelativeRoot(entry.id)));
    if (inspected.treeHash !== entry.treeHash || inspected.metadata.name !== splitSkillId(entry.id).name) fail(`${entry.id}: bundle integrity mismatch`);
    const repo = manifest.repositories.find(r => r.id === splitSkillId(entry.id).repository)!;
    entries.set(entry.id, {
      id: entry.id, description: inspected.metadata.description, disableModelInvocation: inspected.metadata.disableModelInvocation,
      repositoryCommit: repo.commit, treeHash: entry.treeHash,
      sandboxRoot: `${SKILL_ROOT}/${skillRelativeRoot(entry.id)}`, documents: inspected.documents,
    });
  }
  const catalog: SkillCatalog = {
    bind: selectors => {
      const ids = expandSkillSelection(selectors, [...entries.keys()]);
      if (ids.length > 256) fail("too many skills in one agent binding");
      let bytes = 0;
      return ids.map(id => {
        const skill = entries.get(id);
        if (!skill) fail(`${id}: skill not present in the resolved catalogue`);
        bytes += Object.values(skill.documents).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
        if (bytes > 8 * 1024 * 1024) fail("agent skill documents exceed 8 MiB binding limit");
        return structuredClone(skill);
      });
    },
  };
  for (const ids of Object.values(selections)) catalog.bind(ids);
  return catalog;
}

export function skillPrompt(binding: readonly BoundSkill[]): string | undefined {
  const visible = binding.filter(s => !s.disableModelInvocation);
  if (!visible.length) return undefined;
  return "Use read_skill to load a skill's instructions when its description matches the task. " +
    "Resolve referenced files/scripts relative to the supplied skill directory; write scratch/output files in the writable workspace, not the read-only skill directory.\n" +
    visible.map(s => JSON.stringify({ skill: s.id, description: s.description, directory: s.sandboxRoot })).join("\n");
}

export function readSkillDocument(binding: readonly BoundSkill[], request: { skill: string; file?: string }) {
  const skill = binding.find(s => s.id === request.skill);
  if (!skill) fail(`skill not assigned: ${request.skill}`);
  const file = request.file ?? "SKILL.md";
  if (!file || file.includes("\\") || file.includes("\0") || posix.isAbsolute(file) || file.split("/").some(p => !p || p === "." || p === "..") || !Object.hasOwn(skill.documents, file)) fail(`${request.skill}: unavailable text document ${file}`);
  return { text: skill.documents[file]!, sandboxRoot: skill.sandboxRoot };
}

/** Validate image refs at startup; never accept tags for durable sandbox recreation. */
export function parseSandboxImages(raw: unknown): SandboxImages {
  const value = raw as any;
  if (typeof value?.execution !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value.execution)) fail("sandbox execution must be a digest-qualified image reference");
  return { execution: value.execution }; // New bindings deliberately cannot freeze an image-baked skill source.
}

/** Init-only, no network: immutable cache trees + frozen selection; main starts only after success. */
export async function materializeSkillSelection(cacheRoot: string, selection: SkillCopySelection, destination: string): Promise<void> {
  const seen = new Set<string>();
  for (const selected of selection) {
    const parsed = splitSkillId(selected.id);
    if (parsed.id !== selected.id || seen.has(selected.id) || !HASH.test(selected.treeHash)) fail("invalid/duplicate materialization selection");
    seen.add(selected.id);
  }
  // Dedicated output volume only. Never clear the task's workspace.
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(destination)) await rm(join(destination, name), { recursive: true, force: true });
  const staging = join(destination, ".staging");
  await mkdir(staging);
  for (const selected of selection) {
    const relative = skillRelativeRoot(selected.id);
    const source = join(cacheRoot, "trees", selected.treeHash), target = join(staging, relative);
    const inspected = await inspectSkill(source).catch(error => {
      fail(`${selected.id}: retained tree ${selected.treeHash} unavailable or invalid: ${error.message}`);
    });
    if (inspected.treeHash !== selected.treeHash || inspected.metadata.name !== splitSkillId(selected.id).name) fail(`${selected.id}: source integrity mismatch`);
    await copySkillTree(source, target);
    if ((await inspectSkill(target)).treeHash !== selected.treeHash) fail(`${selected.id}: copy integrity mismatch`);
  }
  for (const name of await readdir(staging)) await rename(join(staging, name), join(destination, name));
  await rm(staging, { recursive: true });
}
