import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AgentTraceLogger,
  redactAgentLog,
  type AgentTraceContext,
} from "./index.ts";
vi.mock("@earendil-works/pi-durable", async () => {
  const { createMockSdk } = await import("../../test/mocks/sdk.ts");
  return createMockSdk();
});
vi.mock("@earendil-works/pi-durable/tools", () => ({
  CodingTools: { name: "coding-tools", tools: [] },
}));
const context: AgentTraceContext = {
  conversationId: 12,
  taskId: 34,
  role: "worker",
  template: "swe",
  workId: 56,
  sandbox: { pod: "kaeno-sb-test", token: "sandbox-secret-value" },
};
function message(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "faux",
    provider: "faux",
    model: "faux-1",
    timestamp: 0,
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function setup(): {
  logger: AgentTraceLogger;
  records: Record<string, unknown>[];
} {
  const records: Record<string, unknown>[] = [];
  const logger = new AgentTraceLogger(
    (line) =>
      records.push(z.record(z.string(), z.unknown()).parse(JSON.parse(line))),
    ["known-provider-secret"],
  );
  return { logger, records };
}
it("logs correlation and public content, but not opaque signatures, images or private details", () => {
  const { logger, records } = setup();
  logger.logModelRequest(context);
  logger.logModelResponse(
    context,
    message([
      {
        type: "thinking",
        thinking: "Reasoning known-provider-secret",
        thinkingSignature: "OPAQUE SIGNATURE",
      },
      { type: "text", text: "Result sandbox-secret-value" },
    ]),
  );
  const call: ToolCall = {
    type: "toolCall",
    id: "call-1",
    name: "bash",
    arguments: {
      command: "echo known-provider-secret",
      password: "unknown-secret",
    },
  };
  const result: ToolExecutionResult = {
    content: [
      { type: "text", text: "sandbox-secret-value" },
      { type: "image", data: "IMAGE BYTES", mimeType: "image/png" },
    ],
    details: { secret: "PRIVATE DETAILS" },
    isError: true,
  };
  logger.logToolStart(context, call);
  logger.logToolEnd(context, call, result);
  expect(records.map((record) => record.event)).toEqual([
    "model_request",
    "thinking",
    "text",
    "model_response",
    "tool_start",
    "tool_end",
  ]);
  expect(
    records.every(
      (record) =>
        record.conversationId === 12 &&
        record.taskId === 34 &&
        record.role === "worker" &&
        record.workId === 56,
    ),
  ).toBe(true);
  expect(records.at(-1)).toMatchObject({
    tool: "bash",
    toolCallId: "call-1",
    isError: true,
  });
  for (const secret of [
    "known-provider-secret",
    "sandbox-secret-value",
    "unknown-secret",
    "OPAQUE SIGNATURE",
    "IMAGE BYTES",
    "PRIVATE DETAILS",
  ]) {
    expect(JSON.stringify(records)).not.toContain(secret);
  }
  expect(result.content?.[0]).toEqual({
    type: "text",
    text: "sandbox-secret-value",
  });
});
it("redacts before truncation and bounds log content", () => {
  const { logger, records } = setup();
  logger.logModelResponse(
    context,
    message([
      {
        type: "text",
        text: "x".repeat(8188) + "known-provider-secret" + "y".repeat(500),
      },
    ]),
  );
  expect(records[0].content).toHaveLength(8192);
  expect(records[0].truncated).toBe(true);
  expect(records[0].content).not.toContain("known-");
  const githubToken = "github_pat_" + "a".repeat(40);
  const apiKey = "sk-ant-" + "b".repeat(40);
  expect(
    redactAgentLog(
      `Bearer unknown-credential ${githubToken} ${apiKey} -----BEGIN OPENSSH PRIVATE KEY-----\nprivate\n-----END OPENSSH PRIVATE KEY-----`,
      [],
    ),
  ).toBe("Bearer [REDACTED] [REDACTED] [REDACTED] [REDACTED PRIVATE KEY]");
});
it("recovers from a failed log sink without failing the caller", () => {
  const logger = new AgentTraceLogger(() => {
    throw new Error("broken stdout");
  }, []);
  expect(() => logger.logModelRequest(context)).not.toThrow();
  expect(() =>
    logger.logModelResponse(
      context,
      message([{ type: "text", text: "response" }]),
    ),
  ).not.toThrow();
});
