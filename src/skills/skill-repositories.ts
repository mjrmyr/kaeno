// Runtime preparation: fresh Git resolution + pinned installer, then immutable hash-addressed cache publication.
// One writer (kaeno's Recreate Deployment); init containers are readers. Completed trees are never garbage-collected.
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  copySkillTree,
  expandSkillSelection,
  inspectSkill,
  INSTALLER,
  openSkillCatalog,
  skillFiles,
  skillMetadata,
  skillRelativeRoot,
  splitSkillId,
  splitSkillSelector,
  type RepositorySpec,
  type SkillCatalog,
  type SkillManifest,
} from "./skills.ts";
const exec = promisify(execFile);
export interface SkillPreparation {
  repositories: readonly RepositorySpec[];
  selections: Readonly<Record<string, readonly string[]>>;
  cacheRoot: string;
}
async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (
      process.platform !== "darwin" ||
      !(error instanceof Error && "code" in error && error.code === "EINVAL")
    ) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}
async function syncTree(root: string) {
  const directories = new Set([root]);
  for (const file of await skillFiles(root)) {
    const path = join(root, file.path);
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let dir = dirname(path); dir !== root; dir = dirname(dir)) {
      directories.add(dir);
    }
  }
  for (const dir of [...directories].sort(
    (left, right) => right.length - left.length,
  )) {
    await syncDirectory(dir);
  }
}
export async function prepareSkills({
  repositories,
  selections,
  cacheRoot,
}: SkillPreparation): Promise<SkillCatalog> {
  cacheRoot = resolve(cacheRoot);
  await mkdir(join(cacheRoot, "trees"), { recursive: true });
  await syncDirectory(cacheRoot);
  // Only abandoned private staging is removable; never remove published trees referenced by old tasks.
  for (const name of await readdir(cacheRoot)) {
    if (name.startsWith(".kaeno-skills-")) {
      await rm(join(cacheRoot, name), { recursive: true, force: true });
    }
  }
  const staging = await mkdtemp(join(cacheRoot, ".kaeno-skills-"));
  const gitHome = join(staging, "git-home");
  await mkdir(gitHome);
  // Public sources only: no inherited auth headers, askpass, credential helpers or global/system Git config.
  const gitEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: gitHome,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = async (cwd: string, args: string[]) =>
    (
      await exec("git", args, {
        cwd,
        env: gitEnv,
        timeout: 120000,
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout.trim();
  const output = join(staging, "bundle");
  await mkdir(output);
  const manifest: SkillManifest = {
    schema: 1,
    installer: INSTALLER,
    repositories: [],
    entries: [],
  };
  try {
    for (const [index, repository] of repositories.entries()) {
      const checkout = join(staging, `source-${index}`);
      await mkdir(checkout);
      await git(checkout, ["init", "-q"]);
      await git(checkout, [
        "remote",
        "add",
        "origin",
        `https://github.com/${repository.id}.git`,
      ]);
      await git(checkout, [
        "fetch",
        "-q",
        "--depth=1",
        "origin",
        repository.ref ?? "HEAD",
      ]);
      await git(checkout, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
      const commit = await git(checkout, ["rev-parse", "HEAD"]);
      manifest.repositories.push({ ...repository, commit });
      const selectors = [...new Set(Object.values(selections).flat())].filter(
        (id) => splitSkillSelector(id).repository === repository.id,
      );
      if (!selectors.length) {
        continue;
      }
      const all = selectors.includes(`${repository.id}:*`);
      const names = new Set(selectors.map((id) => splitSkillSelector(id).name));
      // The CLI dereferences symlinks and may hide duplicate names. Inspect originals FIRST.
      const sources = new Map<string, string>();
      for (const file of await skillFiles(checkout, true)) {
        if (file.path.split("/").pop() !== "SKILL.md") {
          continue;
        }
        const metadata = skillMetadata(
          file.bytes.toString("utf8"),
          join(checkout, file.path),
        );
        if (!all && !names.has(metadata.name)) {
          continue;
        }
        if (sources.has(metadata.name)) {
          throw new Error(
            `Skills: ambiguous ${repository.id}:${metadata.name}`,
          );
        }
        sources.set(metadata.name, dirname(join(checkout, file.path)));
      }
      const selected = expandSkillSelection(
        selectors,
        [...sources.keys()].map((name) => `${repository.id}:${name}`),
      );
      const sanitized = join(staging, `sanitized-${index}`);
      const installation = join(staging, `installed-${index}`);
      const home = join(staging, `home-${index}`);
      await mkdir(installation);
      await mkdir(home);
      const expected = new Map<string, string>();
      for (const id of selected) {
        const { name } = splitSkillId(id);
        const source = sources.get(name);
        if (!source) {
          throw new Error(`Skills: missing ${id} at ${commit}`);
        }
        // A sanitized collection contains only explicit skill trees, not repository discovery manifests.
        // Reject nested discovery controls rather than silently dropping any accepted skill assets.
        const files = await skillFiles(source, true);
        if (
          files.some(
            (file) =>
              file.path !== "SKILL.md" &&
              file.path.split("/").pop() === "SKILL.md",
          )
        ) {
          throw new Error(
            `Skills: ${id}: nested skill trees are not supported (would expose unassigned skills)`,
          );
        }
        if (
          files.some((file) =>
            file.path
              .split("/")
              .some((path) =>
                [".claude-plugin", ".cursor-plugin", ".plugin"].includes(path),
              ),
          )
        ) {
          throw new Error(
            `Skills: ${id}: nested plugin discovery controls are not supported`,
          );
        }
        expected.set(id, (await inspectSkill(source)).treeHash);
        await copySkillTree(source, join(sanitized, "skills", name));
      }
      await exec(
        "npx",
        [
          "--yes",
          INSTALLER,
          "add",
          sanitized,
          "--skill",
          ...selected.map((id) => splitSkillId(id).name),
          "--agent",
          "pi",
          "--copy",
          "--yes",
        ],
        {
          cwd: installation,
          timeout: 180000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            DISABLE_TELEMETRY: "1",
            npm_config_userconfig: "/dev/null",
            npm_config_cache: join(cacheRoot, "npm"),
          },
        },
      );
      const installedRoot = join(installation, ".agents", "skills");
      const installed = new Map<string, string>();
      for (const directory of await readdir(installedRoot)) {
        const root = join(installedRoot, directory);
        const inspected = await inspectSkill(root);
        if (installed.has(inspected.metadata.name)) {
          throw new Error(
            `Skills: ambiguous installed ${inspected.metadata.name}`,
          );
        }
        installed.set(inspected.metadata.name, root);
      }
      for (const id of selected) {
        const root = installed.get(splitSkillId(id).name);
        if (!root) {
          throw new Error(`Skills: installer omitted ${id}`);
        }
        const target = join(output, skillRelativeRoot(id));
        await copySkillTree(root, target);
        const inspected = await inspectSkill(target);
        if (inspected.treeHash !== expected.get(id)) {
          throw new Error(`Skills: installer changed/omitted files from ${id}`);
        }
        manifest.entries.push({ id, treeHash: inspected.treeHash });
      }
    }
    await writeFile(
      join(output, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    const catalog = await openSkillCatalog(output, repositories, selections);
    for (const entry of manifest.entries) {
      const target = join(cacheRoot, "trees", entry.treeHash);
      const exists = await lstat(target).catch((error: unknown) => {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )) {
          throw error;
        }
        return undefined;
      });
      if (exists) {
        if ((await inspectSkill(target)).treeHash !== entry.treeHash) {
          throw new Error(`Skills: corrupt retained tree ${entry.treeHash}`);
        }
        continue;
      }
      const staged = join(staging, "publish", entry.treeHash);
      await copySkillTree(join(output, skillRelativeRoot(entry.id)), staged);
      if ((await inspectSkill(staged)).treeHash !== entry.treeHash) {
        throw new Error(`Skills: cache publication mismatch for ${entry.id}`);
      }
      await syncTree(staged);
      await rename(staged, target);
      await syncDirectory(join(cacheRoot, "trees"));
    }
    // Provenance lives in persisted bindings. No mutable on-disk catalogue/lock can constrain the next startup.
    console.log(
      `skills: ${manifest.entries.length} selected from ${manifest.repositories.length} repositories (runtime)`,
    );
    for (const repository of manifest.repositories) {
      console.log(
        `  ${repository.id}${repository.ref ? `:${repository.ref}` : " (default branch)"} → ${repository.commit}`,
      );
    }
    return catalog;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
