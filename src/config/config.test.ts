import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "./index.ts";
vi.mock("../skills/index.ts", () => ({
  parseSkillRepositories: vi.fn<(raw: unknown) => []>().mockReturnValue([]),
  parseSkillSelection: vi.fn<(raw: unknown) => []>().mockReturnValue([]),
}));
const base = {
  agent: "kaeno",
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
      sandbox: true,
      tools: ["bash", "read"],
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
    expect(content.templates.kaeno.sandbox).toBe(false);
  });
  it("rejects unknown providers, unknown delegates, and coding tools outside a sandbox", () => {
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
    ).toThrow(/sandbox/);
  });
});
