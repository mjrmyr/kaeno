import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createFeed } from "./feed.ts";

const HOST = "127.0.0.1";
const POLL_MS = 500;

const port = Number(process.env.KAENO_INSPECT_PORT ?? 8090);
const dataDirectory = resolve(process.env.KAENO_DATA_DIR ?? "/data");
const page = readFileSync(join(import.meta.dirname, "page.html"));
const db = new DatabaseSync(join(dataDirectory, "durable.sqlite"), {
  readOnly: true,
});
const feed = createFeed(db);
const allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);

let pollError: string | null = null;

function pollSafely(): void {
  try {
    feed.poll();
    pollError = null;
  } catch (error) {
    pollError = error instanceof Error ? error.message : String(error);
    console.error(error);
  }
}

pollSafely();
setInterval(pollSafely, POLL_MS);

createServer((req, res) => {
  function json(status: number, value: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  }
  if (!allowedHosts.has(req.headers.host ?? "") || req.method !== "GET") {
    return json(403, { error: "Forbidden" });
  }
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return void res.end(page);
  }
  if (url.pathname === "/api/feed") {
    return json(200, {
      events: feed.since(Number(url.searchParams.get("after") ?? 0)),
      snapshot: feed.snapshot(),
      error: pollError,
    });
  }
  const detail = /^\/api\/events\/(\d+)$/.exec(url.pathname);
  const event = detail ? feed.event(Number(detail[1])) : undefined;
  return event
    ? json(200, event)
    : json(404, { error: "Not found or no longer retained" });
}).listen(port, HOST, () => {
  console.log(
    `Kaeno inspector: http://${HOST}:${port} (read-only, ${dataDirectory})`,
  );
});
