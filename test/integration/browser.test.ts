import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { conversationId, taskId } from "../mocks/identifiers.ts";
import { expect, it } from "vitest";
import {
  browserExtension,
  BROWSER_TOOLS,
} from "../../src/extensions/browser/index.ts";
import { RemoteExecutionEnv } from "../../src/extensions/execution/index.ts";

it("discovers real official MCP schemas and registers model-visible tools", async () => {
  const extension = await browserExtension();
  expect(extension.durable.tools?.map((tool) => tool.name)).toEqual(
    BROWSER_TOOLS,
  );
  const navigate = extension.durable.tools?.[0];
  expect(navigate?.parameters).toMatchObject({
    type: "object",
    required: ["url"],
  });
  await expect(
    navigate?.execute(
      { url: "https://example.com" },
      apiWithEnvironment(undefined),
      BACKGROUND_CONTEXT,
    ),
  ).rejects.toThrow("host execution is forbidden");
});
it("routes to sandbox and forwards bounded text and screenshot images", async () => {
  const extension = await browserExtension();
  let requested = "";
  let requestBody: unknown;
  const env = new RemoteExecutionEnv(
    "http://sandbox",
    "secret",
    "work",
    "/workspace",
    async (url, options) => {
      requested = String(url);
      requestBody = JSON.parse(String(options?.body));
      return new Response(
        JSON.stringify({
          ret: {
            content: [
              { type: "text", text: "x".repeat(50_000) },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
          },
        }) + "\n",
      );
    },
  );
  const result = await extension.durable.tools?.[0].execute(
    { url: "https://example.com" },
    apiWithEnvironment(env),
    BACKGROUND_CONTEXT,
  );
  expect(requested).toBe("http://sandbox/browser");
  expect(requestBody).toMatchObject({
    name: "browser_navigate",
    arguments: { url: "https://example.com" },
  });
  expect(requestBody).not.toHaveProperty("proxy");
  expect(result?.content?.[0]).toEqual({
    type: "text",
    text: "x".repeat(32_768),
  });
  expect(result?.content?.[1]).toEqual({
    type: "image",
    data: "aGVsbG8=",
    mimeType: "image/png",
  });
  expect(result?.content?.at(-1)).toMatchObject({
    text: expect.stringContaining("truncated"),
  });
});

function apiWithEnvironment(env: ToolExecutionApi["env"]): ToolExecutionApi {
  async function unexpected(): Promise<never> {
    throw new Error("Unexpected tool API operation");
  }
  return {
    env,
    taskId: taskId(1),
    conversationId: conversationId(1),
    callId: "browser-test",
    get registry(): never {
      throw new Error("Unexpected registry");
    },
    get models(): never {
      throw new Error("Unexpected models");
    },
    outputWindow: undefined,
    agent: unexpected,
    output: () => {},
    diagnostic: () => {},
    details: unexpected,
    commit: unexpected,
    memo: unexpected,
    createTask: unexpected,
    getTask: unexpected,
    waitForTask: unexpected,
    conversation: unexpected,
    watchDoc: unexpected,
    snapshot: unexpected,
    snapshotAsOf: unexpected,
  };
}
