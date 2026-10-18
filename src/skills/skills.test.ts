import { expect, it } from "vitest";
import {
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
it("only reads assigned text and hides disabled skills from automatic discovery", () => {
  expect(readSkillDocument([skill], { skill: "guide" })).toBe("Instructions");
  expect(skillPrompt([skill])).toContain("home:guide");
  expect(
    skillPrompt([{ ...skill, disableModelInvocation: true }]),
  ).toBeUndefined();
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
