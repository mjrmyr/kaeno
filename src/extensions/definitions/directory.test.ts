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
    join(pkg, "SKILL.md"),
    "---\nname: reviewer\ndescription: Reviews code\n---\nReview carefully.\n",
  );
  const found = await directorySource("home", root).snapshot("SKILL.md");
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
        "SKILL.md",
      )
    ).packages,
  ).toEqual([]);
});
it("rejects package directory symlinks and manifest symlinks instead of following them", async () => {
  const root = await temp();
  const outside = await temp();
  await writeFile(
    join(outside, "SKILL.md"),
    "---\nname: bad\ndescription: bad\n---\n",
  );
  await symlink(outside, join(root, "linked"));
  const source = await directorySource("x", root).snapshot("SKILL.md");
  expect(source.packages).toEqual([]);
  expect(source.diagnostics).toHaveLength(1);
  await mkdir(join(root, "pkg"));
  await symlink(join(outside, "SKILL.md"), join(root, "pkg/SKILL.md"));
  const withManifestLink = await directorySource("x", root).snapshot(
    "SKILL.md",
  );
  expect(withManifestLink.packages).toEqual([]);
  expect(
    withManifestLink.diagnostics.map(({ message }) => message).join("\n"),
  ).toContain("regular file");
});
it("validates regular manifests and UTF-8 YAML frontmatter", async () => {
  const root = await temp();
  const path = join(root, "SKILL.md");
  await writeFile(path, "---\nname: valid\ndescription: valid\n---\nBody");
  expect(await readManifestFile(path)).toContain("Body");
  await rm(path);
  await mkdir(path);
  await expect(readManifestFile(path)).rejects.toThrow(/regular file/);
  expect(() => parseManifest("Body only", "SKILL.md")).toThrow(/frontmatter/);
  expect(() =>
    parseManifest(
      "---\nname: one\nname: two\ndescription: d\n---\n",
      "SKILL.md",
    ),
  ).toThrow(/duplicate|unique|frontmatter/i);
});

it("bounds skill manifest bytes and rejects invalid UTF-8 without changing BOM/CRLF decoding", async () => {
  const root = await temp();
  for (const name of ["oversized", "invalid", "valid"]) {
    await mkdir(join(root, name));
  }
  await writeFile(join(root, "oversized/SKILL.md"), "x".repeat(256 * 1024 + 1));
  await writeFile(join(root, "invalid/SKILL.md"), Buffer.from([255]));
  const text =
    "---\r\nname: valid\r\ndescription: Valid\r\n---\r\nInstructions\r\n";
  await writeFile(join(root, "valid/SKILL.md"), `\uFEFF${text}`);
  const found = await directorySource("local", root).snapshot("SKILL.md");
  expect(found.packages.map((item) => item.manifest)).toEqual([text]);
  expect(found.diagnostics).toHaveLength(2);
  expect(found.diagnostics.map((item) => item.message).join("\n")).toContain(
    "manifest exceeds",
  );
  expect(parseManifest(found.packages[0].manifest, "SKILL.md").body).toBe(
    "Instructions",
  );
});

it("rejects unsafe aliases and manifest paths before discovery", async () => {
  const root = await temp();
  expect(() => directorySource("../outside", root)).toThrow(/alias/);
  for (const name of ["../SKILL.md", ".", "..", "nested/SKILL.md"]) {
    await expect(directorySource("local", root).snapshot(name)).rejects.toThrow(
      /filename/,
    );
  }
});
