import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import { z } from "zod";
import type { Authority, Kaeno } from "../../core/application/index.ts";

/** One event a source reported, in Kaeno's terms. `threads` are scoped to its source. */
export interface WebhookEvent {
  id: string;
  threads: string[];
  actor: string;
  text: string;
  /** The threads are finished, for example a merged pull request: tickets stop following them. */
  closes: boolean;
}
/**
 * Verifies that a request really comes from its system and turns it into an event, or into null when the
 * system reported nothing Kaeno acts on.
 */
export interface WebhookAdapter {
  read(headers: IncomingHttpHeaders, body: Buffer): WebhookEvent | null;
}
/** `all`: every verified event is the owner's system. Otherwise only the listed actors are. */
export type WebhookTrust = "all" | { actors: readonly string[] };
export interface WebhookSource {
  name: string;
  adapter: WebhookAdapter;
  trust: WebhookTrust;
}

export class WebhookUnauthorized extends Error {}

export const genericEventSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9:_.-]{1,200}$/),
    thread: z.string().regex(/^[A-Za-z0-9:_./#-]{1,200}$/),
    actor: z.string().min(1).max(200),
    text: z.string().trim().min(1).max(16000),
    closes: z.boolean().default(false),
  })
  .strict();

/** Whether `header` is `sha256=<hex>` of the HMAC-SHA256 of `body` under `secret`, compared in constant time. */
export function signed(header: unknown, secret: string, body: Buffer): boolean {
  if (typeof header !== "string") {
    return false;
  }
  const given = Buffer.from(header);
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  );
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Kaeno's own format for systems the owner runs: a JSON event signed with HMAC-SHA256 of the raw body, sent as
 * `X-Kaeno-Signature-256: sha256=<hex>`.
 */
export function genericAdapter(secret: string): WebhookAdapter {
  return {
    read(headers, body) {
      if (!signed(headers["x-kaeno-signature-256"], secret, body)) {
        throw new WebhookUnauthorized("Invalid signature");
      }
      const { thread, ...event } = genericEventSchema.parse(
        JSON.parse(body.toString("utf8")),
      );
      return { ...event, threads: [thread] };
    },
  };
}

export function authorityOf(trust: WebhookTrust, actor: string): Authority {
  return trust === "all" || trust.actors.includes(actor) ? "system" : "none";
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      throw new Error("Body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Receives events from the owner's systems at `POST /hooks/<source>`. Each source's adapter verifies the request;
 * the source's trust decides its authority. Thread keys are prefixed with the source's name, so no source can
 * post into another source's or a channel's threads.
 */
export class WebhookServer {
  readonly server: Server;
  constructor(core: Kaeno, sources: readonly WebhookSource[]) {
    const byName = new Map(sources.map((source) => [source.name, source]));
    this.server = createServer(async (req, res) => {
      function json(status: number, value: unknown) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      }
      try {
        const name = /^\/hooks\/([a-z0-9-]{1,40})$/.exec(
          new URL(req.url ?? "/", "http://localhost").pathname,
        )?.[1];
        const source = name === undefined ? undefined : byName.get(name);
        if (req.method !== "POST" || !source) {
          return json(404, { error: "Not found" });
        }
        const body = await readBody(req);
        let event: WebhookEvent | null;
        try {
          event = source.adapter.read(req.headers, body);
        } catch (error) {
          if (error instanceof WebhookUnauthorized) {
            return json(401, { error: error.message });
          }
          throw error;
        }
        if (!event) {
          return json(202, { ignored: true });
        }
        const { id, actor, text, closes } = event;
        const threads = event.threads.map(
          (thread) => `${source.name}:${thread}`,
        );
        const received = await core.harness.commit(async (tx) => {
          const result = await core.router.receive(tx, {
            key: `${source.name}:${id}`,
            source: source.name,
            threads,
            actor,
            authority: authorityOf(source.trust, actor),
            content: text,
          });
          if (closes && !result.duplicate) {
            for (const thread of threads) {
              await core.router.closeThread(tx, thread);
            }
          }
          return result;
        }, BACKGROUND_CONTEXT);
        return json(202, {
          trigger: received.id,
          duplicate: received.duplicate,
        });
      } catch (error) {
        if (!res.headersSent) {
          json(400, {
            error: error instanceof Error ? error.message : "Bad request",
          });
        }
      }
    });
  }
}
