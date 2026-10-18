import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import {
  readReplies,
  receiptPrefix,
  streamKaeno,
  threadPath,
} from "../../pi-extension/kaeno/client.ts";

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
    server = undefined;
  }
});

async function serve(handler: RequestListener) {
  server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

const context = normalizeContext({
  messages: [
    { role: "user", content: "old message", timestamp: 1 },
    { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 2 },
  ],
});
const model = fauxProvider().getModel();

it("sends only the newest text, polls the admitted reply, and preserves retry identity", async () => {
  const bodies: unknown[] = [];
  let requestId = "";
  let reads = 0;
  const base = await serve(async (req, res) => {
    expect(req.url?.startsWith(threadPath("session-1"))).toBe(true);
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
      const parsed = JSON.parse(body);
      bodies.push(parsed);
      requestId = parsed.requestId;
      res.writeHead(202).end(JSON.stringify({ taskId: "task" }));
      return;
    }
    reads++;
    res.end(
      JSON.stringify({
        replies:
          reads === 1
            ? []
            : [
                { id: 1, requestId: "another-request", text: "not this one" },
                { id: 2, requestId, text: "hello back" },
              ],
        next: reads === 1 ? 0 : 2,
        truncated: false,
      }),
    );
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const stream = streamKaeno(base, model, context, {
      sessionId: "session-1",
    });
    const events = [];
    for await (const event of stream) {
      events.push(event.type);
    }
    const result = await stream.result();
    expect(result.content).toEqual([{ type: "text", text: "hello back" }]);
    expect(result.responseId).toBe(`${receiptPrefix(base, "session-1")}2`);
    expect(events).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
  }
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toMatchObject({ text: "hello" });
});

it("does not admit work if the delivery baseline cannot initialize", async () => {
  let requests = 0;
  const base = await serve((_req, res) => {
    requests++;
    res.end("{}");
  });
  const result = await streamKaeno(
    base,
    model,
    context,
    { sessionId: "session-1" },
    async () => {
      throw new Error("Cannot initialize cursor");
    },
  ).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toBe("Cannot initialize cursor");
  expect(requests).toBe(0);
});

it("returns a stream error for HTTP failures", async () => {
  const base = await serve((_req, res) =>
    res.writeHead(503).end("unavailable"),
  );
  const stream = streamKaeno(base, model, context, { sessionId: "session-1" });
  const result = await stream.result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("HTTP 503");
});

it("cancels the local wait without sending a remote stop", async () => {
  const methods: string[] = [];
  const controller = new AbortController();
  const base = await serve((req, res) => {
    methods.push(`${req.method} ${req.url}`);
    if (req.method === "POST") {
      res.writeHead(202).end("{}");
    } else {
      res.end(JSON.stringify({ replies: [], next: 0, truncated: false }));
      controller.abort();
    }
  });
  const result = await streamKaeno(base, model, context, {
    sessionId: "session-1",
    signal: controller.signal,
  }).result();
  expect(result.stopReason).toBe("aborted");
  expect(methods.some((method) => method.endsWith("/stop"))).toBe(false);
});

it("rejects malformed reply pages", async () => {
  const base = await serve((_req, res) =>
    res.end(JSON.stringify({ replies: "invalid" })),
  );
  await expect(readReplies(base, "session-1")).rejects.toThrow();
});

it("reads later worker reports", async () => {
  const base = await serve((_req, res) =>
    res.end(
      JSON.stringify({
        replies: [
          { id: 3, requestId: "activity-result:work", text: "worker finished" },
        ],
        next: 3,
        truncated: false,
      }),
    ),
  );
  expect((await readReplies(base, "session-1")).replies[0].text).toBe(
    "worker finished",
  );
});
