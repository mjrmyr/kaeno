import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import type { Kaeno } from "../application/index.ts";

export class ApiServer {
  readonly server: Server;
  constructor(core: Kaeno) {
    this.server = createServer(async (req, res) => {
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };

      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "GET" && url.pathname === "/healthz") {
          return json(200, { ok: true });
        }

        if (req.method === "GET" && url.pathname === "/v1/threads") {
          return json(200, await core.threads.listConversations());
        }

        const match =
          /^\/v1\/threads\/([A-Za-z0-9:_.-]{1,200})\/(turn|abort|stop|reset|replies)$/.exec(
            url.pathname,
          );

        if (
          !match ||
          (match[2] === "replies"
            ? req.method !== "GET"
            : req.method !== "POST")
        ) {
          return json(404, { error: "Not found" });
        }

        let input: { text: string; requestId: string } | undefined;
        if (match[2] === "turn") {
          let raw = "";
          for await (const chunk of req) {
            raw += String(chunk);

            if (Buffer.byteLength(raw) > 1_000_000) {
              throw new Error("Body too large");
            }
          }

          input = z
            .object({
              text: z.string().trim().min(1),
              requestId: z.string().regex(/^[A-Za-z0-9:_.-]{8,200}$/),
            })
            .parse(JSON.parse(raw));

          if (
            ["__proto__", "constructor", "prototype"].includes(
              input.requestId,
            ) ||
            input.requestId.startsWith("activity-result:")
          ) {
            throw new Error("Invalid requestId");
          }
        }

        const after = Number(url.searchParams.get("after") ?? 0);
        if (
          match[2] === "replies" &&
          (!Number.isSafeInteger(after) || after < 0)
        ) {
          throw new Error("Invalid reply cursor");
        }

        const id = await core.threads.getOrCreateConversation(match[1]);
        if (match[2] === "replies") {
          return json(200, await core.turns.readReplies(id, after));
        }

        const taskId = await core.harness.commit((tx) => {
          if (input) {
            return core.turns.admitUserTurn(
              tx,
              id,
              input.text,
              input.requestId,
            );
          }

          return match[2] === "reset"
            ? core.turns.admitReset(tx, id)
            : core.turns.admitStop(tx, id);
        }, BACKGROUND_CONTEXT);

        return json(202, { taskId });
      } catch (error) {
        if (!res.destroyed) {
          json(400, {
            error: error instanceof Error ? error.message : "Bad request",
          });
        }
      }
    });
  }
}
