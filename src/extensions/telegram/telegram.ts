import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineExtension,
  type Tx,
} from "@earendil-works/pi-durable";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  listWork,
  parseTaskId,
  type Kaeno,
  type KaenoExtension,
} from "../../core/application/index.ts";
import {
  TelegramApiError,
  type TelegramTransport,
  type TelegramUpdate,
} from "./client.ts";

export const telegramConfigurationSchema = z
  .object({
    allowedChatIds: z.array(z.number().int().positive().safe()).min(1),
  })
  .strict();

const TelegramState = defineDoc<{
  offset: number;
  pending?: { chatId: number; text: string };
}>({
  kind: "kaeno.telegram",
  version: 1,
  scope: "session",
  initial: () => ({ offset: 0 }),
});
const help =
  "Kaeno here. Send me a task. /jobs lists work; /cancel <id> cancels one; /stop stops this chat and its work; /new resets context but leaves existing work running.";

export interface TelegramExtensionOptions {
  allowedChatIds: readonly number[];
  client: TelegramTransport;
  onError?(error: unknown): void;
}

/** One private Telegram chat maps to one durable CHAT thread. */
export function telegramExtension(
  options: TelegramExtensionOptions,
): KaenoExtension {
  const allowed = new Set(options.allowedChatIds);
  function address(value: string): number {
    const id = Number(value);
    if (String(id) !== value || !allowed.has(id)) {
      throw new Error(
        "Telegram delivery address is not an allowed private chat",
      );
    }
    return id;
  }
  async function advance(
    core: Kaeno,
    update: TelegramUpdate,
    pending?: { chatId: number; text: string },
  ): Promise<void> {
    await core.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      if (state.offset <= update.update_id) {
        state.offset = update.update_id + 1;
        if (pending) {
          state.pending = pending;
        }
      }
    }, context);
  }
  async function handle(core: Kaeno, update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const text = message?.text?.trim();
    if (
      !message ||
      !text ||
      message.chat.type !== "private" ||
      message.from?.is_bot !== false ||
      message.from.id !== message.chat.id ||
      !allowed.has(message.chat.id)
    ) {
      await advance(core, update);
      return;
    }
    const chatId = message.chat.id;
    const id = await core.threads.getOrCreateConversation(`telegram:${chatId}`);
    try {
      const jobs =
        text === "/jobs" || text === "/status"
          ? await listWork(() => core.harness, id)
          : undefined;
      await core.harness.commit(async (tx: Tx) => {
        const state = await tx.doc(TelegramState);
        if (state.offset > update.update_id) {
          return;
        }
        let reply: string | undefined;
        if (text === "/stop") {
          await core.turns.admitStop(tx, id);
          reply =
            "Stop requested. WORK and sandbox cleanup may still be in progress; /jobs shows status.";
        } else if (text === "/new") {
          await core.turns.admitReset(tx, id);
          reply =
            "Fresh context requested. Existing work continues; /jobs lists it.";
        } else if (jobs) {
          reply = jobs.length
            ? jobs
                .map((job) => `#${job.id} ${job.title} [${job.status}]`)
                .join("\n")
            : "No work in this chat.";
        } else if (/^\/cancel [1-9][0-9]*$/.test(text)) {
          const workId = parseTaskId(Number(text.slice(8)));
          if ((await tx.task(workId))?.kind !== "kaeno.work") {
            throw new Error("Not a WORK activity");
          }
          // Core validates conversation ownership in this same transaction.
          await core.turns.admitActivityCancellation(tx, id, workId);
          reply = `Cancellation requested for work #${workId}.`;
        } else if (text.startsWith("/")) {
          reply =
            text === "/start" || text === "/help"
              ? help
              : `Unknown command. ${help}`;
        } else {
          await core.turns.admitUserTurn(
            tx,
            id,
            text,
            `telegram:${update.update_id}`,
            { route: { channel: "telegram", address: String(chatId) } },
          );
        }
        state.offset = update.update_id + 1;
        if (reply) {
          state.pending = { chatId, text: reply };
        }
      }, context);
    } catch (error) {
      // A rejected input must not trap the poller ahead of a later /stop or /new.
      // If persistence itself is unavailable this commit also fails, leaving the update retryable.
      await advance(core, update, {
        chatId,
        text: `Could not accept that request: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
    }
  }
  async function flush(core: Kaeno): Promise<void> {
    const pending = (await core.harness.snapshot(TelegramState, context))
      ?.pending;
    if (pending) {
      if (allowed.has(pending.chatId)) {
        try {
          await options.client.sendMessage(pending.chatId, pending.text);
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
      await core.harness.commit(async (tx) => {
        delete (await tx.doc(TelegramState)).pending;
      }, context);
    }
  }
  async function poll(core: Kaeno, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        // This single-slot outbox bounds command acknowledgments and survives restarts.
        // Telegram has no send idempotency key: a crash after send can duplicate a reply.
        await flush(core);
        const offset =
          (await core.harness.snapshot(TelegramState, context))?.offset ?? 0;
        const updates = await options.client.fetchUpdates(offset, signal);
        for (const update of updates) {
          if (signal.aborted) {
            return;
          }
          if (update.update_id < offset) {
            continue;
          }
          await handle(core, update);
          await flush(core);
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
    durable: defineExtension({ name: "kaeno-telegram" }),
    delivery: {
      channel: "telegram",
      send: async (value, text) =>
        options.client.sendMessage(address(value), text),
      typing: async (value) =>
        options.client.sendTypingIndicator(address(value)),
    },
    async start(core, signal) {
      const polling = poll(core, signal);
      return async () => {
        await polling;
      };
    },
  };
}
