import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "./index.ts";
vi.mock("../skills/index.ts", () => ({
  parseSkillRepositories: vi.fn<(raw: unknown) => []>().mockReturnValue([]),
  parseSkillSelection: vi.fn<(raw: unknown) => []>().mockReturnValue([]),
}));
vi.mock("../sandboxes/index.ts", () => ({
  parseSandboxResources: vi.fn<(raw: unknown) => unknown>((raw) => {
    if (raw === "bad") {
      throw new Error("sandboxResources: bad");
    }
    return raw;
  }),
}));
const base = {
  agent: "kaeno",
  sandboxResources: "sized",
  templates: {
    kaeno: {
      description: "d",
      model: "anthropic/claude-sonnet-5-5",
      instructions: "i",
      delegates: ["worker"],
    },
    worker: {
      description: "d",
      model: "openai/gpt-5.4-mini",
      instructions: "i",
    },
  },
};
describe("config", () => {
  it("parses templates with per-template models", () => {
    const content = parseConfig(base);
    expect(content.templates.worker.model).toEqual({
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });
    expect(content.maxDepth).toBe(2);
    expect(content.sandboxResources).toBe("sized");
    expect(
      parseConfig({ ...base, maxDepth: 1, sandboxResources: "custom" }),
    ).toMatchObject({ maxDepth: 1, sandboxResources: "custom" });
  });
  it("rejects unknown providers, unknown delegates, removed execution switches and invalid limits", () => {
    expect(() =>
      parseConfig({
        ...base,
        templates: {
          ...base.templates,
          kaeno: { ...base.templates.kaeno, model: "faux/x" },
        },
      }),
    ).toThrow(/model/);
    expect(() =>
      parseConfig({
        ...base,
        templates: {
          ...base.templates,
          kaeno: { ...base.templates.kaeno, delegates: ["nope"] },
        },
      }),
    ).toThrow(/unknown template nope/);
    expect(() =>
      parseConfig({
        ...base,
        templates: {
          ...base.templates,
          kaeno: { ...base.templates.kaeno, tools: ["bash"] },
        },
      }),
    ).toThrow(/tools/);
    expect(() =>
      parseConfig({
        ...base,
        templates: {
          ...base.templates,
          kaeno: { ...base.templates.kaeno, sandbox: true },
        },
      }),
    ).toThrow(/sandbox/);
    expect(() => parseConfig({ ...base, maxDepth: 0 })).toThrow(/maxDepth/);
    expect(() => parseConfig({ ...base, sandboxResources: "bad" })).toThrow(
      "Invalid kaeno config: sandboxResources: bad",
    );
    const { sandboxResources: _, ...unsized } = base;
    expect(() => parseConfig(unsized)).toThrow(/sandboxResources/);
    // Removed and misspelled top-level settings fail loudly instead of being ignored.
    expect(() => parseConfig({ ...base, sandboxCapacity: 4 })).toThrow(
      /sandboxCapacity/,
    );
  });
});
