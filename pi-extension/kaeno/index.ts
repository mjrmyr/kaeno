// pi provider extension: use kaeno (the durable homelab orchestrator) as a model in pi.
// Each pi session maps to one durable kaeno thread ("pi:<sessionId>"); kaeno keeps the conversation, so only the
// newest user message is sent. Kaeno's live trace (its reasoning, delegations and the sub-agents' tool calls) streams
// into pi's thinking block; kaeno's answer is the reply. Closing pi never stops the work: re-asking resumes it.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Api, type AssistantMessage, type AssistantMessageEventStream, createAssistantMessageEventStream,
  type Model, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = process.env.KAENO_URL ?? "http://homelab-kaeno:8080";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const textOf = (content: unknown) => typeof content === "string" ? content
  : Array.isArray(content) ? content.flatMap((p: any) => (p?.type === "text" ? [p.text] : [])).join("") : "";

function streamKaeno(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output: AssistantMessage = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "pending", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    try {
      const users = context.messages.filter(m => m.role === "user");
      const text = textOf(users.at(-1)?.content).trim();
      if (!text) throw new Error("Nothing to send to kaeno");
      const session = options?.sessionId ?? sha(textOf(users[0]?.content)).slice(0, 32);
      // Same session + position + text → same requestId, so a retry resumes the same durable turn.
      const requestId = `pi-${sha(`${session}\n${users.length}\n${text}`).slice(0, 40)}`;
      const response = await fetch(`${BASE_URL}/v1/threads/pi:${encodeURIComponent(session)}/turn`, {
        method: "POST", signal: options?.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${options?.apiKey ?? ""}` },
        body: JSON.stringify({ text, requestId }),
      });
      if (!response.ok || !response.body) throw new Error(`kaeno: HTTP ${response.status} ${await response.text()}`);
      stream.push({ type: "start", partial: output });
      const thinking = { type: "thinking" as const, thinking: "" };
      output.content.push(thinking);
      stream.push({ type: "thinking_start", contentIndex: 0, partial: output });

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "", answer: string | undefined;
      while (answer === undefined) {
        const { value, done } = await reader.read();
        if (done) throw new Error("kaeno closed the stream before answering (the work continues; ask again to resume)");
        buffer += value;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const frame = JSON.parse(buffer.slice(0, nl) || "{}"); buffer = buffer.slice(nl + 1);
          if (frame.type === "trace") {
            const delta = `${frame.text}\n`;
            thinking.thinking += delta;
            stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: output });
          } else if (frame.type === "done") answer = String(frame.text ?? "");
          else if (frame.type === "error") throw new Error(frame.message);
        }
      }
      await reader.cancel().catch(() => {});
      stream.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial: output });
      output.content.push({ type: "text", text: answer });
      stream.push({ type: "text_start", contentIndex: 1, partial: output });
      stream.push({ type: "text_delta", contentIndex: 1, delta: answer, partial: output });
      stream.push({ type: "text_end", contentIndex: 1, content: answer, partial: output });
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
    }
    stream.end();
  })();
  return stream;
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("kaeno", {
    baseUrl: BASE_URL,
    apiKey: `!cat ${join(homedir(), ".config", "kaeno", "token")}`,
    api: "kaeno-thread",
    models: [{
      id: "kaeno", name: "Kaeno (homelab orchestrator)", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 64_000,
    }],
    streamSimple: streamKaeno,
  });
}
