import { expect, it } from "vitest";
import { parseConfig } from "./index.ts";
it("parses the tiny model/instructions configuration", () => {
  expect(
    parseConfig({
      model: "openrouter/vendor/model",
      instructions: "Be helpful",
    }),
  ).toEqual({
    model: { provider: "openrouter", modelId: "vendor/model" },
    instructions: "Be helpful",
  });
});
it("rejects unknown fields and malformed models", () => {
  expect(() =>
    parseConfig({ model: "openai/", instructions: "Help" }),
  ).toThrow();
  expect(() =>
    parseConfig({ model: "other/model", instructions: "Help" }),
  ).toThrow();
  expect(() =>
    parseConfig({ model: "openai/model", instructions: "Help", work: false }),
  ).toThrow();
});
