import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { directorySource, parseManifest, readManifestFile } from "./index.ts";
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
