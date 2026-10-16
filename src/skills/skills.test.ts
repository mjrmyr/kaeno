import { expect, it } from "vitest";
import {
  parseSandboxImages,
  parseSkillRepositories,
  parseSkillSelection,
  readSkillDocument,
  ResolvedSkillCatalog,
  skillPrompt,
  splitSkillId,
  type BoundSkill,
} from "./index.ts";
it("normalizes repository identities and retains explicitly pinned refs", () => {
  expect(parseSkillRepositories(["Demo/Skills:v1", "demo/other"])).toEqual([
    { id: "demo/skills", ref: "v1" },
    { id: "demo/other" },
  ]);
});
it.each([
  null,
  "demo/skills",
  ["demo/skills:-flag"],
  ["demo/skills:../main"],
  ["demo/skills:a b"],
  ["demo/skills", "Demo/Skills"],
])("rejects malformed or duplicate repository inputs (%j)", (value) => {
  expect(() => parseSkillRepositories(value)).toThrow(/Skills/);
});
it("keeps explicit skill order and rejects undeclared repositories", () => {
  const repositories = [{ id: "demo/skills" }];
  expect(
    parseSkillSelection(
      ["demo/skills:first", "demo/skills:second"],
      repositories,
    ),
  ).toEqual(["demo/skills:first", "demo/skills:second"]);
  expect(() =>
    parseSkillSelection(["other/skills:guide"], repositories),
  ).toThrow(/Skills/);
  expect(splitSkillId("demo/skills:guide")).toEqual({
    id: "demo/skills:guide",
    repository: "demo/skills",
    name: "guide",
  });
});
const bindings: BoundSkill[] = [
  {
    id: "demo/skills:guide",
    description: "Guide",
    disableModelInvocation: false,
    repositoryCommit: "a".repeat(40),
    treeHash: "b".repeat(64),
    sandboxRoot: "/workspace/guide",
    documents: {
      "SKILL.md": "Instructions",
      "references/help.md": "Reference",
    },
  },
];
it("loads only assigned documents and hides disabled skills from automatic prompts", () => {
  expect(skillPrompt(bindings)).toContain("demo/skills:guide");
  expect(
    skillPrompt([{ ...bindings[0], disableModelInvocation: true }]),
  ).toBeUndefined();
  expect(
    readSkillDocument(bindings, { skill: "demo/skills:guide" }),
  ).toMatchObject({ text: "Instructions" });
});
it("requires digest-qualified execution images", () => {
  const execution = `ghcr.io/example/sandbox@sha256:${"a".repeat(64)}`;
  expect(parseSandboxImages({ execution })).toEqual({ execution });
  expect(() =>
    parseSandboxImages({ execution: "ghcr.io/example/sandbox:latest" }),
  ).toThrow(/digest/);
});
it("expands assigned selectors once and returns independent binding data", () => {
  const catalog = new ResolvedSkillCatalog(
    new Map(bindings.map((binding) => [binding.id, binding])),
  );
  const binding = catalog.bindSkills(["demo/skills:*", "demo/skills:guide"]);
  expect(binding).toHaveLength(1);
  binding[0].documents["SKILL.md"] = "changed";
  expect(
    catalog.bindSkills(["demo/skills:guide"])[0].documents["SKILL.md"],
  ).toBe("Instructions");
  expect(() => catalog.bindSkills(["demo/skills:missing"])).toThrow(
    /not present/,
  );
});
it.each([
  "../outside",
  "/outside",
  "references/../help.md",
  "missing.md",
  "references\\help.md",
])("rejects unavailable or escaping skill document %s", (file) => {
  expect(() =>
    readSkillDocument(bindings, { skill: "demo/skills:guide", file }),
  ).toThrow(/Skills/);
});
