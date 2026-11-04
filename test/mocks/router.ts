// Test helpers for the router: owner messages in, replies and tickets out.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai";
import {
  InboxDoc,
  LiveDoc,
  type ConversationId,
  type TaskId,
  type UserInput,
} from "@earendil-works/pi-durable";
import type { Kaeno } from "../../src/core/application/index.ts";
import {
  parseConversationId,
  parseTaskId,
} from "../../src/core/durable/index.ts";

let next = 0;

/** Poll until `check` holds; fails with `what` after `ms`. */
export async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  ms = 10_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A model response that never answers: it hangs until its run is aborted, for example by closing Kaeno, so the
 * router run stays live in storage and resumes on the next open. `started` resolves once the model was called.
 */
export function hangingResponse(): {
  response: FauxResponseFactory;
  started: Promise<void>;
} {
  const { promise, resolve } = Promise.withResolvers<void>();
  return {
    started: promise,
    response: async (_request, options) => {
      resolve();
      return new Promise<never>((_resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          reject(new Error("aborted"));
        }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    },
  };
}

/** The owner's message on a terminal-like thread (no channel route): replies land in the thread's outbox. */
export async function receive(
  core: Kaeno,
  text: UserInput,
  options: { thread?: string; key?: string } = {},
): Promise<{ id: string; key: string; thread: string; path: string }> {
  const thread = options.thread ?? "test:chat";
  const key = options.key ?? `request-${++next}`;
  const received = await core.harness.commit(
    (tx) =>
      core.router.receive(tx, {
        key: `test:${thread}:${key}`,
        source: "test",
        threads: [thread],
        actor: "owner",
        authority: "owner",
        content: text,
        requestId: key,
      }),
    context,
  );
  return { id: received.id, key, thread, path: received.path };
}

/** Wait until the router and every dispatch and delivery have nothing left to do. */
export async function settle(core: Kaeno, ms = 10_000): Promise<void> {
  const router = await core.router.routerConversation(context);
  await until(
    async () => {
      await core.router.idle();
      const tasks = (await core.harness.inspect(context)).tasks;
      if (
        tasks.some(
          ({ record }) =>
            ["kaeno.dispatch", "kaeno.delivery"].includes(record.kind) &&
            record.state.status !== "terminal",
        )
      ) {
        return false;
      }
      const live = await core.harness.snapshot(LiveDoc, router, context);
      const inbox = await core.harness.snapshot(InboxDoc, router, context);
      return !live?.run && (inbox?.items.length ?? 0) === 0;
    },
    "the router to settle",
    ms,
  );
}

/** Replies sent to a thread, oldest first. */
export async function replies(
  core: Kaeno,
  thread = "test:chat",
): Promise<{ requestId: string; text: string; ticket?: string }[]> {
  return (await core.router.readReplies(thread, 0, context)).replies;
}

/** Send the owner's message and return the router's direct reply to it, once one exists. */
export async function ask(
  core: Kaeno,
  text: UserInput,
  options: { thread?: string; key?: string; ms?: number } = {},
): Promise<string> {
  const { key, thread } = await receive(core, text, options);
  let found: string | undefined;
  await until(
    async () => {
      found = (await replies(core, thread)).find(
        (reply) => reply.requestId === key,
      )?.text;
      return found !== undefined;
    },
    `a reply to ${key}`,
    options.ms,
  );
  return found ?? "";
}

/** A ticket started by the host, without a router decision (as routines start them). */
export async function startTicket(
  core: Kaeno,
  request: {
    agent: string;
    content: UserInput;
    title?: string;
    key?: string;
    thread?: string;
    replyThread?: string;
  },
): Promise<string> {
  const key = request.key ?? `ticket-${++next}`;
  return core.harness.commit(
    (tx) =>
      core.router.startTicket(tx, {
        key: `test:${key}`,
        source: "test",
        thread: request.thread ?? `test:ticket:${key}`,
        replyThread: request.replyThread ?? "test:chat",
        agent: request.agent,
        title: request.title ?? "Test",
        content: request.content,
      }),
    context,
  );
}

/** The work task of a ticket's `index`th Assignment (0-based), once it is launched. */
export async function assignment(
  core: Kaeno,
  ticket: string,
  index = 0,
): Promise<TaskId> {
  let workId: number | undefined;
  await until(async () => {
    workId = (await core.router.ticket(ticket, context)).assignments[index]
      ?.workId;
    return workId !== undefined;
  }, `assignment ${index} of ${ticket}`);
  return parseTaskId(workId);
}

/** The ticket's worker conversation. */
export async function ticketConversation(
  core: Kaeno,
  ticket: string,
): Promise<ConversationId> {
  const { conversation } = await core.router.ticket(ticket, context);
  return parseConversationId(conversation);
}

/** The ticket once `check` holds for it. */
export async function ticketWhen(
  core: Kaeno,
  ticket: string,
  check: (value: Awaited<ReturnType<Kaeno["router"]["ticket"]>>) => boolean,
  what = `ticket ${ticket}`,
): Promise<Awaited<ReturnType<Kaeno["router"]["ticket"]>>> {
  let value: Awaited<ReturnType<Kaeno["router"]["ticket"]>> | undefined;
  await until(async () => {
    value = await core.router.ticket(ticket, context);
    return check(value);
  }, what);
  if (!value) {
    throw new Error(`Missing ${ticket}`);
  }
  return value;
}

/** The router assistant's selectable tools; assistants in tests list these plus extension tools. */
export const ROUTER_ASSISTANT_TOOLS = [
  "route",
  "reply",
  "recall",
  "list_tickets",
  "message_ticket",
  "stop_ticket",
] as const;

/** Whether a model request is the router's (its instructions open with "# Routing") rather than a worker's. */
export function isRouterRequest(request: { messages: Message[] }): boolean {
  return getCurrentSystemPrompt(request.messages).includes("# Routing");
}

/** Everything the model was given since its last answer, as JSON: one turn's batch of inputs. */
export function sinceLastAnswer(request: { messages: Message[] }): string {
  const start = request.messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  return JSON.stringify(request.messages.slice(start + 1));
}
