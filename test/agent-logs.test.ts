import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai/providers/faux";
import { AgentState } from "../src/agents.ts";
import { agentLogHooks, redactAgentLog } from "../src/agent-logs.ts";

function setup(write?: (line: string) => void) {
  const records: any[] = [];
  const hooks = agentLogHooks(AgentState, write ?? (line => records.push(JSON.parse(line))), ["known-provider-secret"]);
  const generation = hooks[0]!.handlers as any, tool = hooks[1]!.handlers as any;
  const api = { conversationId: 12, taskId: 34, snapshot: async () => ({ role: "worker", template: "swe", workId: 56,
    sandbox: { pod: "kaeno-sb-test", token: "sandbox-secret-value" } }) } as any;
  return { records, generation, tool, api };
}

it("logs exposed thinking/text and tool activity with correlation, without signatures, images or secret values", async () => {
  const { records, generation, tool, api } = setup();
  const message = fauxAssistantMessage([fauxThinking("Reasoning known-provider-secret"), fauxText("Result sandbox-secret-value")]);
  (message.content[0] as any).thinkingSignature = "OPAQUE SIGNATURE";
  expect(await generation.beforeRequest({}, api, ctx)).toBeUndefined();
  await generation.afterResponse(message, api, ctx);
  const call = { id: "call-1", name: "bash", arguments: { command: "echo known-provider-secret", password: "unknown-secret" } };
  expect(await tool.beforeTool(call, api, ctx)).toBeUndefined();
  const result = { content: [{ type: "text", text: "sandbox-secret-value" }, { type: "image", data: "IMAGE BYTES" }],
    details: { secret: "PRIVATE DETAILS" }, isError: true };
  expect(await tool.afterTool(call, result, api, ctx)).toBeUndefined();
  expect(result.content[0]!.text).toBe("sandbox-secret-value"); // no mutation of tool results
  expect(records.map(r => r.event)).toEqual(["model_request", "thinking", "text", "model_response", "tool_start", "tool_end"]);
  expect(records.every(r => r.conversationId === 12 && r.taskId === 34 && r.role === "worker" && r.workId === 56)).toBe(true);
  expect(records[1]).toMatchObject({ provider: message.provider, model: message.model, content: "Reasoning [REDACTED]" });
  expect(records.at(-1)).toMatchObject({ tool: "bash", toolCallId: "call-1", isError: true });
  const serialized = JSON.stringify(records);
  for (const secret of ["known-provider-secret", "sandbox-secret-value", "unknown-secret", "OPAQUE SIGNATURE", "IMAGE BYTES", "PRIVATE DETAILS"])
    expect(serialized).not.toContain(secret);
});

it("redacts common external credentials before truncating and bounds content", async () => {
  const gh = "github_pat_" + "a".repeat(40), key = "sk-ant-" + "b".repeat(40);
  expect(redactAgentLog(`Bearer unknown-credential ${gh} ${key} -----BEGIN OPENSSH PRIVATE KEY-----\nprivate\n-----END OPENSSH PRIVATE KEY-----`, []))
    .toBe("Bearer [REDACTED] [REDACTED] [REDACTED] [REDACTED PRIVATE KEY]");
  const { records, generation, api } = setup();
  await generation.afterResponse(fauxAssistantMessage("x".repeat(8188) + "known-provider-secret" + "y".repeat(500)), api, ctx);
  expect(records[0].content).toHaveLength(8192);
  expect(records[0].truncated).toBe(true);
  expect(records[0].content).not.toContain("known-");
});

it("logging failures never block requests/tools or replace their results", async () => {
  const { generation, tool, api } = setup(() => { throw new Error("broken stdout"); });
  const call = { id: "id", name: "read", arguments: { path: "file" } };
  expect(await generation.beforeRequest({}, api, ctx)).toBeUndefined();
  await generation.afterResponse(fauxAssistantMessage("response"), api, ctx);
  expect(await tool.beforeTool(call, api, ctx)).toBeUndefined();
  expect(await tool.afterTool(call, {}, api, ctx)).toBeUndefined();
  api.snapshot = async () => { throw new Error("closing storage"); };
  expect(await tool.beforeTool(call, api, ctx)).toBeUndefined();
});

it("preserves the agent envelope and every event on stdout, separate from operational logging", async () => {
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { api } = setup();
    const hooks = agentLogHooks(AgentState, undefined, ["known-provider-secret"]);
    const generation = hooks[0]!.handlers as any, tool = hooks[1]!.handlers as any;
    const message = fauxAssistantMessage([fauxThinking("thinking known-provider-secret"), fauxText("text sandbox-secret-value")]);
    const call = { type: "toolCall", id: "call-2", name: "bash", arguments: { password: "unknown-secret" } };
    (message.content as any[]).push(call);
    await generation.beforeRequest({}, api, ctx);
    await generation.afterResponse(message, api, ctx);
    await tool.beforeTool(call, api, ctx);
    await tool.afterTool(call, { content: [{ type: "text", text: "sandbox-secret-value" }] }, api, ctx);
    expect(stderr).not.toHaveBeenCalled();
    const records = stdout.mock.calls.map(args => {
      expect(args).toHaveLength(1);
      expect(args[0]).not.toMatch(/[\r\n]/);
      return JSON.parse(args[0]);
    });
    expect(records.map(r => r.event)).toEqual(["model_request", "thinking", "text", "tool_call", "model_response", "tool_start", "tool_end"]);
    expect(records[0]).toEqual({ type: "agent_trace", time: expect.any(String), event: "model_request",
      conversationId: 12, taskId: 34, role: "worker", agent: "swe", workId: 56, pod: "kaeno-sb-test" });
    for (const record of records) {
      expect(new Date(record.time).toISOString()).toBe(record.time);
      expect(record.type).toBe("agent_trace");
      for (const key of ["level", "component", "context", "timestamp"]) expect(record).not.toHaveProperty(key);
    }
    expect(records[1].content).toBe("thinking [REDACTED]");
    expect(records[2].content).toBe("text [REDACTED]");
    expect(records[3]).toMatchObject({ tool: "bash", toolCallId: "call-2", content: '{"password":"[REDACTED]"}' });
    expect(records[6]).toMatchObject({ isError: false, content: "[REDACTED]" });
    for (const secret of ["known-provider-secret", "sandbox-secret-value", "unknown-secret"])
      expect(JSON.stringify(records)).not.toContain(secret);
  } finally { stdout.mockRestore(); stderr.mockRestore(); }
});

it("retains legacy correlation when the snapshot has no agent state", async () => {
  const { records, generation, api } = setup();
  api.snapshot = async () => undefined;
  await generation.beforeRequest({}, api, ctx);
  expect(records).toEqual([{ type: "agent_trace", time: expect.any(String), event: "model_request",
    conversationId: 12, taskId: 34, role: "legacy" }]);
});
