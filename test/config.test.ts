import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";

const base = {
  agent: "kaeno",
  templates: {
    kaeno: { description: "d", model: "anthropic/claude-sonnet-5-5", instructions: "i", delegates: ["worker"] },
    worker: { description: "d", model: "openai/gpt-5.4-mini", instructions: "i", sandbox: true, tools: ["bash", "read"] },
  },
};

describe("config", () => {
  it("parses templates with per-template models", () => {
    const c = parseConfig(base);
    expect(c.templates.worker!.model).toEqual({ provider: "openai", modelId: "gpt-5.4-mini" });
    expect(c.templates.kaeno!.sandbox).toBe(false);
  });
  it("rejects unknown providers, unknown delegates, and coding tools outside a sandbox", () => {
    expect(() => parseConfig({ ...base, templates: { ...base.templates, kaeno: { ...base.templates.kaeno, model: "faux/x" } } })).toThrow(/model/);
    expect(() => parseConfig({ ...base, templates: { ...base.templates, kaeno: { ...base.templates.kaeno, delegates: ["nope"] } } })).toThrow(/unknown template nope/);
    expect(() => parseConfig({ ...base, templates: { ...base.templates, kaeno: { ...base.templates.kaeno, tools: ["bash"] } } })).toThrow(/sandbox/);
  });
});
