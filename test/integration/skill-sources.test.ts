import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { directorySource } from "../../src/extensions/definitions/index.ts";
import {
  loadSkills,
  readSkillDocument,
  skillBinder,
  skillsExtension,
} from "../../src/extensions/skills/index.ts";

it("snapshots text, binary assets and executable bits and retains assigned content after source removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaeno-skill-source-"));
  try {
    const pkg = join(root, "guide");
    await mkdir(join(pkg, "scripts"), { recursive: true });
    await writeFile(
      join(pkg, "SKILL.md"),
      "---\nname: guide\ndescription: Verify work\n---\nRead scripts/check.sh.\n",
    );
    await writeFile(
      join(pkg, "scripts/check.sh"),
      "#!/bin/sh\necho verified\n",
    );
    await chmod(join(pkg, "scripts/check.sh"), 0o755);
    const bytes = Buffer.from([0, 255, 128, 1]);
    await writeFile(join(pkg, "asset.bin"), bytes);
    const snapshot = await directorySource("home", root).snapshot("SKILL.md");
    const { catalog, diagnostics } = await loadSkills(snapshot.packages);
    expect(diagnostics).toEqual([]);
    const bound = catalog.bind(["home:guide"]);
    expect(bound[0].assets?.["asset.bin"].base64).toBe(
      bytes.toString("base64"),
    );
    expect(bound[0].assets?.["scripts/check.sh"].executable).toBe(true);
    const binding = skillBinder(catalog).bind(["guide"]);
    expect(() => skillsExtension().validateBinding?.(binding)).not.toThrow();
    await rm(pkg, { recursive: true });
    expect(
      readSkillDocument(bound, { skill: "guide", file: "scripts/check.sh" }),
    ).toContain("echo verified");
    expect(
      readSkillDocument(bound, { skill: "guide", file: "asset.bin" }),
    ).toContain(bytes.toString("base64"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects linked assets and does not choose one of two duplicate skill identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaeno-skill-source-"));
  try {
    for (const name of ["one", "two"]) {
      await mkdir(join(root, name));
      await writeFile(
        join(root, name, "SKILL.md"),
        "---\nname: same\ndescription: Guide\n---\nInstructions\n",
      );
    }
    let snapshot = await directorySource("home", root).snapshot("SKILL.md");
    const duplicated = await loadSkills(snapshot.packages);
    expect(duplicated.catalog.list()).toEqual([]);
    expect(duplicated.diagnostics[0].message).toContain("duplicate");
    await rm(join(root, "two"), { recursive: true });
    await symlink("/etc/passwd", join(root, "one/escape"));
    snapshot = await directorySource("home", root).snapshot("SKILL.md");
    const linked = await loadSkills(snapshot.packages);
    expect(linked.catalog.list()).toEqual([]);
    expect(linked.diagnostics[0].message).toContain("links");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
