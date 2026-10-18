import { expect, it } from "vitest";
import {
  listSkills,
  readSkillDocument,
  SkillCatalog,
  skillMetadata,
  skillPrompt,
  type BoundSkill,
} from "./index.ts";

const skill: BoundSkill = {
  id: "home:guide",
  description: "Guide",
  disableModelInvocation: false,
  treeHash: "a".repeat(64),
  documents: { "SKILL.md": "Instructions", "references/help.md": "Reference" },
};
it("parses mandatory metadata and leaves future metadata inert", () => {
  expect(
    skillMetadata(
      "---\nname: guide\ndescription: Useful guide\nfuture: true\n---\nInstructions",
      "test",
    ),
  ).toEqual({
    name: "guide",
    description: "Useful guide",
    disableModelInvocation: false,
  });
});
it("returns independent bound snapshots and resolves unambiguous bare references", () => {
  const catalog = new SkillCatalog([skill]);
  const binding = catalog.bind(["guide", "home:guide"]);
  expect(binding).toHaveLength(1);
  binding[0].documents["SKILL.md"] = "changed";
  expect(catalog.bind(["guide"])[0].documents["SKILL.md"]).toBe("Instructions");
  expect(() => catalog.bind(["missing"])).toThrow(/unknown skill/);
});
it("rejects duplicate IDs and ambiguous short names", () => {
  expect(() => new SkillCatalog([skill, skill])).toThrow(/duplicate/);
  const catalog = new SkillCatalog([skill, { ...skill, id: "local:guide" }]);
  expect(() => catalog.bind(["guide"])).toThrow(/ambiguous/);
  expect(catalog.bind(["local:guide"])[0].id).toBe("local:guide");
});
it("lists only assigned, discoverable metadata without bodies or assets", () => {
  expect(
    listSkills([
      skill,
      { ...skill, id: "home:hidden", disableModelInvocation: true },
    ]),
  ).toEqual([{ id: "home:guide", description: "Guide" }]);
  expect(listSkills([])).toEqual([]);
});
it.each([false, true])(
  "uses lazy discovery guidance independently of assigned skills (%s)",
  (assigned) => {
    const prompt = skillPrompt(assigned ? [skill] : [], [
      "list_skills",
      "read_skill",
    ]);
    expect(prompt).toContain("Use list_skills");
    expect(prompt).toContain("Use read_skill");
    expect(prompt).toContain("An empty list means no skills are available");
    expect(prompt).not.toContain("home:guide");
    expect(prompt).not.toContain("Instructions");
  },
);
it("respects explicit tool restrictions in skill guidance", () => {
  expect(skillPrompt([skill], ["read_skill"])).toContain("home:guide");
  expect(skillPrompt([skill], ["read_skill"])).not.toContain("Use list_skills");
  expect(skillPrompt([skill], ["list_skills"])).toContain("Instructions");
  expect(skillPrompt([skill], ["list_skills"])).not.toContain("Use read_skill");
  expect(skillPrompt([skill], [])).toContain("Instructions");
  expect(skillPrompt([skill], [])).not.toContain("Use read_skill");
  expect(
    skillPrompt([{ ...skill, disableModelInvocation: true }], []),
  ).toBeUndefined();
  expect(skillPrompt([], [])).toBeUndefined();
});
it("only reads assigned documents, including explicitly requested non-discoverable skills", () => {
  expect(readSkillDocument([skill], { skill: "guide" })).toBe("Instructions");
  expect(
    readSkillDocument([{ ...skill, disableModelInvocation: true }], {
      skill: "guide",
    }),
  ).toBe("Instructions");
  expect(() => readSkillDocument([], { skill: "guide" })).toThrow(
    /not assigned/,
  );
});
it.each([
  "../outside",
  "/etc/passwd",
  "references/../help.md",
  "references\\help.md",
  "toString",
  "missing.md",
])("rejects unavailable or escaping document %s", (file) => {
  expect(() =>
    readSkillDocument([skill], { skill: "home:guide", file }),
  ).toThrow(/Skills/);
});
