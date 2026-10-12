// Always-on, best-effort stdout traces. Hooks live on Kaeno's existing extension, so they also cover frozen/replayed agents.
import { GenerationTask, ToolTask, hook, type HookApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { AgentState } from "./agents.ts";

const MAX_CONTENT = 8192;

/** Best effort only: arbitrary private information in conversations is still sensitive. */
export function redactAgentLog(text: string, secrets: readonly string[]): string {
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:github_pat_|gh[pousr]_|sk-)[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s"'\\]+/gi, "Bearer [REDACTED]")
    .replace(/("(?:token|password|secret|api[_-]?key|private[_-]?key)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"');
}

export function agentLogHooks(stateDoc: typeof AgentState, write: (line: string) => void = line => console.log(line),
  secrets = Object.entries(process.env).filter(([name]) => /TOKEN|API_KEY|PASSWORD|SECRET|PRIVATE_KEY/i.test(name)).map(([, value]) => value!).filter(Boolean)) {
  async function log(api: HookApi, context: Context, event: string, content = "", fields: Record<string, unknown> = {}) {
    // Observability must never block a tool, change a result, or fail a model request.
    try {
      const state = await api.snapshot(stateDoc, api.conversationId, context);
      const safe = redactAgentLog(content, [...secrets, state?.sandbox?.token ?? ""]);
      write(JSON.stringify({ type: "agent_trace", time: new Date().toISOString(), event,
        conversationId: api.conversationId, taskId: api.taskId, role: state?.role ?? "legacy",
        agent: state?.template, workId: state?.workId, pod: state?.sandbox?.pod, ...fields,
        ...(safe ? { content: safe.slice(0, MAX_CONTENT), ...(safe.length > MAX_CONTENT ? { truncated: true } : {}) } : {}),
      }));
    } catch { /* Logging is best-effort, including during shutdown. */ }
  }
  return [
    hook(GenerationTask, {
      beforeRequest: async (_request, api, context) => { await log(api, context, "model_request"); return undefined; },
      afterResponse: async (message, api, context) => {
        const fields = { provider: message.provider, model: message.model, stopReason: message.stopReason };
        for (const block of message.content) {
          if (block.type === "thinking") await log(api, context, "thinking", block.thinking, fields);
          else if (block.type === "text") await log(api, context, "text", block.text, fields);
          else if (block.type === "toolCall") await log(api, context, "tool_call", JSON.stringify(block.arguments),
            { ...fields, tool: block.name, toolCallId: block.id });
        }
        await log(api, context, "model_response", message.errorMessage ?? "", fields);
      },
    }),
    hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        await log(api, context, "tool_start", JSON.stringify(call.arguments), { tool: call.name, toolCallId: call.id });
        return undefined;
      },
      afterTool: async (call, result, api, context) => {
        const content = (result.content ?? []).map(block => block.type === "text" ? block.text : `[${block.type} omitted]`).join("\n");
        await log(api, context, "tool_end", content, { tool: call.name, toolCallId: call.id, isError: !!result.isError });
        return undefined;
      },
    }),
  ];
}
