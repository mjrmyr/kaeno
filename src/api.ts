// Kaeno's native HTTP API (bearer token, reached over Tailscale). Clients are thin and optional: work is durable in
// kaeno, so a client that disconnects only stops watching; retrying with the same requestId resumes the same turn.
//
//   POST /v1/threads/:key/turn   {text, requestId}  → NDJSON: {type:"trace",text} … then {type:"done",text} | {type:"error",message}
//   POST /v1/threads/:key/abort
//   GET  /v1/threads
//   GET  /healthz
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { watchEvents, type AgentEvent, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { thread, Threads, type ThreadDeps } from "./threads.ts";
import { admitTurn, admitControl, TurnLedger, type TurnTask, type ControlTask } from "./turns.ts";
import type { WorkController } from "./work.ts";

const oneLine = (s: string, max = 200) => { const f = s.replace(/\s+/g, " ").trim(); return f.length > max ? f.slice(0, max - 1) + "…" : f; };

export function describeTool(name: string, args: any): string {
  if (name === "bash") return `$ ${oneLine(String(args?.command ?? ""))}`;
  if (name === "start_work") return `▸ starting work: ${oneLine(String(args?.title ?? ""))}`;
  if (name === "delegate") return `▸ delegating to ${args?.agent}: ${oneLine(String(args?.task ?? ""), 300)}`;
  if (name === "read_skill") return oneLine(`read_skill ${args?.skill ?? ""} ${args?.file ?? "SKILL.md"}`);
  return oneLine(`${name} ${String(args?.path ?? "")}`);
}

/** Follow a conversation and the sub-agents it delegates to, as human-readable trace lines. */
async function trace(harness: Harness, conversationId: ConversationId, emit: (line: string) => void, context: Context) {
  const streams: { stop(): Promise<unknown> }[] = [];
  const attached = new Set<ConversationId>();
  const follow = async (id: ConversationId, prefix: string) => {
    attached.add(id);
    const stream = await watchEvents(harness, id, context);
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
  await follow(conversationId, "");
  return () => Promise.all(streams.map(s => s.stop()));
}

export function createApi(deps: ThreadDeps & { token: string; Turn: TurnTask; Control: ControlTask; work: WorkController }) {
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
      const m = /^\/v1\/threads\/([A-Za-z0-9:_.-]{1,200})\/(turn|abort|replies|work)$/.exec(path);
      if (!m || !["POST", "GET"].includes(req.method ?? "")) return json(res, 404, { error: "Not found" });
      const key = m[1]!;
      const conversationId = await thread(deps, key);
      const conversation = (await harness().conversation(conversationId, BACKGROUND_CONTEXT))!;
      if (m[2] === "replies" && req.method === "GET") {
        const after = Number(new URL(req.url!, "http://x").searchParams.get("after") ?? "0");
        if (!Number.isSafeInteger(after) || after < 0) return json(res, 400, { error: "after must be a nonnegative reply cursor" });
        const ledger = await harness().snapshot(TurnLedger, conversationId, BACKGROUND_CONTEXT);
        return json(res, 200, { replies: ledger?.replies.filter(r => r.id > after) ?? [], next: (ledger?.next ?? 1) - 1,
          truncated: !!ledger?.replies.length && after < ledger.replies[0]!.id - 1 });
      }
      if (m[2] === "work" && req.method === "GET") return json(res, 200, await deps.work.list(conversationId));
      if (req.method !== "POST" || !["turn", "abort"].includes(m[2]!)) return json(res, 404, { error: "Not found" });
      if (m[2] === "abort") {
        const id = await harness().commit(tx => admitControl(tx, deps.Control, conversationId, "stop"), BACKGROUND_CONTEXT);
        await harness().waitForTask(id, BACKGROUND_CONTEXT);
        return json(res, 200, { cancellationRequested: true });
      }

      const { text, requestId } = await body(req);
      if (typeof text !== "string" || !text.trim() || typeof requestId !== "string" || !/^[A-Za-z0-9:_.-]{8,200}$/.test(requestId) || ["__proto__", "constructor", "prototype"].includes(requestId) || requestId.startsWith("work-report:"))
        return json(res, 400, { error: "Need text and requestId" });
      const turn = await harness().commit(tx => admitTurn(tx, deps.Turn, { conversationId, content: text, requestId }), BACKGROUND_CONTEXT);

      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
      const observer = new AbortController(), observation = withAbortSignal(observer.signal, BACKGROUND_CONTEXT);
      const closed = () => observer.abort(); res.once("close", closed);
      // Traces are best-effort; bound buffering for a stalled observer. Final replies have a durable cursor feed.
      const write = (frame: object, final = false) => { if (!res.destroyed && !res.writableEnded && (final || res.writableLength < 65_536)) res.write(JSON.stringify(frame) + "\n"); };
      const keepalive = setInterval(() => write({ type: "ping" }), 15000);
      let stop: (() => Promise<unknown>) | undefined;
      try {
        stop = await trace(harness(), conversationId, line => write({ type: "trace", text: line }), observation);
        await harness().waitForTask(turn, observation); // disconnect stops only observation, not admission/execution
        const receipt = (await harness().snapshot(TurnLedger, conversationId, BACKGROUND_CONTEXT))?.receipts[requestId];
        if (receipt?.text) write({ type: "done", text: receipt.text }, true);
        else write({ type: "error", message: "Stopped." }, true);
      } finally { clearInterval(keepalive); await stop?.(); res.removeListener("close", closed); res.end(); }
    } catch (error) {
      if (res.destroyed) return;
      console.error("api:", error);
      if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : "Bad request" });
      else res.end();
    }
  });
}
