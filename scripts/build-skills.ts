// Build-time only. Resolve refs fresh, then use the pinned skills CLI on sanitized local sources.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.ts";
import {
  copySkillTree, inspectSkill, INSTALLER, skillFiles, skillMetadata, skillRelativeRoot, splitSkillId,
  type RepositorySpec, type SkillManifest,
} from "../src/skills.ts";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return (await exec("git", args, { cwd, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}

export async function buildSkillBundle(repositories: readonly RepositorySpec[], selections: Readonly<Record<string, readonly string[]>>, destination: string) {
  destination = resolve(destination);
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), ".kaeno-skills-"));
  const output = join(staging, "bundle");
  await mkdir(output);
  const manifest: SkillManifest = { schema: 1, installer: INSTALLER, repositories: [], entries: [] };
  try {
    for (const [index, repository] of repositories.entries()) {
      const checkout = join(staging, `source-${index}`);
      await mkdir(checkout);
      await git(checkout, ["init", "-q"]);
      await git(checkout, ["remote", "add", "origin", `https://github.com/${repository.id}.git`]);
      await git(checkout, ["fetch", "-q", "--depth=1", "origin", repository.ref ?? "HEAD"]);
      await git(checkout, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
      const commit = await git(checkout, ["rev-parse", "HEAD"]);
      manifest.repositories.push({ ...repository, commit });
      const selected = [...new Set(Object.values(selections).flat())].filter(id => splitSkillId(id).repository === repository.id);
      if (!selected.length) continue;
      // The CLI dereferences symlinks and may hide duplicate names. Inspect originals FIRST.
      const sources = new Map<string, string>();
      for (const file of await skillFiles(checkout, true)) {
        if (file.path.split("/").pop() !== "SKILL.md") continue;
        const metadata = skillMetadata(file.bytes.toString("utf8"), join(checkout, file.path));
        if (!selected.some(id => splitSkillId(id).name === metadata.name)) continue;
        if (sources.has(metadata.name)) throw new Error(`Skills: ambiguous ${repository.id}:${metadata.name}`);
        sources.set(metadata.name, dirname(join(checkout, file.path)));
      }
      const sanitized = join(staging, `sanitized-${index}`);
      const installation = join(staging, `installed-${index}`);
      const home = join(staging, `home-${index}`);
      await mkdir(installation); await mkdir(home);
      const expected = new Map<string, string>();
      for (const id of selected) {
        const { name } = splitSkillId(id);
        const source = sources.get(name);
        if (!source) throw new Error(`Skills: missing ${id} at ${commit}`);
        // A sanitized collection contains only explicit skill trees, not repository discovery manifests.
        // Reject nested discovery controls rather than silently dropping any accepted skill assets.
        const files = await skillFiles(source, true);
        if (files.some(f => f.path !== "SKILL.md" && f.path.split("/").pop() === "SKILL.md"))
          throw new Error(`Skills: ${id}: nested skill trees are not supported (would expose unassigned skills)`);
        if (files.some(f => f.path.split("/").some(p => [".claude-plugin", ".cursor-plugin", ".plugin"].includes(p))))
          throw new Error(`Skills: ${id}: nested plugin discovery controls are not supported`);
        expected.set(id, (await inspectSkill(source)).treeHash);
        await copySkillTree(source, join(sanitized, "skills", name));
      }
      await exec("npx", ["--yes", INSTALLER, "add", sanitized, "--skill", ...selected.map(id => splitSkillId(id).name), "--agent", "pi", "--copy", "--yes"], {
        cwd: installation, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: home, DISABLE_TELEMETRY: "1", npm_config_userconfig: "/dev/null", npm_config_cache: join(homedir(), ".npm") },
      });
      const installedRoot = join(installation, ".agents", "skills");
      const installed = new Map<string, string>();
      for (const directory of await readdir(installedRoot)) {
        const root = join(installedRoot, directory);
        const inspected = await inspectSkill(root);
        if (installed.has(inspected.metadata.name)) throw new Error(`Skills: ambiguous installed ${inspected.metadata.name}`);
        installed.set(inspected.metadata.name, root);
      }
      for (const id of selected) {
        const root = installed.get(splitSkillId(id).name);
        if (!root) throw new Error(`Skills: installer omitted ${id}`);
        const target = join(output, skillRelativeRoot(id));
        await copySkillTree(root, target);
        const inspected = await inspectSkill(target);
        if (inspected.treeHash !== expected.get(id)) throw new Error(`Skills: installer changed/omitted files from ${id}`);
        manifest.entries.push({ id, treeHash: inspected.treeHash });
      }
    }
    await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    // Caller uses a unique build context. A failed build never replaces a previous completed bundle.
    await rm(destination, { recursive: true, force: true });
    await rename(output, destination);
    return manifest;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [configPath, destination] = process.argv.slice(2);
  if (!configPath || !destination) throw new Error("Usage: node scripts/build-skills.ts <config snapshot> <bundle output>");
  const config = await loadConfig(configPath);
  const manifest = await buildSkillBundle(config.skillRepositories, Object.fromEntries(Object.values(config.templates).map(t => [t.name, t.skills])), destination);
  console.log(`skills: ${manifest.entries.length} selected from ${manifest.repositories.length} repositories`);
  for (const repository of manifest.repositories) console.log(`  ${repository.id}${repository.ref ? `:${repository.ref}` : " (default branch)"} → ${repository.commit}`);
}
