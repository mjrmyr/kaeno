import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  defineDoc,
  type TaskId,
  type Tx,
  type UserInput,
} from "@earendil-works/pi-durable";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  ticketLine,
  type ChannelRoute,
  type Stored,
  type Kaeno,
  type KaenoChannel,
} from "../../core/application/index.ts";
import {
  TelegramApiError,
  type TelegramTransport,
  type TelegramUpdate,
} from "./client.ts";

export const telegramConfigurationSchema = z
  .object({
    allowedChatIds: z.array(z.number().int().positive().safe()).min(1),
    /** Give each ticket a topic of its own. Needs the bot's threaded mode; falls back to reply chains. */
    topics: z.boolean().optional(),
  })
  .strict();

interface Pending {
  chatId: number;
  text: string;
  threadId?: number;
  replyTo?: number;
}
function sentMessageKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}
interface TelegramStateShape {
  offset: number;
  pending?: Pending;
  threadOfSent: Record<string, string>;
}
export const TelegramState = defineDoc<Stored<TelegramStateShape>>({
  kind: "kaeno.telegram",
  version: 2,
  scope: "session",
  initial: () => ({ offset: 0, threadOfSent: {} }),
});
const MAX_REMEMBERED_SENT = 2000;
const TOPIC_RETRY_MS = 10 * 60_000;
const maxImageBytes = 5 * 1024 * 1024;
const imageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const help =
  "Kaeno here. Send me anything as text or a photo; each task gets its own thread, and replies there go straight to its worker. /jobs lists tickets; /show <ticket> shows its latest report; /cancel <ticket> stops one; /stop stops this thread's ticket (or all tickets in the main chat); /new gives Kaeno a fresh context and leaves tickets running.";

export interface TelegramChannelOptions {
  allowedChatIds: readonly number[];
  topics?: boolean;
  client: TelegramTransport;
  onError?(error: unknown): void;
}

function mainThread(chatId: number): string {
  return `telegram:${chatId}`;
}
function topicThread(chatId: number, topic: number): string {
  return `telegram:${chatId}/topic:${topic}`;
}
function chainThread(chatId: number, anchor: number): string {
  return `telegram:${chatId}/reply:${anchor}`;
}

export function telegramChannel(options: TelegramChannelOptions): KaenoChannel {
  const allowed = new Set(options.allowedChatIds);
  let attached: Kaeno | undefined;
  let topicsRetryAt = 0;
  function core(): Kaeno {
    if (!attached) {
      throw new Error("Telegram is used before Kaeno started");
    }
    return attached;
  }
  function address(value: string): { chatId: number; threadId?: number } {
    const [chat, topic, ...rest] = value.split(":");
    const chatId = Number(chat);
    const threadId = topic === undefined ? undefined : Number(topic);
    if (
      rest.length > 0 ||
      String(chatId) !== chat ||
      !allowed.has(chatId) ||
      (threadId !== undefined &&
        (!Number.isSafeInteger(threadId) || threadId <= 0))
    ) {
      throw new Error(
        "Telegram delivery address is not an allowed private chat",
      );
    }
    return threadId === undefined ? { chatId } : { chatId, threadId };
  }
  function replyTo(route: ChannelRoute): number | undefined {
    const id = route.replyTo === undefined ? NaN : Number(route.replyTo);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  }
  function remember(
    state: Pick<TelegramStateShape, "threadOfSent">,
    chatId: number,
    messageIds: readonly number[],
    thread: string,
  ): void {
    for (const id of messageIds) {
      state.threadOfSent[sentMessageKey(chatId, id)] = thread;
    }
    const keys = Object.keys(state.threadOfSent);
    for (const key of keys.slice(
      0,
      Math.max(0, keys.length - MAX_REMEMBERED_SENT),
    )) {
      delete state.threadOfSent[key];
    }
  }
  async function advance(
    update: TelegramUpdate,
    pending?: Pending,
  ): Promise<void> {
    await core().harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      if (state.offset <= update.update_id) {
        state.offset = update.update_id + 1;
        if (pending) {
          state.pending = pending;
        }
      }
    }, context);
  }
  type Message = NonNullable<TelegramUpdate["message"]>;
  async function image(message: Message): Promise<UserInput> {
    const file = message.photo?.at(-1) ?? message.document;
    const mimeType = message.photo ? "image/jpeg" : message.document?.mime_type;
    if (!file || !mimeType || !imageTypes.has(mimeType)) {
      throw new Error("Kaeno reads text and images");
    }
    if ((file.file_size ?? 0) > maxImageBytes) {
      throw new Error("Images are limited to 5 MB");
    }
    const data = Buffer.from(await options.client.download(file.file_id));
    const caption = message.caption?.trim();
    return [
      ...(caption ? [{ type: "text" as const, text: caption }] : []),
      { type: "image", data: data.toString("base64"), mimeType },
    ];
  }
  function threadOf(
    message: Message,
    threadOfSent: TelegramStateShape["threadOfSent"],
  ): string {
    const chatId = message.chat.id;
    const replied = message.reply_to_message
      ? threadOfSent[
          sentMessageKey(chatId, message.reply_to_message.message_id)
        ]
      : undefined;
    if (replied) {
      return replied;
    }
    if (message.is_topic_message && message.message_thread_id !== undefined) {
      return topicThread(chatId, message.message_thread_id);
    }
    return mainThread(chatId);
  }
  async function command(
    tx: Tx,
    text: string,
    thread: string,
    chatId: number,
  ): Promise<{ reply: string; abort: TaskId[]; compact?: true }> {
    const router = core().router;
    if (text === "/stop") {
      const main = thread === mainThread(chatId);
      const { tickets, works } = await router.stopAll(
        tx,
        main ? undefined : thread,
      );
      let reply = main
        ? "Nothing is running."
        : "No ticket follows this thread.";
      if (tickets.length) {
        reply = `Stopped ${tickets.join(", ")}. Sandbox cleanup may still be in progress.`;
      }
      return { reply, abort: works };
    }
    if (text === "/new") {
      return {
        reply:
          "Fresh context requested. Tickets keep running; /jobs lists them.",
        abort: [],
        compact: true,
      };
    }
    if (text === "/jobs" || text === "/status") {
      const tickets = await router.listTickets(context);
      return {
        reply: tickets.length
          ? tickets.map(ticketLine).join("\n")
          : "No open tickets.",
        abort: [],
      };
    }
    const target = /^\/(cancel|show) k?([1-9][0-9]*)$/.exec(text);
    if (target) {
      const id = `k${target[2]}`;
      if (target[1] === "cancel") {
        const works = await router.stopTicket(
          tx,
          id,
          "owner",
          "cancelled by the owner",
        );
        return { reply: `Cancellation requested for ${id}.`, abort: works };
      }
      const ticket = await router.ticket(id, context);
      const report = ticket.reports.at(-1);
      return {
        reply: report
          ? `${ticketLine(ticket)}\n\n${report.summary}`
          : `${ticketLine(ticket)}\n\nNo report yet.`,
        abort: [],
      };
    }
    return {
      reply:
        text === "/start" || text === "/help"
          ? help
          : `Unknown command. ${help}`,
      abort: [],
    };
  }
  async function handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const text = message?.text?.trim() ?? "";
    if (
      !message ||
      !(text || message.photo?.length || message.document) ||
      message.chat.type !== "private" ||
      message.from?.is_bot !== false ||
      message.from.id !== message.chat.id ||
      !allowed.has(message.chat.id)
    ) {
      await advance(update);
      return;
    }
    const chatId = message.chat.id;
    const topic =
      message.is_topic_message && message.message_thread_id !== undefined
        ? message.message_thread_id
        : undefined;
    const messageId = message.message_id;
    function answer(text: string): Pending {
      return {
        chatId,
        text,
        replyTo: messageId,
        ...(topic === undefined ? {} : { threadId: topic }),
      };
    }
    try {
      const input = text ? undefined : await image(message);
      const outcome = await core().harness.commit(async (tx: Tx) => {
        const state = await tx.doc(TelegramState);
        if (state.offset > update.update_id) {
          return undefined;
        }
        const thread = threadOf(message, state.threadOfSent);
        let result: Awaited<ReturnType<typeof command>> | undefined;
        if (text.startsWith("/")) {
          result = await command(tx, text, thread, chatId);
          state.pending = answer(result.reply);
        } else {
          const quoted =
            message.reply_to_message?.text ?? message.reply_to_message?.caption;
          await core().router.receive(tx, {
            key: `telegram:${update.update_id}`,
            source: "telegram",
            threads: [thread],
            actor: `telegram:${message.from?.id ?? chatId}`,
            authority: "owner",
            content: input ?? text,
            route: {
              channel: "telegram",
              address:
                topic === undefined ? String(chatId) : `${chatId}:${topic}`,
              replyTo: String(message.message_id),
            },
            ...(quoted === undefined ? {} : { quote: quoted }),
          });
        }
        state.offset = update.update_id + 1;
        return result;
      }, context);
      if (outcome) {
        try {
          await core().router.abortWorks(outcome.abort, context);
          if (outcome.compact) {
            await core().router.compact(context);
          }
        } catch (error) {
          options.onError?.(error);
        }
      }
    } catch (error) {
      // A rejected input must not trap the poller ahead of a later /stop or /new.
      // If persistence itself is unavailable this commit also fails, leaving the update retryable.
      await advance(
        update,
        answer(
          `Could not accept that request: ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }
  }
  async function flush(): Promise<void> {
    const pending = (await core().harness.snapshot(TelegramState, context))
      ?.pending;
    if (pending) {
      if (allowed.has(pending.chatId)) {
        try {
          await options.client.sendMessage(pending.chatId, pending.text, {
            ...(pending.threadId === undefined
              ? {}
              : { threadId: pending.threadId }),
            ...(pending.replyTo === undefined
              ? {}
              : { replyTo: pending.replyTo }),
          });
        } catch (error) {
          // A blocked chat or invalid reply must not prevent another chat's /stop.
          if (
            !(error instanceof TelegramApiError) ||
            ![400, 403].includes(error.code)
          ) {
            throw error;
          }
          options.onError?.(error);
        }
      } else {
        options.onError?.(
          new Error("Discarded a Telegram command reply for a revoked chat"),
        );
      }
      await core().harness.commit(async (tx) => {
        delete (await tx.doc(TelegramState)).pending;
      }, context);
    }
  }
  async function poll(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        // This single-slot outbox bounds command acknowledgments and survives restarts.
        // Telegram has no send idempotency key: a crash after send can duplicate a reply.
        await flush();
        const offset =
          (await core().harness.snapshot(TelegramState, context))?.offset ?? 0;
        if (signal.aborted) {
          return;
        }
        const updates = await options.client.fetchUpdates(offset, signal);
        for (const update of updates) {
          if (signal.aborted) {
            return;
          }
          if (update.update_id < offset) {
            continue;
          }
          await handle(update);
          await flush();
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        options.onError?.(error);
        await delay(5000, undefined, { signal }).catch(() => {});
      }
    }
  }
  return {
    delivery: {
      channel: "telegram",
      maxWords: 100,
      send: async (route, text, thread) => {
        const { chatId, threadId } = address(route.address);
        const anchor = replyTo(route);
        const ids = await options.client.sendMessage(chatId, text, {
          ...(threadId === undefined ? {} : { threadId }),
          ...(anchor === undefined ? {} : { replyTo: anchor }),
        });
        await core().harness.commit(async (tx) => {
          remember(await tx.doc(TelegramState), chatId, ids, thread);
        }, context);
      },
      typing: async (route) => {
        const { chatId, threadId } = address(route.address);
        await options.client.sendTypingIndicator(chatId, threadId);
      },
      async openThread(route, title) {
        const { chatId, threadId } = address(route.address);
        if (
          options.topics &&
          threadId === undefined &&
          Date.now() >= topicsRetryAt
        ) {
          try {
            const topic = await options.client.createTopic(chatId, title);
            return {
              key: topicThread(chatId, topic),
              route: { channel: "telegram", address: `${chatId}:${topic}` },
            };
          } catch (error) {
            // Topic creation in private chats is not available everywhere; a reply chain always works.
            // Without threaded mode every attempt fails, so wait before asking again.
            topicsRetryAt = Date.now() + TOPIC_RETRY_MS;
            options.onError?.(error);
          }
        }
        const anchor = replyTo(route);
        if (anchor === undefined) {
          return undefined;
        }
        const key = chainThread(chatId, anchor);
        await core().harness.commit(async (tx) => {
          remember(await tx.doc(TelegramState), chatId, [anchor], key);
        }, context);
        return {
          key,
          route: {
            channel: "telegram",
            address: route.address,
            replyTo: String(anchor),
          },
        };
      },
    },
    async start(kaeno, signal) {
      attached = kaeno;
      const polling = poll(signal);
      return async () => {
        await polling;
      };
    },
  };
}
