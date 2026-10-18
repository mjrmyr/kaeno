import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { assertSetupFits } from "./index.ts";
const tool = defineTool({
  name: "read",
  description: "Read",
  parameters: Type.Object({}),
  execute: async () => ({}),
});
const extension = defineExtension({ name: "reader", tools: [tool] });
it("validates exact tool selection against the host-provided surface", () => {
  const surface = {
    tools: new Map([[tool.name, { tool, extension }]]),
    extensions: new Map([[extension.name, extension]]),
  };
  expect(() =>
    assertSetupFits(
      "worker",
      {
        model: { provider: "openai", modelId: "x" },
        instructions: "",
        tools: [],
      },
      surface,
    ),
  ).not.toThrow();
  expect(() =>
    assertSetupFits(
      "worker",
      {
        model: { provider: "openai", modelId: "x" },
        instructions: "",
        tools: ["bash"],
      },
      surface,
    ),
  ).toThrow(/not available/);
  expect(() =>
    assertSetupFits(
      "worker",
      {
        model: { provider: "openai", modelId: "x" },
        instructions: "",
        bindings: [{ owner: "missing", version: 1, value: null }],
      },
      surface,
    ),
  ).toThrow(/not installed/);
});
