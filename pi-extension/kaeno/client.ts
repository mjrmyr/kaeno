import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { z } from "zod";

/** One Kaeno server and the token its API requires. */
export interface Server {
  url: string;
  token: string;
}
const root = (server: Server) => server.url.replace(/\/$/, "");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const threadPath = (session: string) =>
  `/v1/threads/pi:${hash(session).slice(0, 40)}`;
export const deliveryKey = (server: Server, session: string) =>
  `${root(server)}${threadPath(session)}`;
export const receiptPrefix = (server: Server, session: string) =>
  `${deliveryKey(server, session)}#reply:`;
const replyPage = z.object({
  replies: z.array(
    z.object({ id: z.number(), requestId: z.string(), text: z.string() }),
  ),
  next: z.number(),
  truncated: z.boolean(),
});

export async function request(
  server: Server,
  path: string,
  init?: RequestInit,
  fetcher = fetch,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${server.token}`);
  const response = await fetcher(`${root(server)}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    throw new Error(
      `Kaeno at ${server.url}: HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return response;
}

const changeList = z.array(
  z.object({ id: z.string(), action: z.string(), status: z.string() }),
);
/** Routine changes Kaeno proposed. They apply only through `decideChange`, an owner action. */
export async function listChanges(
  server: Server,
  fetcher = fetch,
): Promise<z.infer<typeof changeList>> {
  const response = await request(
    server,
    "/v1/routines/changes",
    undefined,
    fetcher,
  );
  return changeList.parse(await response.json());
}

export async function decideChange(
  server: Server,
  id: string,
  decision: "approve" | "reject",
  fetcher = fetch,
): Promise<void> {
  if (!/^c[0-9]+$/.test(id)) {
    throw new Error(`Not a change ID: "${id}" (expected e.g. c42)`);
  }
  await request(
    server,
    `/v1/routines/changes/${id}/${decision}`,
    { method: "POST" },
    fetcher,
  );
}

export async function readReplies(
  server: Server,
  session: string,
  after = 0,
  signal?: AbortSignal,
  fetcher = fetch,
) {
  const response = await request(
    server,
    `${threadPath(session)}/replies?after=${after}`,
    { signal },
    fetcher,
  );
  return replyPage.parse(await response.json());
}

// Kaeno owns the conversation and execution tools; Pi is only a text terminal.
export function streamKaeno(
  server: Server,
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
  beforeSend?: () => Promise<void>,
) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      stopReason: "pending",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    try {
      const user = context.messages.findLast(
        (message) => message.role === "user",
      );
      const content = user?.content;
      const text = (
        typeof content === "string"
          ? content
          : content
              ?.filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
      )?.trim();
      if (!text) {
        throw new Error("Nothing to send to Kaeno");
      }
      const session = options?.sessionId;
      if (!session) {
        throw new Error("Kaeno requires a Pi session ID");
      }
      const requestId = `pi-${hash(`${session}\n${user?.timestamp}\n${text}`).slice(0, 40)}`;
      await beforeSend?.();
      const signal = options?.signal;
      signal?.throwIfAborted();
      const payload = { text, requestId };
      const replacement = await options?.onPayload?.(payload, model);
      const response = await request(
        server,
        `${threadPath(session)}/turn`,
        {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(replacement ?? payload),
        },
        options?.fetch,
      );
      await options?.onResponse?.(
        {
          status: response.status,
          headers: Object.fromEntries(response.headers),
        },
        model,
      );
      await response.arrayBuffer();
      stream.push({ type: "start", partial: output });
      // The HTTP API admits a task, then exposes completed replies separately.
      let after = 0;
      for (;;) {
        const page = await readReplies(
          server,
          session,
          after,
          signal,
          options?.fetch,
        );
        const reply = page.replies.find(
          (value) => value.requestId === requestId,
        );
        if (reply) {
          // Persisted with Pi's assistant message; the inbox won't display it again.
          output.responseId = `${receiptPrefix(server, session)}${reply.id}`;
          output.content.push({ type: "text", text: reply.text });
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: reply.text,
            partial: output,
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: reply.text,
            partial: output,
          });
          output.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message: output });
          break;
        }
        after = page.next;
        await delay(500, undefined, { signal });
      }
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
    } finally {
      stream.end();
    }
  })();
  return stream;
}
