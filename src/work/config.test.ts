import { expect, it } from "vitest";
import { parseWorkConfig } from "./index.ts";

const template = {
  description: "Independent worker",
  model: "openrouter/openai/gpt-6-luna",
  instructions: "Complete the brief and verify the result.",
};

it("accepts independent workers without a root selector or delegation links", () => {
  const config = parseWorkConfig({
    templates: { easy: template, medium: template, high: template },
  });
  expect(Object.keys(config.templates)).toEqual(["easy", "medium", "high"]);
  expect(config.maxDepth).toBe(2);
  expect(config.templates.medium.delegates).toEqual([]);
  expect(config).not.toHaveProperty("agent");
});

it("rejects the removed root selector rather than silently honoring an exposure gate", () => {
  expect(() =>
    parseWorkConfig({ agent: "easy", templates: { easy: template } }),
  ).toThrow();
});

it("still validates worker-to-worker delegation references", () => {
  expect(() =>
    parseWorkConfig({
      templates: { easy: { ...template, delegates: ["missing"] } },
    }),
  ).toThrow("Unknown delegate template missing in easy");
});
