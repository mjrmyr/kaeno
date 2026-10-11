// Kaeno's native HTTP API (bearer token, reached over Tailscale). Clients are thin and optional: work is durable in
// kaeno, so a client that disconnects only stops watching; retrying with the same requestId resumes the same turn.
//
//   POST /v1/threads/:key/turn   {text, requestId}  → NDJSON: {type:"trace",text} … then {type:"done",text} | {type:"error",message}
//   POST /v1/threads/:key/abort
//   GET  /v1/threads
//   GET  /healthz
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { watchEvents, type AgentEvent, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { answerText, thread, Threads, type ThreadDeps } from "./threads.ts";

const oneLine = (s: string, max = 200) => { const f = s.replace(/\s+/g, " ").trim(); return f.length > max ? f.slice(0, max - 1) + "…" : f; };

export function describeTool(name: string, args: any): string {
  if (name === "bash") return `$ ${oneLine(String(args?.command ?? ""))}`;
  if (name === "delegate") return `▸ delegating to ${args?.agent}: ${oneLine(String(args?.task ?? ""), 300)}`;
  return oneLine(`${name} ${String(args?.path ?? "")}`);
}

/** Follow a conversation and the sub-agents it delegates to, as human-readable trace lines. */
async function trace(harness: Harness, conversationId: ConversationId, emit: (line: string) => void, label = "") {
  const streams: { stop(): Promise<unknown> }[] = [];
  const attached = new Set<ConversationId>();
  const follow = async (id: ConversationId, prefix: string) => {
    attached.add(id);
    const stream = await watchEvents(harness, id, BACKGROUND_CONTEXT);
    streams.push(stream);
    let text = "";
    stream.start(async (events: readonly AgentEvent[]) => {
      for (const e of events) {
        if (e.type === "message_update") {
          for (const c of e.changes) if (c.type === "text_delta" || c.type === "thinking_delta") text += c.delta;
          // Flush complete lines so the trace reads like a log, not a token stream.
          const nl = text.lastIndexOf("\n");
          if (nl >= 0) { for (const line of text.slice(0, nl).split("\n")) if (line.trim()) emit(`${prefix}${line}`); text = text.slice(nl + 1); }
        } else if (e.type === "message_end") {
          if (text.trim()) emit(`${prefix}${text.trim()}`);
          text = "";
        } else if (e.type === "tool_execution_start") {
          emit(`${prefix}${describeTool(e.toolName, e.args)}`);
        } else if (e.type === "tool_execution_update") {
          const child = (e.details as any)?.conversationId as ConversationId | undefined;
          if (child && !attached.has(child)) await follow(child, `${prefix}  [${(e.details as any).agent}] `);
        } else if (e.type === "tool_execution_end" && e.toolName === "delegate") {
          emit(`${prefix}✓ sub-agent finished`);
        } else if (e.type === "auto_retry_start") {
          emit(`${prefix}(retrying model request: ${oneLine(e.errorMessage, 120)})`);
        }
      }
    });
  };
  await follow(conversationId, label);
  return () => Promise.all(streams.map(s => s.stop()));
}

export function createApi(deps: ThreadDeps & { token: string }) {
  const { harness, token } = deps;
  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const authorized = (req: IncomingMessage) => {
    const given = Buffer.from(req.headers.authorization ?? ""), want = Buffer.from(`Bearer ${token}`);
    return given.length === want.length && timingSafeEqual(given, want);
  };
  const body = async (req: IncomingMessage) => { let raw = ""; for await (const c of req) { raw += c; if (raw.length > 1_000_000) throw new Error("Body too large"); } return JSON.parse(raw || "{}"); };

  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    try {
      if (path === "/healthz") return json(res, 200, { ok: true });
      if (!authorized(req)) return json(res, 401, { error: "Unauthorized" });
      if (req.method === "GET" && path === "/v1/threads") {
        const doc = await harness().snapshot(Threads, BACKGROUND_CONTEXT);
        return json(res, 200, Object.entries(doc?.threads ?? {}).map(([key, t]) => ({ key, ...t })));
      }
      const m = /^\/v1\/threads\/([A-Za-z0-9:_.-]{1,200})\/(turn|abort)$/.exec(path);
      if (!m || req.method !== "POST") return json(res, 404, { error: "Not found" });
      const key = m[1]!;
      const conversationId = await thread(deps, key);
      const conversation = (await harness().conversation(conversationId, BACKGROUND_CONTEXT))!;
      if (m[2] === "abort") { await conversation.abort(BACKGROUND_CONTEXT); return json(res, 200, { aborted: true }); }

      const { text, requestId } = await body(req);
      if (typeof text !== "string" || !text.trim() || typeof requestId !== "string" || !/^[A-Za-z0-9:_.-]{8,200}$/.test(requestId))
        return json(res, 400, { error: "Need text and requestId" });
      const submission = await conversation.submit({ type: "input", content: text, requestId, whenBusy: "followUp" }, BACKGROUND_CONTEXT);

      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
      const write = (frame: object) => { if (!res.writableEnded) res.write(JSON.stringify(frame) + "\n"); };
      const keepalive = setInterval(() => write({ type: "ping" }), 15000);
      const stop = await trace(harness(), conversationId, line => write({ type: "trace", text: line }));
      try {
        const settled = await submission.wait(BACKGROUND_CONTEXT); // the work never depends on this connection
        await new Promise(r => setTimeout(r, 50)); // let the last committed events reach the trace
        if (settled.status === "done" && settled.type === "input") write({ type: "done", text: await answerText(harness(), settled.answer) });
        else write({ type: "error", message: settled.reason === "aborted" ? "Stopped." : `Kaeno could not answer: ${settled.reason}` });
      } finally { clearInterval(keepalive); await stop(); res.end(); }
    } catch (error) {
      console.error("api:", error);
      if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : "Bad request" });
      else res.end();
    }
  });
}
