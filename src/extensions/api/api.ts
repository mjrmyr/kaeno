import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { z } from "zod";
import { recall, type Kaeno } from "../../core/application/index.ts";
import {
  forgetEntry,
  memoryIndex,
  updateEntry,
  type MemoryStore,
} from "../memory/index.ts";
import type { Routines } from "../routines/index.ts";

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);

    if (Buffer.byteLength(raw) > 1_000_000) {
      throw new Error("Body too large");
    }
  }
  return JSON.parse(raw);
}

export class ApiServer {
  readonly server: Server;
  /** Routes of an omitted feature answer 404. */
  constructor(
    core: Kaeno,
    features: { memory?: MemoryStore; routines?: Routines } = {},
  ) {
    const { memory, routines } = features;
    this.server = createServer(async (req, res) => {
      function json(status: number, value: unknown) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      }

      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "GET" && url.pathname === "/healthz") {
          return json(200, { ok: true });
        }

        if (req.method === "GET" && url.pathname === "/v1/tickets") {
          const all = url.searchParams.get("all") === "true";
          return json(
            200,
            await core.router.listTickets(BACKGROUND_CONTEXT, all),
          );
        }
        const ticket = /^\/v1\/tickets\/(k[0-9]{1,15})(\/stop)?$/.exec(
          url.pathname,
        );
        if (ticket && req.method === "GET" && !ticket[2]) {
          return json(200, {
            ticket: await core.router.ticket(ticket[1], BACKGROUND_CONTEXT),
            recall: await recall(
              core.router,
              ticket[1],
              0,
              4000,
              BACKGROUND_CONTEXT,
            ),
          });
        }
        if (ticket && req.method === "POST" && ticket[2]) {
          const works = await core.harness.commit(
            (tx) =>
              core.router.stopTicket(
                tx,
                ticket[1],
                "owner",
                "stopped by the owner",
              ),
            BACKGROUND_CONTEXT,
          );
          await core.router.abortWorks(works, BACKGROUND_CONTEXT);
          return json(202, { stopped: ticket[1] });
        }
        if (req.method === "POST" && url.pathname === "/v1/router/compact") {
          await core.router.compact(BACKGROUND_CONTEXT);
          return json(202, { compacting: true });
        }

        if (routines && url.pathname === "/v1/routines") {
          if (req.method === "GET") {
            return json(200, await routines.describe(Date.now()));
          }
          if (req.method === "POST") {
            return json(201, routines.create(await readJson(req)));
          }
        }
        // Changes Kaeno proposed: only an owner decision here applies them.
        if (
          routines &&
          req.method === "GET" &&
          url.pathname === "/v1/routines/changes"
        ) {
          return json(200, routines.changes());
        }
        const decision = routines
          ? /^\/v1\/routines\/changes\/(c[0-9]{1,20})\/(approve|reject)$/.exec(
              url.pathname,
            )
          : null;
        if (routines && decision && req.method === "POST") {
          return json(
            200,
            decision[2] === "approve"
              ? routines.approve(decision[1])
              : routines.reject(decision[1]),
          );
        }
        const routine = routines
          ? /^\/v1\/routines\/([0-9]{1,15})(\/run)?$/.exec(url.pathname)
          : null;
        if (routines && routine) {
          const routineId = Number(routine[1]);
          if (routine[2] && req.method === "POST") {
            return json(202, { workId: await routines.runNow(routineId) });
          }
          if (!routine[2] && req.method === "PUT") {
            return routines.replace(routineId, await readJson(req))
              ? json(200, { id: routineId })
              : json(404, { error: "Not found" });
          }
          if (!routine[2] && req.method === "DELETE") {
            return json(200, {
              id: routineId,
              removed: routines.remove(routineId),
            });
          }
          return json(404, { error: "Not found" });
        }

        if (memory && req.method === "GET" && url.pathname === "/v1/memory") {
          return json(200, memoryIndex(memory.read()));
        }

        // Owner edits from this API are not turns: they change memory directly, like a settings page.
        const entry = memory
          ? /^\/v1\/memory\/(m[0-9]{1,20})$/.exec(url.pathname)
          : null;
        if (memory && entry) {
          const memoryId = entry[1];
          if (req.method === "GET") {
            const { entries } = memory.read();
            return Object.hasOwn(entries, memoryId)
              ? json(200, { id: memoryId, ...entries[memoryId] })
              : json(404, { error: "Not found" });
          }
          if (req.method === "PUT") {
            const content = z
              .object({ title: z.string().optional(), text: z.string() })
              .strict()
              .parse(await readJson(req));
            const updated = memory.mutate((state) =>
              updateEntry(state, memoryId, content, Date.now()),
            );
            return updated
              ? json(200, { id: memoryId })
              : json(404, { error: "Not found" });
          }
          if (req.method === "DELETE") {
            const removed = memory.mutate((state) =>
              forgetEntry(state, memoryId),
            );
            return json(200, { id: memoryId, removed });
          }
          return json(404, { error: "Not found" });
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
          input = z
            .object({
              text: z.string().trim().min(1),
              requestId: z.string().regex(/^[A-Za-z0-9:_.-]{8,200}$/),
            })
            .parse(await readJson(req));

          if (
            ["__proto__", "constructor", "prototype"].includes(
              input.requestId,
            ) ||
            /^(reply|ack|unrouted):/.test(input.requestId)
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

        const thread = match[1];
        if (match[2] === "replies") {
          return json(
            200,
            await core.router.readReplies(thread, after, BACKGROUND_CONTEXT),
          );
        }
        if (match[2] === "reset") {
          await core.router.compact(BACKGROUND_CONTEXT);
          return json(202, { compacting: true });
        }
        if (!input) {
          const works = await core.harness.commit(
            async (tx) => (await core.router.stopAll(tx, thread)).works,
            BACKGROUND_CONTEXT,
          );
          await core.router.abortWorks(works, BACKGROUND_CONTEXT);
          return json(202, { stopped: works.length });
        }
        const message = input;
        const received = await core.harness.commit(
          (tx) =>
            core.router.receive(tx, {
              key: `http:${thread}:${message.requestId}`,
              source: thread.startsWith("pi:") ? "pi" : "http",
              threads: [thread],
              actor: "http",
              authority: "owner",
              content: message.text,
              requestId: message.requestId,
            }),
          BACKGROUND_CONTEXT,
        );
        return json(202, { trigger: received.id });
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
