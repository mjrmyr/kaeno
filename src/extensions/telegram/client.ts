import { z } from "zod";

const fileSchema = z.object({
  file_id: z.string().min(1),
  file_size: z.number().int().nonnegative().safe().optional(),
});
const updateSchema = z.object({
  update_id: z.number().int().nonnegative().safe(),
  message: z
    .object({
      message_id: z.number().int().positive().safe(),
      /** Set for messages in a topic, including topics of a private chat with the bot. */
      message_thread_id: z.number().int().positive().safe().optional(),
      is_topic_message: z.boolean().optional(),
      reply_to_message: z
        .object({
          message_id: z.number().int().positive().safe(),
          text: z.string().optional(),
          caption: z.string().optional(),
        })
        .optional(),
      chat: z.object({ id: z.number().int().safe(), type: z.string() }),
      from: z
        .object({ id: z.number().int().positive().safe(), is_bot: z.boolean() })
        .optional(),
      text: z.string().optional(),
      caption: z.string().optional(),
      photo: z.array(fileSchema).optional(),
      document: fileSchema
        .extend({ mime_type: z.string().optional() })
        .optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof updateSchema>;
const sentSchema = z.object({ message_id: z.number().int().positive().safe() });
export interface SendOptions {
  /** A topic of the chat. */
  threadId?: number;
  /** The message this one answers; sent anyway if it is gone. */
  replyTo?: number;
}
export interface TelegramTransport {
  fetchUpdates(offset: number, signal: AbortSignal): Promise<TelegramUpdate[]>;
  /** Returns the IDs of the messages sent, one per chunk. */
  sendMessage(
    chatId: number,
    text: string,
    options?: SendOptions,
  ): Promise<number[]>;
  sendTypingIndicator(chatId: number, threadId?: number): Promise<void>;
  /** A new topic in the chat; private chats need the bot's threaded mode. Returns its thread ID. */
  createTopic(chatId: number, name: string): Promise<number>;
  download(fileId: string): Promise<Uint8Array<ArrayBuffer>>;
}

export class TelegramApiError extends Error {
  readonly code: number;
  constructor(method: string, code: number) {
    super(`Telegram ${method}: API error ${code}`);
    this.code = code;
  }
}

/** Telegram's token stays on the host. No webhook or public listener is needed. */
export class TelegramClient implements TelegramTransport {
  private readonly token: string;
  private readonly fetch: typeof globalThis.fetch;
  constructor(
    token: string,
    fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.token = z.string().trim().min(1).parse(token);
    this.fetch = fetch;
  }
  private async call(
    method: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      const response = await this.fetch(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
            : AbortSignal.timeout(10_000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = z
        .object({
          ok: z.boolean(),
          result: z.unknown().optional(),
          error_code: z.number().optional(),
        })
        .parse(await response.json());
      if (!response.ok || !data.ok) {
        throw new TelegramApiError(method, data.error_code ?? response.status);
      }
      return data.result;
    } catch (error) {
      if (error instanceof TelegramApiError) {
        throw error;
      }
      // Fetch errors can contain the request URL, which embeds the bot token.
      const message = error instanceof Error ? error.message : "Request failed";
      throw new Error(
        `Telegram ${method}: ${message.replaceAll(this.token, "[redacted]")}`,
      );
    }
  }
  async fetchUpdates(
    offset: number,
    signal: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    return z
      .array(updateSchema)
      .parse(
        await this.call(
          "getUpdates",
          { offset, timeout: 50, allowed_updates: ["message"] },
          signal,
        ),
      );
  }
  async sendMessage(
    chatId: number,
    text: string,
    options: SendOptions = {},
  ): Promise<number[]> {
    // Leave room below Telegram's 4096-character limit; never split a surrogate pair.
    const characters = Array.from(text || "…");
    const ids: number[] = [];
    for (let index = 0; index < characters.length; index += 2000) {
      const sent = sentSchema.parse(
        await this.call("sendMessage", {
          chat_id: chatId,
          text: characters.slice(index, index + 2000).join(""),
          link_preview_options: { is_disabled: true },
          ...(options.threadId === undefined
            ? {}
            : { message_thread_id: options.threadId }),
          ...(options.replyTo === undefined || index > 0
            ? {}
            : {
                reply_parameters: {
                  message_id: options.replyTo,
                  allow_sending_without_reply: true,
                },
              }),
        }),
      );
      ids.push(sent.message_id);
    }
    return ids;
  }
  async sendTypingIndicator(chatId: number, threadId?: number): Promise<void> {
    await this.call("sendChatAction", {
      chat_id: chatId,
      action: "typing",
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
    });
  }
  async createTopic(chatId: number, name: string): Promise<number> {
    return z
      .object({ message_thread_id: z.number().int().positive().safe() })
      .parse(
        await this.call("createForumTopic", {
          chat_id: chatId,
          name: Array.from(name).slice(0, 128).join(""),
        }),
      ).message_thread_id;
  }
  async download(fileId: string): Promise<Uint8Array<ArrayBuffer>> {
    const { file_path: path } = z
      .object({ file_path: z.string().min(1) })
      .parse(await this.call("getFile", { file_id: fileId }));
    let response: Response;
    try {
      response = await this.fetch(
        `https://api.telegram.org/file/bot${this.token}/${path}`,
        { signal: AbortSignal.timeout(60_000) },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      throw new Error(
        `Telegram download: ${message.replaceAll(this.token, "[redacted]")}`,
      );
    }
    if (!response.ok) {
      throw new TelegramApiError("download", response.status);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
