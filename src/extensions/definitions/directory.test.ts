import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  agentSource,
  directorySource,
  parseManifest,
  readManifestFile,
} from "./index.ts";
const roots: string[] = [];
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kaeno-defs-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
it("loads one manifest per package directory and treats missing roots as empty", async () => {
  const root = await temp();
  const pkg = join(root, "reviewer");
  await mkdir(pkg);
  await writeFile(
    join(pkg, "AGENT.md"),
    "---\nname: reviewer\ndescription: Reviews code\n---\nReview carefully.\n",
  );
  const found = await directorySource("home", root).snapshot("AGENT.md");
  expect(found.diagnostics).toEqual([]);
  expect(found.packages).toEqual([
    {
      source: "home",
      directory: pkg,
      manifest: expect.stringContaining("name: reviewer"),
    },
  ]);
  expect(
    (
      await directorySource("missing", join(root, "absent")).snapshot(
        "AGENT.md",
      )
    ).packages,
  ).toEqual([]);
});
it("rejects package directory symlinks and manifest symlinks instead of following them", async () => {
  const root = await temp();
  const outside = await temp();
  await writeFile(
    join(outside, "AGENT.md"),
    "---\nname: bad\ndescription: bad\n---\n",
  );
  await symlink(outside, join(root, "linked"));
  const source = await directorySource("x", root).snapshot("AGENT.md");
  expect(source.packages).toEqual([]);
  expect(source.diagnostics).toHaveLength(1);
  await mkdir(join(root, "pkg"));
  await symlink(join(outside, "AGENT.md"), join(root, "pkg/AGENT.md"));
  const withManifestLink = await directorySource("x", root).snapshot(
    "AGENT.md",
  );
  expect(withManifestLink.packages).toEqual([]);
  expect(
    withManifestLink.diagnostics.map(({ message }) => message).join("\n"),
  ).toContain("regular file");
});
it("validates regular manifests and UTF-8 YAML frontmatter", async () => {
  const root = await temp();
  const path = join(root, "AGENT.md");
  await writeFile(path, "---\nname: valid\ndescription: valid\n---\nBody");
  expect(await readManifestFile(path)).toContain("Body");
  await rm(path);
  await mkdir(path);
  await expect(readManifestFile(path)).rejects.toThrow(/regular file/);
  expect(() => parseManifest("Body only", "AGENT.md")).toThrow(/frontmatter/);
  expect(() =>
    parseManifest(
      "---\nname: one\nname: two\ndescription: d\n---\n",
      "AGENT.md",
    ),
  ).toThrow(/duplicate|unique|frontmatter/i);
});

it("discovers only direct flat agents, diagnoses legacy/case errors and keeps skill discovery unchanged", async () => {
  const root = await temp();
  await mkdir(join(root, "legacy"));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "legacy/AGENT.md"), "legacy");
  await writeFile(join(root, "nested/hidden.md"), "not discovered");
  await writeFile(join(root, "nested/SKILL.md"), "skill");
  for (const name of [
    "z.md",
    "a.md",
    ".hidden.md",
    "ignored.txt",
    "wrong.MD",
  ]) {
    await writeFile(join(root, name), name);
  }
  const found = await agentSource("home", root).snapshot();
  expect(found.documents.map((doc) => doc.manifestPath)).toEqual([
    join(root, "a.md"),
    join(root, "z.md"),
  ]);
  expect(found.diagnostics.map((item) => item.message).join("\n")).toMatch(
    /legacy agent package.*\n.*lowercase .md/,
  );
  const skills = await directorySource("home", root).snapshot("SKILL.md");
  expect(skills.packages.map((pkg) => pkg.directory)).toEqual([
    join(root, "nested"),
  ]);
});
it("diagnoses missing roots but rejects linked/non-directory roots and linked candidates", async () => {
  const root = await temp();
  const missing = await agentSource("home", join(root, "absent")).snapshot();
  expect(missing.documents).toEqual([]);
  expect(missing.diagnostics).toHaveLength(1);
  await writeFile(join(root, "outside"), "outside");
  await symlink("outside", join(root, "linked.md"));
  await symlink("absent", join(root, "dangling"));
  const found = await agentSource("home", root).snapshot();
  expect(found.documents).toEqual([]);
  expect(found.diagnostics).toHaveLength(2);
  await expect(
    agentSource("home", join(root, "dangling")).snapshot(),
  ).rejects.toThrow(/without links/);
  await expect(
    agentSource("home", join(root, "outside")).snapshot(),
  ).rejects.toThrow(/directory/);
  const other = await temp();
  await symlink(other, join(root, "alias"));
  await expect(
    agentSource("home", join(root, "alias")).snapshot(),
  ).rejects.toThrow(/without links/);
});
it("bounds attempted agent records, diagnostics, bytes and strict UTF-8", async () => {
  const root = await temp();
  await writeFile(join(root, "huge.md"), "x".repeat(256 * 1024 + 1));
  await writeFile(join(root, "invalid.md"), Buffer.from([255]));
  await mkdir(join(root, "directory.md"));
  const found = await agentSource("home", root).snapshot();
  expect(found.documents).toEqual([]);
  expect(found.diagnostics).toHaveLength(3);
  for (let index = 0; index < 514; index++) {
    await writeFile(
      join(root, `candidate-${String(index).padStart(3, "0")}.MD`),
      "invalid candidate",
    );
  }
  const bounded = await agentSource("home", root).snapshot();
  expect(bounded.documents).toEqual([]);
  expect(bounded.diagnostics).toHaveLength(512);
});

it("hashes exact agent file bytes, including BOM and CRLF, without changing manifest decoding", async () => {
  const root = await temp();
  const bytes = Buffer.from(
    "\uFEFF---\r\nname: scout\r\ndescription: Scout\r\n---\r\nPrompt\r\n",
  );
  await writeFile(join(root, "scout.md"), bytes);
  const found = await agentSource("home", root, (path, contentHash) => ({
    kind: "directory",
    source: "home",
    path,
    contentHash,
  })).snapshot();
  expect(found.diagnostics).toEqual([]);
  expect(found.documents[0].manifest).toBe(bytes.toString("utf8").slice(1));
  expect(found.documents[0].origin?.contentHash).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
});
