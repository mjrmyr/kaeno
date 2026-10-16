// Kaeno's native HTTP API (bearer token, reached over Tailscale). Clients are thin and optional: work is durable in
// kaeno, so a client that disconnects only stops watching; retrying with the same requestId resumes the same turn.
//
//   POST /v1/threads/:key/turn   {text, requestId}  → NDJSON: {type:"trace",text} … then {type:"done",text} | {type:"error",message}
//   POST /v1/threads/:key/abort
//   GET  /v1/threads
//   GET  /v1/threads/:key/work/:workId/artifacts[/<path>]   run evidence (listing / file)
//   GET  /healthz
import type { Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  watchEvents,
  type AgentEvent,
  type ConversationId,
  type Harness,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { z } from "zod";
import { parseTaskId } from "../durable/index.ts";
import type { ThreadInfo } from "../threads/index.ts";
import type { ReplyPage } from "../turns/index.ts";
import type {
  ArtifactFile,
  ArtifactsListing,
  WorkView,
} from "../work/index.ts";
const oneLine = (state: string, max = 200) => {
  const file = state.replace(/\s+/g, " ").trim();
  return file.length > max ? file.slice(0, max - 1) + "…" : file;
};
export function describeTool(name: string, raw: unknown): string {
  const parsed = z.record(z.string(), z.unknown()).safeParse(raw);
  const args = parsed.success ? parsed.data : {};
  if (name === "bash") {
    return `$ ${oneLine(String(args?.command ?? ""))}`;
  }
  if (name === "start_work") {
    return `▸ starting work: ${oneLine(String(args?.title ?? ""))}`;
  }
  if (name === "message_work") {
    return `▸ message to work #${args?.id}: ${oneLine(String(args?.text ?? ""))}`;
  }
  if (name === "read_skill") {
    return oneLine(
      `read_skill ${args?.skill ?? ""} ${args?.file ?? "SKILL.md"}`,
    );
  }
  return oneLine(`${name} ${String(args?.path ?? "")}`);
}
/** Follow one conversation as human-readable trace lines. WORK runs after the turn; inspect it with list_work. */
export interface ConversationEvents {
  watchConversation(
    id: ConversationId,
    ctx: Context,
  ): ReturnType<typeof watchEvents>;
}
export async function traceConversation(
  events: ConversationEvents,
  conversationId: ConversationId,
  emit: (line: string) => void,
  context: Context,
): Promise<() => Promise<unknown>> {
  const stream = await events.watchConversation(conversationId, context);
  let text = "";
  stream.start(async (events: readonly AgentEvent[]) => {
    for (const eventValue of events) {
      if (eventValue.type === "message_update") {
        for (const chunk of eventValue.changes) {
          if (chunk.type === "text_delta" || chunk.type === "thinking_delta") {
            text += chunk.delta;
          }
        }
        // Flush complete lines so the trace reads like a log, not a token stream.
        const nl = text.lastIndexOf("\n");
        if (nl >= 0) {
          for (const line of text.slice(0, nl).split("\n")) {
            if (line.trim()) {
              emit(line);
            }
          }
          text = text.slice(nl + 1);
        }
      } else if (eventValue.type === "message_end") {
        if (text.trim()) {
          emit(text.trim());
        }
        text = "";
      } else if (eventValue.type === "tool_execution_start") {
        emit(describeTool(eventValue.toolName, eventValue.args));
      } else if (eventValue.type === "auto_retry_start") {
        emit(
          `(retrying model request: ${oneLine(eventValue.errorMessage, 120)})`,
        );
      }
    }
  });
  return () => stream.stop();
}
export interface ApiThreads {
  getOrCreateConversation(key: string): Promise<ConversationId>;
  listConversations(): Promise<ThreadInfo[]>;
}
export interface ApiTurns {
  admitUserTurn(
    tx: Tx,
    id: ConversationId,
    content: string,
    requestId: string,
  ): Promise<TaskId>;
  admitStop(tx: Tx, id: ConversationId): Promise<TaskId>;
  readReplies(id: ConversationId, after: number): Promise<ReplyPage>;
  readReplyText(
    id: ConversationId,
    requestId: string,
  ): Promise<string | undefined>;
}
export interface ApiWork {
  listWork(id: ConversationId): Promise<WorkView[]>;
  readArtifacts(
    caller: ConversationId,
    workId: TaskId,
  ): Promise<ArtifactsListing | undefined>;
  readArtifactFile(
    caller: ConversationId,
    workId: TaskId,
    path: string,
  ): Promise<ArtifactFile | undefined>;
}
export interface ApiRuntime extends Pick<Harness, "commit" | "waitForTask"> {}
export class ApiServer {
  readonly server: Server;
  constructor(
    harness: () => ApiRuntime,
    threads: ApiThreads,
    turns: ApiTurns,
    work: ApiWork | undefined,
    events: ConversationEvents,
    token: string,
  ) {
    const json = (res: ServerResponse, status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const authorized = (req: IncomingMessage) => {
      const given = Buffer.from(req.headers.authorization ?? "");
      const want = Buffer.from(`Bearer ${token}`);
      return given.length === want.length && timingSafeEqual(given, want);
    };
    const body = async (req: IncomingMessage): Promise<unknown> => {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1000000) {
          throw new Error("Body too large");
        }
      }
      return JSON.parse(raw || "{}");
    };
    this.server = createServer(async (req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      try {
        if (path === "/healthz") {
          return json(res, 200, { ok: true });
        }
        if (!authorized(req)) {
          return json(res, 401, { error: "Unauthorized" });
        }
        if (req.method === "GET" && path === "/v1/threads") {
          return json(res, 200, await threads.listConversations());
        }
        const artifacts =
          /^\/v1\/threads\/([A-Za-z0-9:_.-]{1,200})\/work\/(\d+)\/artifacts(?:\/(.*))?$/.exec(
            path,
          );
        if (artifacts && req.method === "GET") {
          if (!work) {
            return json(res, 404, { error: "WORK is disabled" });
          }
          const caller = await threads.getOrCreateConversation(artifacts[1]);
          const workId = parseTaskId(Number(artifacts[2]));
          const file = artifacts[3];
          if (file === undefined) {
            const listing = await work.readArtifacts(caller, workId);
            if (!listing) {
              return json(res, 404, { error: "No artifacts for this work" });
            }
            return json(res, 200, listing);
          }
          let name: string;
          try {
            name = decodeURIComponent(file);
          } catch {
            return json(res, 400, { error: "Bad artifact path" });
          }
          const content = await work.readArtifactFile(caller, workId, name);
          if (!content) {
            return json(res, 404, { error: "No such artifact" });
          }
          if (content.text !== undefined) {
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            return res.end(content.text);
          }
          return json(res, 200, { path: content.path, base64: content.base64 });
        }
        const message =
          /^\/v1\/threads\/([A-Za-z0-9:_.-]{1,200})\/(turn|abort|replies|work)$/.exec(
            path,
          );
        if (!message || !["POST", "GET"].includes(req.method ?? "")) {
          return json(res, 404, { error: "Not found" });
        }
        if (message[2] === "work" && !work) {
          return json(res, 404, { error: "WORK is disabled" });
        }
        const key = message[1];
        const conversationId = await threads.getOrCreateConversation(key);
        if (message[2] === "replies" && req.method === "GET") {
          const after = Number(
            new URL(req.url ?? "/", "http://x").searchParams.get("after") ??
              "0",
          );
          if (!Number.isSafeInteger(after) || after < 0) {
            return json(res, 400, {
              error: "after must be a nonnegative reply cursor",
            });
          }
          return json(res, 200, await turns.readReplies(conversationId, after));
        }
        if (message[2] === "work" && req.method === "GET" && work) {
          return json(res, 200, await work.listWork(conversationId));
        }
        if (req.method !== "POST" || !["turn", "abort"].includes(message[2])) {
          return json(res, 404, { error: "Not found" });
        }
        if (message[2] === "abort") {
          const id = await harness().commit(
            (tx) => turns.admitStop(tx, conversationId),
            BACKGROUND_CONTEXT,
          );
          await harness().waitForTask(id, BACKGROUND_CONTEXT);
          return json(res, 200, { cancellationRequested: true });
        }
        const { text, requestId } = z
          .object({ text: z.string(), requestId: z.string() })
          .parse(await body(req));
        if (
          typeof text !== "string" ||
          !text.trim() ||
          typeof requestId !== "string" ||
          !/^[A-Za-z0-9:_.-]{8,200}$/.test(requestId) ||
          ["__proto__", "constructor", "prototype"].includes(requestId) ||
          requestId.startsWith("work-report:") ||
          requestId.startsWith("activity-result:")
        ) {
          return json(res, 400, { error: "Need text and requestId" });
        }
        const turn = await harness().commit(
          (tx) => turns.admitUserTurn(tx, conversationId, text, requestId),
          BACKGROUND_CONTEXT,
        );
        res.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-cache",
        });
        const observer = new AbortController();
        const observation = withAbortSignal(
          observer.signal,
          BACKGROUND_CONTEXT,
        );
        const closed = () => observer.abort();
        res.once("close", closed);
        // Traces are best-effort; bound buffering for a stalled observer. Final replies have a durable cursor feed.
        const write = (frame: object, final = false) => {
          if (
            !res.destroyed &&
            !res.writableEnded &&
            (final || res.writableLength < 65536)
          ) {
            res.write(JSON.stringify(frame) + "\n");
          }
        };
        const keepalive = setInterval(() => write({ type: "ping" }), 15000);
        let stop: (() => Promise<unknown>) | undefined;
        try {
          stop = await traceConversation(
            events,
            conversationId,
            (line) => write({ type: "trace", text: line }),
            observation,
          );
          await harness().waitForTask(turn, observation); // disconnect stops only observation, not admission/execution
          const replyText = await turns.readReplyText(
            conversationId,
            requestId,
          );
          if (replyText) {
            write({ type: "done", text: replyText }, true);
          } else {
            write({ type: "error", message: "Stopped." }, true);
          }
        } finally {
          clearInterval(keepalive);
          await stop?.();
          res.removeListener("close", closed);
          res.end();
        }
      } catch (error) {
        if (res.destroyed) {
          return;
        }
        console.error("api:", error);
        if (!res.headersSent) {
          json(res, 400, {
            error: error instanceof Error ? error.message : "Bad request",
          });
        } else {
          res.end();
        }
      }
    });
  }
}
