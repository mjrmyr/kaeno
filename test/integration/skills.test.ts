import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../src/config/index.ts";
import { failedReason, sandboxPod } from "../../src/sandboxes/index.ts";
import {
  copySkillTree,
  inspectSkill,
  INSTALLER,
  materializeSkillSelection,
  openSkillCatalog,
  parseSandboxImages,
  parseSkillRepositories,
  parseSkillSelection,
  prepareSkills,
  readSkillDocument,
  skillPrompt,
  splitSkillId,
  type SkillManifest,
} from "../../src/skills/index.ts";
import { required, serverPort } from "./values.ts";
const dirs: string[] = [];
const temporary = async () => {
  const dir = await mkdtemp(join(tmpdir(), "kaeno-skills-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});
const put = async (path: string, content: string | Buffer) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};
async function skill(root: string, name = "probe") {
  await put(
    join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: Print a marker.\n---\nRead references/guide.md then run scripts/probe.sh.\n`,
  );
  await put(join(root, "references/guide.md"), "Use your assigned script.\n");
  await put(
    join(root, "scripts/probe.sh"),
    "#!/bin/sh\nprintf 'skill-probe-ok\\n'\n",
  );
  await chmod(join(root, "scripts/probe.sh"), 0o755);
  await put(join(root, "assets/binary"), Buffer.from([0, 255, 0, 254]));
}
// Test-only transport rewrite, not a production Git-config/auth escape hatch.
async function fixtureGit(root: string) {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\nenv > '${root}/git-env'\nexec '${realGit}' -c 'url.file://${root}/.insteadOf=https://github.com/' "$@"\n`,
  );
  await chmod(join(bin, "git"), 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  return bin;
}
async function bundle() {
  const root = await temporary();
  await skill(join(root, "demo/one/probe"));
  await skill(join(root, "demo/two/probe"));
  const manifest: SkillManifest = {
    schema: 1,
    installer: INSTALLER,
    repositories: [
      { id: "demo/one", ref: "v1", commit: "a".repeat(40) },
      { id: "demo/two", commit: "b".repeat(40) },
    ],
    entries: [],
  };
  for (const id of ["demo/one:probe", "demo/two:probe"]) {
    manifest.entries.push({
      id,
      treeHash: (await inspectSkill(join(root, id.replace(":", "/")))).treeHash,
    });
  }
  await put(join(root, "manifest.json"), JSON.stringify(manifest));
  for (const entry of manifest.entries) {
    await copySkillTree(
      join(root, entry.id.replace(":", "/")),
      join(root, "trees", entry.treeHash),
    );
  }
  return { root, manifest };
}
const base = {
  agent: "kaeno",
  templates: {
    kaeno: { description: "d", model: "anthropic/model", instructions: "i" },
  },
};
describe("skill configuration", () => {
  it("keeps old config compatible and normalizes source identities", () => {
    expect(parseConfig(base).skillRepositories).toEqual([]);
    expect(required(parseConfig(base).templates.kaeno).skills).toEqual([]);
    expect(
      parseSkillRepositories([
        "Demo/One:v0.2.4",
        "demo/two",
        "demo/three:feature/skills",
        `demo/four:${"a".repeat(40)}`,
      ]),
    ).toEqual([
      { id: "demo/one", ref: "v0.2.4" },
      { id: "demo/two" },
      { id: "demo/three", ref: "feature/skills" },
      { id: "demo/four", ref: "a".repeat(40) },
    ]);
  });
  it.each([
    null,
    "demo/one",
    ["demo/one:"],
    ["demo/one:-flag"],
    ["demo/one:../main"],
    ["demo/one:a b"],
    ["demo/one:a:b"],
    ["demo/one:main.lock"],
    ["demo/one:v1", "DEMO/ONE:v2"],
  ])("rejects bad repository declarations %j", (value) => {
    expect(() => parseSkillRepositories(value)).toThrow();
  });
  it("accepts repository wildcards only as declared config selectors, not concrete skill IDs", () => {
    const repositories = parseSkillRepositories(["mjrmyr/myriad"]);
    expect(
      parseSkillSelection(
        ["MJRMYR/Myriad:*", "mjrmyr/myriad:probe"],
        repositories,
      ),
    ).toEqual(["mjrmyr/myriad:*", "mjrmyr/myriad:probe"]);
    for (const selector of [
      "*",
      "mjrmyr/*:*",
      "mjrmyr/myriad:pro*",
      "mjrmyr/myriad:**",
      "demo/other:*",
    ]) {
      expect(() => parseSkillSelection([selector], repositories)).toThrow();
    }
    expect(() => splitSkillId("mjrmyr/myriad:*")).toThrow();
    expect(
      required(
        parseConfig({
          ...base,
          skillRepositories: ["mjrmyr/myriad"],
          templates: {
            kaeno: { ...base.templates.kaeno, skills: ["mjrmyr/myriad:*"] },
          },
        }).templates.kaeno,
      ).skills,
    ).toEqual(["mjrmyr/myriad:*"]);
  });
  it("validates qualified per-template selections and preserves order", () => {
    const repositories = parseSkillRepositories(["demo/one"]);
    expect(
      parseSkillSelection(["demo/one:second", "Demo/One:first"], repositories),
    ).toEqual(["demo/one:second", "demo/one:first"]);
    for (const ids of [
      ["demo/two:probe"],
      ["demo/one:../probe"],
      ["probe"],
      ["demo/one:probe", "demo/one:probe"],
      "demo/one:probe",
    ]) {
      expect(() => parseSkillSelection(ids, repositories)).toThrow();
    }
    expect(
      required(
        parseConfig({
          ...base,
          skillRepositories: ["demo/one"],
          templates: {
            kaeno: { ...base.templates.kaeno, skills: ["demo/one:probe"] },
          },
        }).templates.kaeno,
      ).skills,
    ).toEqual(["demo/one:probe"]);
  });
});
describe("catalogue and selected-only materialization", () => {
  it("binds namespaced skills; allows subset/reassignment but rejects changed refs or unknown skills", async () => {
    const { root } = await bundle();
    const repos = parseSkillRepositories(["demo/one:v1", "demo/two"]);
    const catalog = await openSkillCatalog(root, repos, {
      worker: ["demo/two:probe"],
    });
    const binding = catalog.bindSkills(["demo/one:probe"]);
    expect(required(binding[0]).sandboxRoot).toBe(
      "/workspace/.agents/skills/demo/one/probe",
    );
    expect(skillPrompt(binding)).toContain("demo/one:probe");
    expect(skillPrompt(binding)).not.toContain("demo/two:probe");
    const loaded = readSkillDocument(binding, {
      skill: "demo/one:probe",
      file: "references/guide.md",
    });
    expect(loaded.text).toContain("assigned script");
    for (const file of [
      "../SKILL.md",
      "/etc/passwd",
      "references/../SKILL.md",
      "references\\guide.md",
      "assets/binary",
      "toString",
    ]) {
      expect(() =>
        readSkillDocument(binding, { skill: "demo/one:probe", file }),
      ).toThrow();
    }
    expect(() =>
      readSkillDocument(binding, { skill: "demo/two:probe" }),
    ).toThrow(/not assigned/);
    expect(() => catalog.bindSkills(["demo/one:missing"])).toThrow(
      /resolved catalogue/,
    );
    await expect(
      openSkillCatalog(root, [{ id: "demo/one", ref: "v2" }], {}),
    ).rejects.toThrow(/ref/);
    // Binding is an independent JSON snapshot, not a mutable alias into the catalogue.
    required(binding[0]).documents["SKILL.md"] = "changed";
    expect(
      required(catalog.bindSkills(["demo/one:probe"])[0]).documents["SKILL.md"],
    ).not.toBe("changed");
    required(binding[0]).disableModelInvocation = true;
    expect(skillPrompt(binding)).toBeUndefined();
    expect(readSkillDocument(binding, { skill: "demo/one:probe" }).text).toBe(
      "changed",
    );
  });
  it("expands only the selected repository, deduplicates overlapping selectors, and rejects wildcard manifests", async () => {
    const { root, manifest } = await bundle();
    await skill(join(root, "demo/one/another"), "another");
    manifest.entries.push({
      id: "demo/one:another",
      treeHash: (await inspectSkill(join(root, "demo/one/another"))).treeHash,
    });
    await put(join(root, "manifest.json"), JSON.stringify(manifest));
    const catalog = await openSkillCatalog(root, manifest.repositories, {
      worker: ["demo/one:*"],
    });
    const binding = catalog.bindSkills([
      "demo/one:probe",
      "demo/one:*",
      "demo/one:another",
    ]);
    expect(binding.map((state) => state.id)).toEqual([
      "demo/one:probe",
      "demo/one:another",
    ]);
    expect(catalog.bindSkills(["demo/one:*"]).map((state) => state.id)).toEqual(
      ["demo/one:another", "demo/one:probe"],
    );
    expect(() => catalog.bindSkills(["demo/missing:*"])).toThrow(
      /no skills found/,
    );
    expect(() =>
      catalog.bindSkills(["demo/one:*", "demo/one:missing"]),
    ).toThrow(/resolved catalogue/);
    expect(JSON.stringify(binding)).not.toContain(":*");
    required(manifest.entries[0]).id = "demo/one:*";
    await put(join(root, "manifest.json"), JSON.stringify(manifest));
    await expect(
      openSkillCatalog(root, manifest.repositories, {}),
    ).rejects.toThrow(/invalid skill ID/);
  });
  it("enforces count and text limits after expansion, not globally across the catalogue", async () => {
    const root = await temporary();
    const manifest: SkillManifest = {
      schema: 1,
      installer: INSTALLER,
      repositories: [{ id: "demo/one", commit: "a".repeat(40) }],
      entries: [],
    };
    for (let index = 0; index < 257; index++) {
      const name = `skill-${index}`;
      const path = join(root, "demo/one", name);
      await skill(path, name);
      manifest.entries.push({
        id: `demo/one:${name}`,
        treeHash: (await inspectSkill(path)).treeHash,
      });
    }
    await put(join(root, "manifest.json"), JSON.stringify(manifest));
    const catalog = await openSkillCatalog(root, manifest.repositories, {});
    expect(
      catalog.bindSkills(
        manifest.entries.slice(0, 128).map((eventValue) => eventValue.id),
      ),
    ).toHaveLength(128);
    expect(
      catalog.bindSkills(
        manifest.entries.slice(128).map((eventValue) => eventValue.id),
      ),
    ).toHaveLength(129);
    expect(() => catalog.bindSkills(["demo/one:*"])).toThrow(/too many skills/);
    manifest.entries = manifest.entries.slice(0, 7);
    for (const entry of manifest.entries) {
      const path = join(root, entry.id.replace(":", "/"));
      for (let indexValue = 0; indexValue < 5; indexValue++) {
        await put(
          join(path, `references/large-${indexValue}.md`),
          "x".repeat(256 * 1024),
        );
      }
      entry.treeHash = (await inspectSkill(path)).treeHash;
    }
    await put(join(root, "manifest.json"), JSON.stringify(manifest));
    const large = await openSkillCatalog(root, manifest.repositories, {});
    expect(() => large.bindSkills(["demo/one:*"])).toThrow(/8 MiB/);
  }, 60000);
  it("copies exactly assigned trees including binary assets/modes; retries remove incomplete or stale output", async () => {
    const { root, manifest } = await bundle();
    const destination = await temporary();
    await put(join(destination, ".staging/partial"), "incomplete");
    await put(join(destination, "unassigned/SKILL.md"), "old");
    await materializeSkillSelection(
      root,
      [required(manifest.entries[0])],
      destination,
    );
    expect(await readdir(join(destination, "demo"))).toEqual(["one"]);
    expect(await readdir(destination)).toEqual(["demo"]);
    expect(
      execFileSync(join(destination, "demo/one/probe/scripts/probe.sh"), {
        encoding: "utf8",
      }),
    ).toBe("skill-probe-ok\n");
    expect(
      await readFile(join(destination, "demo/one/probe/assets/binary")),
    ).toEqual(Buffer.from([0, 255, 0, 254]));
    await materializeSkillSelection(
      root,
      [required(manifest.entries[0])],
      destination,
    );
    const unrelated = {
      id: "demo/one:other",
      treeHash: required(manifest.entries[0]).treeHash,
    };
    await expect(
      materializeSkillSelection(root, [unrelated], destination),
    ).rejects.toThrow(/integrity/);
    await materializeSkillSelection(
      root,
      [required(manifest.entries[0])],
      destination,
    );
    expect(
      (await inspectSkill(join(destination, "demo/one/probe"))).treeHash,
    ).toBe(required(manifest.entries[0]).treeHash);
    await materializeSkillSelection(root, [], destination);
    expect(await readdir(destination)).toEqual([]);
    await expect(
      materializeSkillSelection(
        root,
        [{ ...required(manifest.entries[0]), treeHash: "f".repeat(64) }],
        destination,
      ),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      materializeSkillSelection(
        root,
        [required(manifest.entries[0]), required(manifest.entries[0])],
        destination,
      ),
    ).rejects.toThrow(/duplicate/);
  });
  it("rejects source links, bad hashes, and oversized text documents", async () => {
    const { root } = await bundle();
    const outside = join(await temporary(), "outside");
    await writeFile(outside, "not a skill");
    await symlink(outside, join(root, "demo/one/probe/escaped"));
    await expect(inspectSkill(join(root, "demo/one/probe"))).rejects.toThrow(
      /links/,
    );
    await rm(join(root, "demo/one/probe/escaped"));
    await put(
      join(root, "demo/one/probe/references/large.md"),
      "x".repeat(256 * 1024 + 1),
    );
    await expect(inspectSkill(join(root, "demo/one/probe"))).rejects.toThrow(
      /limit/,
    );
    await rm(join(root, "demo/one/probe/references/large.md"));
    await put(join(root, "demo/one/probe/SKILL.md"), "tampered");
    await expect(openSkillCatalog(root, [], {})).rejects.toThrow();
  });
  it("worker gets only selected volume and execution image; source store is init-private", () => {
    const images = { execution: `registry/sandbox@sha256:${"a".repeat(64)}` };
    expect(parseSandboxImages(images)).toEqual(images);
    expect(parseSandboxImages({ ...images, skillSource: "legacy" })).toEqual(
      images,
    ); // cannot create new source-image bindings
    expect(() =>
      parseSandboxImages({ ...images, execution: "registry/sandbox:latest" }),
    ).toThrow(/digest/);
    const spec = sandboxPod({
      name: "probe",
      images,
      skillCacheClaim: "kaeno-skills",
      skills: [{ id: "demo/one:probe", treeHash: "c".repeat(64) }],
      token: "t",
      conversationId: "1",
      taskId: "2",
      template: "worker",
    }).spec;
    expect(required(spec.containers[0]).image).toBe(images.execution);
    expect(required(spec.containers[0]).env).toContainEqual({
      name: "GH_PROMPT_DISABLED",
      value: "1",
    });
    expect(required(spec.containers[0]).env).toContainEqual({
      name: "GH_TOKEN",
      valueFrom: {
        secretKeyRef: {
          name: "kaeno-github-api",
          key: "token",
          optional: true,
        },
      },
    });
    expect(required(required(spec.initContainers)[0]).image).toBe(
      images.execution,
    );
    expect(required(spec.containers[0]).volumeMounts).toContainEqual({
      name: "skills",
      mountPath: "/workspace/.agents/skills",
      readOnly: true,
    });
    expect(required(required(spec.initContainers)[0]).volumeMounts).toEqual([
      { name: "skills", mountPath: "/skills-out" },
      { name: "skill-cache", mountPath: "/skill-cache", readOnly: true },
    ]);
    expect(spec.volumes).toContainEqual({
      name: "skill-cache",
      persistentVolumeClaim: { claimName: "kaeno-skills", readOnly: true },
    });
    expect(
      required(spec.containers[0]).volumeMounts.some(
        (value) => value.name === "skill-cache",
      ),
    ).toBe(false);
    expect(
      required(required(spec.initContainers)[0]).env.map(
        (eventValue) => eventValue.name,
      ),
    ).toEqual(["KAENO_SKILL_PLAN"]);
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(
      failedReason({
        status: {
          phase: "Failed",
          initContainerStatuses: [
            {
              name: "skills",
              state: { terminated: { exitCode: 1, message: "hash mismatch" } },
            },
          ],
        },
      }),
    ).toContain("hash mismatch");
    expect(
      sandboxPod({
        name: "empty",
        images,
        skillCacheClaim: "kaeno-skills",
        skills: [],
        token: "t",
        conversationId: "1",
        taskId: "2",
        template: "worker",
      }).spec.initContainers,
    ).toBeUndefined();
    // Existing image-backed children replay their stored source, with no cache mount or initializer credentials.
    const legacy = sandboxPod({
      name: "legacy",
      images: { ...images, skillSource: "old-source" },
      skillCacheClaim: "unused",
      skills: [{ id: "demo/one:probe", treeHash: "c".repeat(64) }],
      token: "t",
      conversationId: "1",
      taskId: "2",
      template: "worker",
    }).spec;
    expect(required(required(legacy.initContainers)[0]).image).toBe(
      "old-source",
    );
    expect(required(required(legacy.initContainers)[0]).volumeMounts).toEqual([
      { name: "skills", mountPath: "/skills-out" },
    ]);
    expect(legacy.volumes.some((value) => value.name === "skill-cache")).toBe(
      false,
    );
  });
});
// Actual Git and actual pinned npx CLI; network only for obtaining the CLI.
describe("runtime preparation", () => {
  it("installs all wildcard skills, refreshes membership without mutating frozen bindings, and rejects empty/ambiguous sources", async () => {
    const root = await temporary();
    const repo = join(root, "demo/one.git");
    const other = join(root, "demo/two.git");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    for (const path of [repo, other]) {
      await mkdir(path, { recursive: true });
      git(path, "init", "-q");
      git(path, "config", "user.name", "fixture");
      git(path, "config", "user.email", "fixture@example.invalid");
    }
    await skill(join(repo, "directory-a"), "second");
    await skill(join(repo, "directory-b"), "first");
    await skill(join(other, "other"), "unrelated");
    for (const path of [repo, other]) {
      git(path, "add", ".");
      git(path, "commit", "-qm", "fixture");
    }
    await fixtureGit(root);
    const cacheRoot = join(root, "cache");
    const repositories = [{ id: "demo/one" }, { id: "demo/two" }];
    const selections = {
      worker: ["demo/one:*", "demo/one:first"],
      other: ["demo/two:unrelated"],
    };
    const before = await prepareSkills({ repositories, selections, cacheRoot });
    const frozen = before.bindSkills(selections.worker);
    expect(frozen.map((state) => state.id)).toEqual([
      "demo/one:first",
      "demo/one:second",
    ]);
    expect(JSON.stringify(frozen)).not.toContain(":*");
    await rm(join(repo, "directory-a"), { recursive: true });
    await skill(join(repo, "directory-c"), "third");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "change membership");
    const after = await prepareSkills({ repositories, selections, cacheRoot });
    expect(
      after.bindSkills(selections.worker).map((state) => state.id),
    ).toEqual(["demo/one:first", "demo/one:third"]);
    expect(
      before.bindSkills(selections.worker).map((state) => state.id),
    ).toEqual(["demo/one:first", "demo/one:second"]);
    const output = join(root, "selected");
    await materializeSkillSelection(
      cacheRoot,
      frozen.map(({ id, treeHash }) => ({ id, treeHash })),
      output,
    );
    expect(await readdir(join(output, "demo/one"))).toEqual([
      "first",
      "second",
    ]);
    expect(await readdir(join(output, "demo"))).toEqual(["one"]);
    expect(
      execFileSync(join(output, "demo/one/second/scripts/probe.sh"), {
        encoding: "utf8",
      }),
    ).toBe("skill-probe-ok\n");
    await expect(
      prepareSkills({
        repositories,
        selections: { worker: ["demo/one:*", "demo/one:missing"] },
        cacheRoot,
      }),
    ).rejects.toThrow(/missing/);
    await skill(join(repo, "duplicate"), "first");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "duplicate");
    await expect(
      prepareSkills({ repositories, selections, cacheRoot }),
    ).rejects.toThrow(/ambiguous/);
    await rm(join(repo, "duplicate"), { recursive: true });
    await rm(join(repo, "directory-b"), { recursive: true });
    await rm(join(repo, "directory-c"), { recursive: true });
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "empty");
    await expect(
      prepareSkills({ repositories, selections, cacheRoot }),
    ).rejects.toThrow(/no skills found/);
    expect(
      (
        await inspectSkill(
          join(cacheRoot, "trees", required(frozen[1]).treeHash),
        )
      ).treeHash,
    ).toBe(required(frozen[1]).treeHash);
  }, 120000);
  it("fetches anonymously despite inherited Git auth/config, and strips credentials from Git and npx", async () => {
    const root = await temporary();
    const repo = join(root, "demo/public.git");
    await mkdir(repo, { recursive: true });
    await skill(join(repo, "probe"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const realNpx = execFileSync("which", ["npx"], { encoding: "utf8" }).trim();
    execFileSync(realGit, ["init", "-q"], { cwd: repo });
    execFileSync(realGit, ["add", "."], { cwd: repo });
    execFileSync(
      realGit,
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: repo },
    );
    const bin = await fixtureGit(root);
    await writeFile(
      join(bin, "npx"),
      `#!/bin/sh\nenv > '${root}/npm-env'\nexec '${realNpx}' "$@"\n`,
    );
    await chmod(join(bin, "npx"), 0o755);
    const gitConfig = join(root, "gitconfig");
    await writeFile(
      gitConfig,
      "[credential]\n\thelper = !echo credential-helper-must-not-run >&2; exit 1\n",
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig);
    for (const name of [
      "KAENO_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "GIT_ASKPASS",
      "GIT_CONFIG_VALUE_0",
    ]) {
      vi.stubEnv(name, "credential-secret-marker");
    }
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "http.extraheader");
    const cacheRoot = join(root, "cache");
    const catalog = await prepareSkills({
      repositories: [{ id: "demo/public" }],
      selections: { worker: ["demo/public:probe"] },
      cacheRoot,
    });
    const gitEnv = await readFile(join(root, "git-env"), "utf8");
    const npmEnv = await readFile(join(root, "npm-env"), "utf8");
    expect(gitEnv).toContain("GIT_CONFIG_GLOBAL=/dev/null");
    expect(gitEnv).toContain("GIT_CONFIG_NOSYSTEM=1");
    expect(gitEnv).toContain("GIT_TERMINAL_PROMPT=0");
    expect(gitEnv).not.toContain("GIT_CONFIG_COUNT");
    expect(gitEnv).not.toContain("GIT_ASKPASS");
    expect(gitEnv).not.toContain("credential-secret-marker");
    expect(npmEnv).not.toContain("credential-secret-marker");
    expect(npmEnv).not.toContain("GIT_CONFIG_GLOBAL");
    const binding = catalog.bindSkills(["demo/public:probe"]);
    expect(JSON.stringify(binding)).not.toContain("credential-secret-marker");
    await expect(
      readFile(
        join(cacheRoot, "trees", required(binding[0]).treeHash, ".git/config"),
      ),
    ).rejects.toThrow(/ENOENT/);
  }, 60000);
  it("fails an authentication-required source without sending auth or invoking inherited credential helpers", async () => {
    const root = await temporary();
    const bin = join(root, "bin");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    await mkdir(bin);
    const authorizations: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      authorizations.push(req.headers.authorization);
      res
        .writeHead(401, { "WWW-Authenticate": 'Basic realm="private-source"' })
        .end();
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${serverPort(server)}/`;
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\nexec '${realGit}' -c 'url.${url}.insteadOf=https://github.com/' "$@"\n`,
    );
    await chmod(join(bin, "git"), 0o755);
    const global = join(root, "gitconfig");
    const helperMarker = join(root, "helper-ran");
    await writeFile(
      global,
      `[credential]\n\thelper = "!touch ${helperMarker}; echo username=fixture; echo password=secret"\n`,
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", global);
    try {
      await expect(
        prepareSkills({
          repositories: [{ id: "demo/private" }],
          selections: {},
          cacheRoot: join(root, "cache"),
        }),
      ).rejects.toThrow(/terminal prompts disabled/);
      expect(authorizations.length).toBeGreaterThan(0);
      expect(authorizations.every((value) => value === undefined)).toBe(true);
      await expect(readFile(helperMarker)).rejects.toThrow(/ENOENT/);
      expect(
        (await readdir(join(root, "cache"))).filter((count) =>
          count.startsWith(".kaeno-skills-"),
        ),
      ).toEqual([]);
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });
  it("uses exact tags/commits, refreshes unpinned HEAD, rejects missing refs and preserves previous output on failure", async () => {
    const root = await temporary();
    const repo = join(root, "demo/one.git");
    await mkdir(repo, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "-q");
    git("config", "user.name", "fixture");
    git("config", "user.email", "fixture@example.invalid");
    await skill(join(repo, "odd-directory"));
    git("add", ".");
    git("commit", "-qm", "first");
    git("tag", "v1");
    const first = git("rev-parse", "HEAD");
    await fixtureGit(root);
    {
      const cacheRoot = join(root, "cache");
      const prepare = (
        repositories: {
          id: string;
          ref?: string;
        }[],
        selections: Record<string, string[]> = { worker: ["demo/one:probe"] },
      ) => prepareSkills({ repositories, selections, cacheRoot });
      const built = await prepare([{ id: "demo/one", ref: "v1" }]);
      const frozen = required(built.bindSkills(["demo/one:probe"])[0]);
      expect(frozen.repositoryCommit).toBe(first);
      expect(
        execFileSync(
          join(cacheRoot, "trees", frozen.treeHash, "scripts/probe.sh"),
          { encoding: "utf8" },
        ),
      ).toBe("skill-probe-ok\n");
      const secondRepo = join(root, "demo/two.git");
      execFileSync("git", ["clone", "-q", "--local", repo, secondRepo]);
      const collisionBundle = await prepare(
        [{ id: "demo/one", ref: "v1" }, { id: "demo/two" }],
        { worker: ["demo/one:probe", "demo/two:probe"] },
      );
      expect(
        collisionBundle
          .bindSkills(["demo/one:probe", "demo/two:probe"])
          .map((eventValue) => eventValue.id),
      ).toEqual(["demo/one:probe", "demo/two:probe"]);
      expect(await readdir(join(cacheRoot, "trees"))).toEqual([
        frozen.treeHash,
      ]); // same bytes deduplicate across repositories
      // A repository can itself be a skill; .git is checkout metadata, never a bundled asset.
      const rootRepo = join(root, "demo/root.git");
      await mkdir(rootRepo);
      await skill(rootRepo, "root-probe");
      execFileSync("git", ["init", "-q"], { cwd: rootRepo });
      execFileSync("git", ["add", "."], { cwd: rootRepo });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-qm",
          "root skill",
        ],
        { cwd: rootRepo },
      );
      const rootCatalog = await prepare([{ id: "demo/root" }], {
        worker: ["demo/root:root-probe"],
      });
      await expect(
        readFile(
          join(
            cacheRoot,
            "trees",
            required(rootCatalog.bindSkills(["demo/root:root-probe"])[0])
              .treeHash,
            ".git/config",
          ),
        ),
      ).rejects.toThrow(/ENOENT/);
      await put(join(repo, "odd-directory/references/version.txt"), "second");
      git("add", ".");
      git("commit", "-qm", "second");
      const second = git("rev-parse", "HEAD");
      const latest = required(
        (await prepare([{ id: "demo/one" }])).bindSkills(["demo/one:probe"])[0],
      );
      expect(latest.repositoryCommit).toBe(second);
      expect(latest.treeHash).not.toBe(frozen.treeHash);
      expect(latest.documents["references/version.txt"]).toBe("second");
      await put(join(repo, "odd-directory/references/version.txt"), "third");
      git("add", ".");
      git("commit", "-qm", "third");
      expect(
        required(
          (await prepare([{ id: "demo/one" }])).bindSkills([
            "demo/one:probe",
          ])[0],
        ).repositoryCommit,
      ).not.toBe(second);
      expect(
        required(
          (await prepare([{ id: "demo/one", ref: first }])).bindSkills([
            "demo/one:probe",
          ])[0],
        ).repositoryCommit,
      ).toBe(first);
      const before = await readdir(join(cacheRoot, "trees"));
      await expect(
        prepare([{ id: "demo/one", ref: "not-a-tag" }]),
      ).rejects.toThrow();
      expect(await readdir(join(cacheRoot, "trees"))).toEqual(before);
      // Old selection survives ref changes, empty config, failed startup, and abandoned staging.
      await put(join(cacheRoot, ".kaeno-skills-crashed/partial"), "incomplete");
      await prepare([], {});
      expect(await readdir(join(cacheRoot, "trees"))).toEqual(before);
      expect(
        (await inspectSkill(join(cacheRoot, "trees", frozen.treeHash)))
          .treeHash,
      ).toBe(frozen.treeHash);
      await expect(
        prepare([{ id: "demo/one" }], { worker: ["demo/one:missing"] }),
      ).rejects.toThrow(/missing/);
      await skill(join(repo, "duplicate"));
      git("add", ".");
      git("commit", "-qm", "duplicate name");
      await expect(prepare([{ id: "demo/one" }])).rejects.toThrow(/ambiguous/);
      await symlink("/tmp", join(repo, "escaped"));
      git("add", ".");
      git("commit", "-qm", "link");
      await expect(prepare([{ id: "demo/one" }])).rejects.toThrow(/links/);
      expect(
        (await readdir(cacheRoot)).filter((count) =>
          count.startsWith(".kaeno-skills-"),
        ),
      ).toEqual([]);
      await put(
        join(cacheRoot, "trees", frozen.treeHash, "references/guide.md"),
        "corrupted",
      );
      await expect(prepare([{ id: "demo/one", ref: "v1" }])).rejects.toThrow(
        /corrupt retained tree/,
      );
    }
  }, 120000);
});
