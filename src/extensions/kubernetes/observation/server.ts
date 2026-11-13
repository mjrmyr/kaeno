import { timingSafeEqual, createHash } from "node:crypto";
import type { RequestListener } from "node:http";
import type { KubernetesObserver } from "./collector.ts";

/** Serve behind a private TLS proxy. Client tokens are reread on each request for rotation. */
export function observerHandler(
  observer: KubernetesObserver,
  readToken: () => Promise<string>,
): RequestListener {
  return async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "application/json");
    try {
      const expected = (await readToken()).trim();
      const actual = req.headers.authorization ?? "";
      function hash(value: string) {
        return createHash("sha256").update(value).digest();
      }
      if (
        expected.length < 32 ||
        !timingSafeEqual(hash(actual), hash(`Bearer ${expected}`))
      ) {
        res.writeHead(401).end('{"error":"unauthorized"}');
        return;
      }
      if (req.method !== "GET" || req.url !== "/v1/snapshot") {
        res.writeHead(404).end('{"error":"not_found"}');
        return;
      }
      const snapshot = observer.snapshot();
      if (!snapshot) {
        res.writeHead(503).end('{"error":"unavailable"}');
        return;
      }
      res.end(JSON.stringify(snapshot));
    } catch {
      res.writeHead(503).end('{"error":"unavailable"}');
    }
  };
}
