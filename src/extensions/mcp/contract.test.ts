import { expect, it } from "vitest";
import { mcpTools, type McpServer } from "./index.ts";

const read = { description: "Read", inputSchema: { type: "object" as const } };
function server(): McpServer {
  return {
    id: "demo",
    endpoint: "https://example.com/mcp?resource=one",
    headerFiles: {},
    tools: [{ upstream: "read", readOnly: true }, { upstream: "write" }],
    advertised: new Map([
      ["read", read],
      ["write", { description: "Write", inputSchema: { type: "object" } }],
      ["unlisted", read],
    ]),
  };
}
it("projects only allowlisted native tools with independent axes", () => {
  const set = mcpTools(server());
  expect(set.live).toEqual({ tools: ["demo_read", "demo_write"] });
  expect(set.readOnly).toEqual({ tools: ["demo_read"] });
  expect(set.extension.runtime.readOnlyTools).toEqual(["demo_read"]);
  const tools = set.extension.runtime.durable.tools ?? [];
  expect(
    tools.map((tool) => [tool.name, tool.replay, tool.executionMode]),
  ).toEqual([
    ["demo_read", "unsafe", "sequential"],
    ["demo_write", "unsafe", "sequential"],
  ]);
});
it("registers unadvertised allowlisted tools as placeholders outside the defaults", () => {
  const set = mcpTools({
    ...server(),
    tools: [
      { upstream: "read", readOnly: true },
      { upstream: "missing", readOnly: true },
    ],
  });
  expect(set.unavailable).toEqual(["missing"]);
  expect(set.live).toEqual({ tools: ["demo_read"] });
  expect(set.readOnly).toEqual({ tools: ["demo_read", "demo_missing"] });
  const placeholder = set.extension.runtime.durable.tools?.find(
    (tool) => tool.name === "demo_missing",
  );
  expect(placeholder?.description).toContain("Unavailable");
});
it("rejects name collisions", () => {
  const target = server();
  expect(() =>
    mcpTools({
      ...target,
      advertised: new Map([...target.advertised, ["demo_read", read]]),
      tools: [{ upstream: "read" }, { upstream: "demo_read" }],
    }),
  ).toThrow("collision");
});
it("retains native prefixed names and refuses overlong derived names", () => {
  const target = server();
  const set = mcpTools({
    ...target,
    id: "browser",
    tools: [{ upstream: "browser_navigate" }],
    advertised: new Map([["browser_navigate", read]]),
  });
  expect(set.extension.runtime.durable.tools?.map((tool) => tool.name)).toEqual(
    ["browser_navigate"],
  );
  expect(() =>
    mcpTools({
      ...target,
      tools: [{ upstream: "x".repeat(64) }],
      advertised: new Map([["x".repeat(64), read]]),
    }),
  ).toThrow("derived");
});
