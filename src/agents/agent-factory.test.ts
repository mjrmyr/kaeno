import { defineExtension } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import type { Template } from "../work/index.ts";
import { AgentFactory } from "./index.ts";

const template: Omit<Template, "name"> = {
  description: "Worker",
  model: { provider: "openrouter", modelId: "openai/gpt-6-luna" },
  instructions: "Complete the brief.",
  delegates: [],
  skills: [],
};
function factory() {
  return new AgentFactory(
    {
      maxDepth: 2,
      templates: {
        easy: { ...template, name: "easy" },
        medium: { ...template, name: "medium" },
        high: { ...template, name: "high", delegates: ["easy"] },
      },
    },
    { bindSkills: () => [] },
    {
      extension: defineExtension({ name: "test.work" }),
      orchestrationTools: [],
      parentTools: [],
    },
  );
}

it.each(["easy", "medium", "high"])(
  "captures any configured worker directly: %s",
  (name) => {
    const blueprint = factory().captureWorkBlueprint(
      name,
      { execution: "sandbox:test" },
      "local",
    );
    expect(blueprint.agent).toBe(name);
    expect(blueprint.templates[name].template.name).toBe(name);
  },
);

it("captures only the selected worker's child-delegation graph", () => {
  const blueprint = factory().captureWorkBlueprint(
    "high",
    { execution: "sandbox:test" },
    "local",
  );
  expect(Object.keys(blueprint.templates)).toEqual(["high", "easy"]);
  expect(blueprint.templates.high.template.delegates).toEqual(["easy"]);
});

it("rejects an unknown worker", () => {
  expect(() =>
    factory().captureWorkBlueprint(
      "missing",
      { execution: "sandbox:test" },
      "local",
    ),
  ).toThrow('Unknown agent template "missing"');
});
