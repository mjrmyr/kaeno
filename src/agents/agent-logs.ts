import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import {
  GenerationTask,
  ToolTask,
  hook,
  type HookApi,
  type HookRegistration,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ArtifactStore,
  TRACE_FILE,
  type RunIdentity,
} from "../artifacts/index.ts";
import type { AgentState } from "./agent-state.ts";
const MAX_CONTENT = 8192;
/** Durable second destination for trace events: one line per event under the run's artifact directory. */
export interface AgentTraceSink {
  append(identity: RunIdentity, line: string): void;
}
export class AgentTraceFileSink implements AgentTraceSink {
  private readonly store: ArtifactStore;
  constructor(store: ArtifactStore) {
    this.store = store;
  }
  append(identity: RunIdentity, line: string): void {
    try {
      const directory = this.store.runDirectory(identity);
      mkdirSync(directory, { recursive: true });
      appendFileSync(join(directory, TRACE_FILE), `${line}\n`);
    } catch {
      // Recovery: discard an observability failure; never turn it into an agent/task failure.
    }
  }
}
export interface AgentTraceContext {
  conversationId: number;
  taskId: number;
  role?: string;
  template?: string;
  workId?: number;
  sandbox?: {
    pod: string;
    token: string;
  };
}
export function redactAgentLog(
  text: string,
  secrets: readonly string[],
): string {
  for (const secret of [...new Set(secrets)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)) {
    text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(?:github_pat_|gh[pousr]_|sk-)[A-Za-z0-9_-]{16,}/g,
      "[REDACTED]",
    )
    .replace(/\bBearer\s+[^\s"'\\]+/gi, "Bearer [REDACTED]")
    .replace(
      /("(?:token|password|secret|api[_-]?key|private[_-]?key)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[REDACTED]"',
    );
}
export class AgentTraceLogger {
  private readonly write: (line: string) => void;
  private readonly secrets: readonly string[];
  private readonly durable?: AgentTraceSink;
  constructor(
    write: (line: string) => void,
    secrets: readonly string[],
    durable?: AgentTraceSink,
  ) {
    this.write = write;
    this.secrets = secrets;
    this.durable = durable;
  }
  private writeEvent(
    ctx: AgentTraceContext,
    event: string,
    content = "",
    fields: Record<string, unknown> = {},
  ): void {
    try {
      const safe = redactAgentLog(content, [
        ...this.secrets,
        ctx.sandbox?.token ?? "",
      ]);
      const base = {
        type: "agent_trace",
        time: new Date().toISOString(),
        event,
        conversationId: ctx.conversationId,
        taskId: ctx.taskId,
        role: ctx.role ?? "unknown",
        agent: ctx.template,
        workId: ctx.workId,
        pod: ctx.sandbox?.pod,
        ...fields,
      };
      const line = (limit?: number): string => {
        let content: Record<string, unknown> = {};
        if (safe !== "") {
          if (limit === undefined || safe.length <= limit) {
            content = { content: safe };
          } else {
            content = { content: safe.slice(0, limit), truncated: true };
          }
        }
        return JSON.stringify({ ...base, ...content });
      };
      this.write(line(MAX_CONTENT));
      // The durable sink keeps the full event; conversations without a work id have
      // no artifacts directory, so there is nowhere to append them.
      if (this.durable !== undefined && ctx.workId !== undefined) {
        // The run directory is keyed by the work's own task id (captureForPod uses
        // {workId, taskId: workId}); ctx.taskId is the ephemeral per-turn generation
        // task and would fragment the trace across throwaway directories.
        this.durable.append({ workId: ctx.workId, taskId: ctx.workId }, line());
      }
    } catch {
      // Recovery: discard an observability failure; never turn it into an agent/task failure.
    }
  }
  logModelRequest(ctx: AgentTraceContext): void {
    this.writeEvent(ctx, "model_request");
  }
  logModelResponse(ctx: AgentTraceContext, message: AssistantMessage): void {
    const fields = {
      provider: message.provider,
      model: message.model,
      stopReason: message.stopReason,
    };
    for (const block of message.content) {
      switch (block.type) {
        case "thinking":
          this.writeEvent(ctx, "thinking", block.thinking, fields);
          break;
        case "text":
          this.writeEvent(ctx, "text", block.text, fields);
          break;
        case "toolCall":
          this.writeEvent(ctx, "tool_call", JSON.stringify(block.arguments), {
            ...fields,
            tool: block.name,
            toolCallId: block.id,
          });
          break;
      }
    }
    this.writeEvent(ctx, "model_response", message.errorMessage ?? "", fields);
  }
  logToolStart(ctx: AgentTraceContext, call: ToolCall): void {
    this.writeEvent(ctx, "tool_start", JSON.stringify(call.arguments), {
      tool: call.name,
      toolCallId: call.id,
    });
  }
  logToolEnd(
    ctx: AgentTraceContext,
    call: ToolCall,
    result: ToolExecutionResult,
  ): void {
    const content = (result.content ?? [])
      .map((block) =>
        block.type === "text" ? block.text : `[${block.type} omitted]`,
      )
      .join("\n");
    this.writeEvent(ctx, "tool_end", content, {
      tool: call.name,
      toolCallId: call.id,
      isError: Boolean(result.isError),
    });
  }
}
export function agentLogHooks(
  stateDoc: typeof AgentState,
  logger: AgentTraceLogger,
): HookRegistration[] {
  async function trace(
    api: HookApi,
    ctx: Context,
    log: (fields: AgentTraceContext) => void,
  ): Promise<void> {
    try {
      const state = await api.snapshot(stateDoc, api.conversationId, ctx);
      log({
        conversationId: api.conversationId,
        taskId: api.taskId,
        role: state?.role,
        template: state?.template,
        workId: state?.workId,
        sandbox: state?.sandbox,
      });
    } catch {
      // Recovery: unavailable correlation metadata must not block model or tool execution.
    }
  }
  return [
    hook(GenerationTask, {
      beforeRequest: async (_request, api, ctx) => {
        await trace(api, ctx, (fields) => logger.logModelRequest(fields));
        return undefined;
      },
      afterResponse: async (message, api, ctx) => {
        await trace(api, ctx, (fields) =>
          logger.logModelResponse(fields, message),
        );
      },
    }),
    hook(ToolTask, {
      beforeTool: async (call, api, ctx) => {
        await trace(api, ctx, (fields) => logger.logToolStart(fields, call));
        return undefined;
      },
      afterTool: async (call, result, api, ctx) => {
        await trace(api, ctx, (fields) =>
          logger.logToolEnd(fields, call, result),
        );
        return undefined;
      },
    }),
  ];
}
