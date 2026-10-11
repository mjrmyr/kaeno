import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  inspectSkill, INSTALLER, materializeSkillSelection, openSkillCatalog,
  parseSandboxImages, parseSkillRepositories, parseSkillSelection, readSkillDocument, skillPrompt,
  type SkillManifest,
} from "../src/skills.ts";
import { parseConfig } from "../src/config.ts";
import { buildSkillBundle } from "../scripts/build-skills.ts";
import { failedReason, sandboxPod } from "../src/k8s.ts";

const dirs: string[] = [];
const temporary = async () => { const dir = await mkdtemp(join(tmpdir(), "kaeno-skills-")); dirs.push(dir); return dir; };
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const put = async (path: string, content: string | Buffer) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };
async function skill(root: string, name = "probe") {
  await put(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: Print a marker.\n---\nRead references/guide.md then run scripts/probe.sh.\n`);
  await put(join(root, "references/guide.md"), "Use your assigned script.\n");
  await put(join(root, "scripts/probe.sh"), "#!/bin/sh\nprintf 'skill-probe-ok\\n'\n");
  await chmod(join(root, "scripts/probe.sh"), 0o755);
  await put(join(root, "assets/binary"), Buffer.from([0, 255, 0, 254]));
}
async function bundle() {
  const root = await temporary();
  await skill(join(root, "demo/one/probe")); await skill(join(root, "demo/two/probe"));
  const manifest: SkillManifest = {
    schema: 1, installer: INSTALLER,
    repositories: [{ id: "demo/one", ref: "v1", commit: "a".repeat(40) }, { id: "demo/two", commit: "b".repeat(40) }],
    entries: [],
  };
  for (const id of ["demo/one:probe", "demo/two:probe"]) manifest.entries.push({ id, treeHash: (await inspectSkill(join(root, id.replace(":", "/")))).treeHash });
  await put(join(root, "manifest.json"), JSON.stringify(manifest));
  return { root, manifest };
}

const base = { agent: "kaeno", templates: { kaeno: { description: "d", model: "anthropic/model", instructions: "i" } } };
describe("skill configuration", () => {
  it("keeps old config compatible and normalizes source identities", () => {
    expect(parseConfig(base).skillRepositories).toEqual([]);
    expect(parseConfig(base).templates.kaeno!.skills).toEqual([]);
    expect(parseSkillRepositories(["Demo/One:v0.2.4", "demo/two", "demo/three:feature/skills", `demo/four:${"a".repeat(40)}`])).toEqual([
      { id: "demo/one", ref: "v0.2.4" }, { id: "demo/two" }, { id: "demo/three", ref: "feature/skills" }, { id: "demo/four", ref: "a".repeat(40) },
    ]);
  });
  it.each([null, "demo/one", ["demo/one:"], ["demo/one:-flag"], ["demo/one:../main"], ["demo/one:a b"], ["demo/one:a:b"], ["demo/one:main.lock"], ["demo/one:v1", "DEMO/ONE:v2"]])("rejects bad repository declarations %j", value => {
    expect(() => parseSkillRepositories(value)).toThrow();
  });
  it("validates qualified per-template selections and preserves order", () => {
    const repositories = parseSkillRepositories(["demo/one"]);
    expect(parseSkillSelection(["demo/one:second", "Demo/One:first"], repositories)).toEqual(["demo/one:second", "demo/one:first"]);
    for (const ids of [["demo/two:probe"], ["demo/one:../probe"], ["probe"], ["demo/one:probe", "demo/one:probe"], "demo/one:probe"])
      expect(() => parseSkillSelection(ids, repositories)).toThrow();
    expect(parseConfig({ ...base, skillRepositories: ["demo/one"], templates: { kaeno: { ...base.templates.kaeno, skills: ["demo/one:probe"] } } }).templates.kaeno!.skills).toEqual(["demo/one:probe"]);
  });
});

describe("catalogue and selected-only materialization", () => {
  it("binds namespaced skills; allows subset/reassignment but rejects changed refs or unknown skills", async () => {
    const { root } = await bundle();
    const repos = parseSkillRepositories(["demo/one:v1", "demo/two"]);
    const catalog = await openSkillCatalog(root, repos, { worker: ["demo/two:probe"] });
    const binding = catalog.bind(["demo/one:probe"]);
    expect(binding[0]!.sandboxRoot).toBe("/workspace/.agents/skills/demo/one/probe");
    expect(skillPrompt(binding)).toContain("demo/one:probe");
    expect(skillPrompt(binding)).not.toContain("demo/two:probe");
    const loaded = readSkillDocument(binding, { skill: "demo/one:probe", file: "references/guide.md" });
    expect(loaded.text).toContain("assigned script");
    for (const file of ["../SKILL.md", "/etc/passwd", "references/../SKILL.md", "references\\guide.md", "assets/binary", "toString"])
      expect(() => readSkillDocument(binding, { skill: "demo/one:probe", file })).toThrow();
    expect(() => readSkillDocument(binding, { skill: "demo/two:probe" })).toThrow(/not assigned/);
    expect(() => catalog.bind(["demo/one:missing"])).toThrow(/rebuild/);
    await expect(openSkillCatalog(root, [{ id: "demo/one", ref: "v2" }], {})).rejects.toThrow(/ref/);
    // Binding is an independent JSON snapshot, not a mutable alias into the catalogue.
    binding[0]!.documents["SKILL.md"] = "changed";
    expect(catalog.bind(["demo/one:probe"])[0]!.documents["SKILL.md"]).not.toBe("changed");
    binding[0]!.disableModelInvocation = true;
    expect(skillPrompt(binding)).toBeUndefined();
    expect(readSkillDocument(binding, { skill: "demo/one:probe" }).text).toBe("changed");
  });
  it("copies exactly assigned trees including binary assets/modes; retries remove incomplete or stale output", async () => {
    const { root, manifest } = await bundle();
    const destination = await temporary();
    await put(join(destination, ".staging/partial"), "incomplete");
    await put(join(destination, "unassigned/SKILL.md"), "old");
    await materializeSkillSelection(root, [manifest.entries[0]!], destination);
    expect(await readdir(join(destination, "demo"))).toEqual(["one"]);
    expect(await readdir(destination)).toEqual(["demo"]);
    expect(execFileSync(join(destination, "demo/one/probe/scripts/probe.sh"), { encoding: "utf8" })).toBe("skill-probe-ok\n");
    expect(await readFile(join(destination, "demo/one/probe/assets/binary"))).toEqual(Buffer.from([0, 255, 0, 254]));
    await materializeSkillSelection(root, [manifest.entries[0]!], destination);
    expect((await inspectSkill(join(destination, "demo/one/probe"))).treeHash).toBe(manifest.entries[0]!.treeHash);
    await materializeSkillSelection(root, [], destination);
    expect(await readdir(destination)).toEqual([]);
    await expect(materializeSkillSelection(root, [{ ...manifest.entries[0]!, treeHash: "f".repeat(64) }], destination)).rejects.toThrow(/unavailable/);
    await expect(materializeSkillSelection(root, [manifest.entries[0]!, manifest.entries[0]!], destination)).rejects.toThrow(/duplicate/);
  });
  it("rejects source links, bad hashes, and oversized text documents", async () => {
    const { root } = await bundle();
    const outside = join(await temporary(), "outside"); await writeFile(outside, "not a skill");
    await symlink(outside, join(root, "demo/one/probe/escaped"));
    await expect(inspectSkill(join(root, "demo/one/probe"))).rejects.toThrow(/links/);
    await rm(join(root, "demo/one/probe/escaped"));
    await put(join(root, "demo/one/probe/references/large.md"), "x".repeat(256 * 1024 + 1));
    await expect(inspectSkill(join(root, "demo/one/probe"))).rejects.toThrow(/limit/);
    await rm(join(root, "demo/one/probe/references/large.md"));
    await put(join(root, "demo/one/probe/SKILL.md"), "tampered");
    await expect(openSkillCatalog(root, [], {})).rejects.toThrow();
  });
  it("worker gets only selected volume and execution image; source store is init-private", () => {
    const images = { execution: `registry/sandbox@sha256:${"a".repeat(64)}`, skillSource: `registry/kaeno@sha256:${"b".repeat(64)}` };
    expect(parseSandboxImages(images)).toEqual(images);
    expect(() => parseSandboxImages({ ...images, execution: "registry/sandbox:latest" })).toThrow(/digest/);
    const spec = sandboxPod({ name: "probe", images, skills: [{ id: "demo/one:probe", treeHash: "c".repeat(64) }], token: "t", conversationId: "1", taskId: "2", template: "worker" }).spec;
    expect(spec.containers[0]!.image).toBe(images.execution);
    expect(spec.initContainers![0]!.image).toBe(images.skillSource);
    expect(spec.containers[0]!.volumeMounts).toContainEqual({ name: "skills", mountPath: "/workspace/.agents/skills", readOnly: true });
    expect(spec.initContainers![0]!.volumeMounts).toEqual([{ name: "skills", mountPath: "/skills-out" }]);
    expect(spec.initContainers![0]!.env.map(e => e.name)).toEqual(["KAENO_SKILL_PLAN"]);
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(failedReason({ status: { initContainerStatuses: [{ name: "skills", state: { terminated: { exitCode: 1, message: "hash mismatch" } } }] } })).toContain("hash mismatch");
    expect(sandboxPod({ name: "empty", images, skills: [], token: "t", conversationId: "1", taskId: "2", template: "worker" }).spec.initContainers).toBeUndefined();
  });
});

// Actual Git and actual pinned npx CLI; network only for obtaining the CLI (usually cached).
describe("build-time resolver", () => {
  it("uses exact tags/commits, refreshes unpinned HEAD, rejects missing refs and preserves previous output on failure", async () => {
    const root = await temporary();
    const repo = join(root, "demo/one.git"); await mkdir(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.invalid");
    await skill(join(repo, "odd-directory"));
    git("add", "."); git("commit", "-qm", "first"); git("tag", "v1");
    const first = git("rev-parse", "HEAD");
    const gitConfig = join(root, "gitconfig");
    await writeFile(gitConfig, `[url "file://${root}/"]\n\tinsteadOf = https://github.com/\n`);
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    try {
      const output = join(root, "output");
      const built = await buildSkillBundle([{ id: "demo/one", ref: "v1" }], { worker: ["demo/one:probe"] }, output);
      expect(built.repositories[0]!.commit).toBe(first);
      expect(execFileSync(join(output, "demo/one/probe/scripts/probe.sh"), { encoding: "utf8" })).toBe("skill-probe-ok\n");
      expect((await openSkillCatalog(output, [{ id: "demo/one", ref: "v1" }], {})).bind(["demo/one:probe"])[0]!.repositoryCommit).toBe(first);
      const secondRepo = join(root, "demo/two.git");
      execFileSync("git", ["clone", "-q", "--local", repo, secondRepo]);
      const collisionBundle = await buildSkillBundle([{ id: "demo/one", ref: "v1" }, { id: "demo/two" }],
        { worker: ["demo/one:probe", "demo/two:probe"] }, join(root, "collision"));
      expect(collisionBundle.entries.map(e => e.id)).toEqual(["demo/one:probe", "demo/two:probe"]);
      // A repository can itself be a skill; .git is checkout metadata, never a bundled asset.
      const rootRepo = join(root, "demo/root.git"); await mkdir(rootRepo); await skill(rootRepo, "root-probe");
      execFileSync("git", ["init", "-q"], { cwd: rootRepo });
      execFileSync("git", ["add", "."], { cwd: rootRepo });
      execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "root skill"], { cwd: rootRepo });
      await buildSkillBundle([{ id: "demo/root" }], { worker: ["demo/root:root-probe"] }, join(root, "root-skill"));
      await expect(readFile(join(root, "root-skill/demo/root/root-probe/.git/config"))).rejects.toThrow(/ENOENT/);
      await put(join(repo, "new.txt"), "second"); git("add", "."); git("commit", "-qm", "second");
      const second = git("rev-parse", "HEAD");
      expect((await buildSkillBundle([{ id: "demo/one" }], {}, join(root, "latest"))).repositories[0]!.commit).toBe(second);
      await put(join(repo, "new.txt"), "third"); git("add", "."); git("commit", "-qm", "third");
      expect((await buildSkillBundle([{ id: "demo/one" }], {}, join(root, "latest"))).repositories[0]!.commit).not.toBe(second);
      expect((await buildSkillBundle([{ id: "demo/one", ref: first }], {}, join(root, "commit"))).repositories[0]!.commit).toBe(first);
      const before = await readFile(join(output, "manifest.json"), "utf8");
      await expect(buildSkillBundle([{ id: "demo/one", ref: "not-a-tag" }], {}, output)).rejects.toThrow();
      expect(await readFile(join(output, "manifest.json"), "utf8")).toBe(before);
      await expect(buildSkillBundle([{ id: "demo/one" }], { worker: ["demo/one:missing"] }, output)).rejects.toThrow(/missing/);
      await skill(join(repo, "duplicate")); git("add", "."); git("commit", "-qm", "duplicate name");
      await expect(buildSkillBundle([{ id: "demo/one" }], { worker: ["demo/one:probe"] }, output)).rejects.toThrow(/ambiguous/);
      await symlink("/tmp", join(repo, "escaped")); git("add", "."); git("commit", "-qm", "link");
      await expect(buildSkillBundle([{ id: "demo/one" }], { worker: ["demo/one:probe"] }, output)).rejects.toThrow(/links/);
      expect((await readdir(root)).filter(n => n.startsWith(".kaeno-skills-"))).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  }, 120_000);
});
