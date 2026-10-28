import { z } from "zod";

const fileSchema = z.object({
  file_id: z.string().min(1),
  file_size: z.number().int().nonnegative().safe().optional(),
});
const updateSchema = z.object({
  update_id: z.number().int().nonnegative().safe(),
  message: z
    .object({
      chat: z.object({ id: z.number().int().safe(), type: z.string() }),
      from: z
        .object({ id: z.number().int().positive().safe(), is_bot: z.boolean() })
        .optional(),
      text: z.string().optional(),
      caption: z.string().optional(),
      /** The same picture in ascending sizes. */
      photo: z.array(fileSchema).optional(),
      /** A file sent uncompressed, such as an image sent "as file". */
      document: fileSchema
        .extend({ mime_type: z.string().optional() })
        .optional(),
      voice: fileSchema.extend({ mime_type: z.string().optional() }).optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof updateSchema>;
export interface TelegramTransport {
  fetchUpdates(offset: number, signal: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string): Promise<void>;
  /** The caption is at most 1024 characters. */
  sendVoice(
    chatId: number,
    audio: { audio: Uint8Array<ArrayBuffer>; mimeType: string },
    caption?: string,
  ): Promise<void>;
  sendTypingIndicator(chatId: number, action?: "record_voice"): Promise<void>;
  /** Bot API downloads are limited to 20 MB. */
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
            : AbortSignal.timeout(body instanceof FormData ? 60_000 : 10_000),
          ...(body instanceof FormData
            ? { body }
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
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
  async sendMessage(chatId: number, text: string): Promise<void> {
    // Leave room below Telegram's 4096-character limit; never split a surrogate pair.
    const characters = Array.from(text || "…");
    for (let index = 0; index < characters.length; index += 2000) {
      await this.call("sendMessage", {
        chat_id: chatId,
        text: characters.slice(index, index + 2000).join(""),
        link_preview_options: { is_disabled: true },
      });
    }
  }
  async sendVoice(
    chatId: number,
    { audio, mimeType }: { audio: Uint8Array<ArrayBuffer>; mimeType: string },
    caption?: string,
  ): Promise<void> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("voice", new Blob([audio], { type: mimeType }), "kaeno.mp3");
    if (caption) {
      form.set("caption", caption);
    }
    await this.call("sendVoice", form);
  }
  async sendTypingIndicator(
    chatId: number,
    action: "typing" | "record_voice" = "typing",
  ): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action });
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
