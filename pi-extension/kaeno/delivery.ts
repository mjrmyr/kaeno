import { z } from "zod";
import { readReplies, type Server } from "./client.ts";

export const cursorSchema = z.object({
  key: z.string(),
  after: z.number().int().nonnegative(),
});
export const receiptSchema = z.object({
  key: z.string(),
  id: z.number().int().positive(),
});
export type ReplyPage = Awaited<ReturnType<typeof readReplies>>;
export type Reply = ReplyPage["replies"][number];

interface DeliveryOptions {
  /** "latest" is a one-time baseline for pre-cursor Pi sessions. */
  after: number | "latest";
  canDeliver(): boolean;
  displayed(): Set<number>;
  deliver(reply: Reply): void;
  checkpoint(after: number): void;
  truncated(): void;
}

/** One cursor and one in-flight read per Pi session. Never advances while Pi is busy. */
export class ReplyDelivery {
  private after: number | "latest";
  private readonly server: Server;
  private readonly session: string;
  private readonly options: DeliveryOptions;
  private readonly controller = new AbortController();
  private initializing?: Promise<void>;
  private pending?: Promise<number>;

  constructor(server: Server, session: string, options: DeliveryOptions) {
    this.server = server;
    this.session = session;
    this.options = options;
    this.after = options.after;
  }

  private signal(): AbortSignal {
    return AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(10_000),
    ]);
  }

  /** Called before posting new work, so a legacy baseline cannot swallow a new reply. */
  initialize(): Promise<void> {
    if (this.controller.signal.aborted) {
      return Promise.reject(this.controller.signal.reason);
    }
    if (this.after !== "latest") {
      return Promise.resolve();
    }
    this.initializing ??= (async () => {
      const page = await readReplies(
        this.server,
        this.session,
        0,
        this.signal(),
      );
      this.controller.signal.throwIfAborted();
      this.options.checkpoint(page.next);
      this.after = page.next;
    })().finally(() => {
      this.initializing = undefined;
    });
    return this.initializing;
  }

  poll(): Promise<number> {
    this.pending ??= this.drain().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async drain(): Promise<number> {
    if (!this.options.canDeliver() || this.controller.signal.aborted) {
      return 0;
    }
    await this.initialize();
    if (!this.options.canDeliver() || this.controller.signal.aborted) {
      return 0;
    }
    // initialize() resolves "latest" before this read.
    const after = this.after;
    if (after === "latest") {
      throw new Error("Reply delivery has not initialized");
    }
    const page = await readReplies(
      this.server,
      this.session,
      after,
      this.signal(),
    );
    // A turn or session switch may have started while the HTTP read was in flight.
    if (this.controller.signal.aborted || !this.options.canDeliver()) {
      return 0;
    }
    const displayed = this.options.displayed();
    let delivered = 0;
    if (page.truncated) {
      this.options.truncated();
    }
    for (const reply of page.replies) {
      if (!displayed.has(reply.id)) {
        this.options.deliver(reply);
        delivered++;
      }
    }
    if (page.next > after) {
      this.options.checkpoint(page.next);
      this.after = page.next;
    }
    return delivered;
  }

  close(): void {
    this.controller.abort();
  }
}
