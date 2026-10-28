import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineExtension,
  type Tx,
  type UserInput,
} from "@earendil-works/pi-durable";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  listWork,
  parseTaskId,
  type Kaeno,
  type KaenoExtension,
} from "../../core/application/index.ts";
import type { Speech } from "../speech/index.ts";
import { speechConfigurationSchema } from "../speech/index.ts";
import {
  TelegramApiError,
  type TelegramTransport,
  type TelegramUpdate,
} from "./client.ts";

export const telegramConfigurationSchema = z
  .object({
    allowedChatIds: z.array(z.number().int().positive().safe()).min(1),
    /** Without it, voice messages are refused and replies are always text. */
    speech: speechConfigurationSchema.optional(),
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
// The strictest provider limit for one image.
const maxImageBytes = 5 * 1024 * 1024;
const imageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
// Longer replies are sent as text only: minutes of speech are worse than reading.
const maxSpokenCharacters = 3000;
const voiceNote =
  "[Voice message, transcribed. Your reply is read aloud: answer as you would speak, without Markdown, tables or code unless asked.]";
const help =
  "Kaeno here. Send me a task as text, a photo or a voice message. /jobs lists work; /cancel <id> cancels one; /stop stops this chat and its work; /new resets context but leaves existing work running.";

export interface TelegramExtensionOptions {
  allowedChatIds: readonly number[];
  client: TelegramTransport;
  speech?: Speech;
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
  type Message = NonNullable<TelegramUpdate["message"]>;
  /** Downloads and transcribes before the transaction; a retried update repeats this. */
  async function media(
    message: Message,
  ): Promise<{ content: UserInput; voice?: boolean }> {
    if (message.voice) {
      if (!options.speech) {
        throw new Error(
          "Voice messages need speech in the Telegram configuration",
        );
      }
      const transcript = await options.speech.transcribe(
        await options.client.download(message.voice.file_id),
        message.voice.mime_type ?? "audio/ogg",
      );
      if (!transcript) {
        throw new Error("No speech recognized in that voice message");
      }
      return { content: `${voiceNote}\n${transcript}`, voice: true };
    }
    const file = message.photo?.at(-1) ?? message.document;
    const mimeType = message.photo ? "image/jpeg" : message.document?.mime_type;
    if (!file || !mimeType || !imageTypes.has(mimeType)) {
      throw new Error("Kaeno reads text, images and voice messages");
    }
    if ((file.file_size ?? 0) > maxImageBytes) {
      throw new Error("Images are limited to 5 MB");
    }
    const data = Buffer.from(await options.client.download(file.file_id));
    const caption = message.caption?.trim();
    return {
      content: [
        ...(caption ? [{ type: "text" as const, text: caption }] : []),
        { type: "image", data: data.toString("base64"), mimeType },
      ],
    };
  }
  async function handle(core: Kaeno, update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const text = message?.text?.trim() ?? "";
    if (
      !message ||
      !(text || message.photo?.length || message.document || message.voice) ||
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
      const input = text ? undefined : await media(message);
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
            input?.content ?? text,
            `telegram:${update.update_id}`,
            {
              route: {
                channel: "telegram",
                address: String(chatId),
                ...(input?.voice ? { voice: true } : {}),
              },
            },
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
      async send(route, text) {
        const chatId = address(route.address);
        if (
          route.voice &&
          options.speech &&
          text.length <= maxSpokenCharacters
        ) {
          try {
            await options.client.sendVoice(
              chatId,
              await options.speech.synthesize(text),
              text.length <= 1024 ? text : undefined,
            );
          } catch (error) {
            // Speech is a nicety: the reply itself must still arrive.
            options.onError?.(error);
            await options.client.sendMessage(chatId, text);
            return;
          }
          if (text.length > 1024) {
            await options.client.sendMessage(chatId, text);
          }
          return;
        }
        await options.client.sendMessage(chatId, text);
      },
      typing: async (route) =>
        route.voice
          ? options.client.sendTypingIndicator(
              address(route.address),
              "record_voice",
            )
          : options.client.sendTypingIndicator(address(route.address)),
    },
    async start(core, signal) {
      const polling = poll(core, signal);
      return async () => {
        await polling;
      };
    },
  };
}
