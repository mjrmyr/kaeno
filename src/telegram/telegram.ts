import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  type ConversationId,
  type Harness,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { parseTaskId } from "../durable/index.ts";
import type { Notify } from "../turns/index.ts";
import type { WorkView } from "../work/index.ts";
export interface TelegramRuntime extends Pick<
  Harness,
  "snapshot" | "commit" | "waitForTask"
> {}
export const TelegramState = defineDoc<{
  offset: number;
}>({
  kind: "kaeno.telegram",
  version: 1,
  scope: "session",
  initial: () => ({ offset: 0 }),
});
const updateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: z
    .object({
      chat: z.object({ id: z.number().int().safe() }),
      text: z.string().optional(),
    })
    .optional(),
});
export interface TelegramUpdate extends z.infer<typeof updateSchema> {}
export interface TelegramThreads {
  getOrCreateConversation(key: string): Promise<ConversationId>;
}
export interface TelegramTurns {
  admitUserTurn(
    tx: Tx,
    id: ConversationId,
    content: string,
    requestId: string,
    notify: Notify,
  ): Promise<TaskId>;
  admitStop(tx: Tx, id: ConversationId): Promise<TaskId>;
  admitReset(tx: Tx, id: ConversationId): Promise<TaskId>;
  admitWorkCancellation(
    tx: Tx,
    id: ConversationId,
    workId: TaskId,
  ): Promise<TaskId>;
}
export interface TelegramWork {
  listWork(id: ConversationId): Promise<WorkView[]>;
}
export interface TelegramTransport {
  fetchUpdates(offset: number, signal: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string): Promise<void>;
  sendTypingIndicator(chatId: number): Promise<void>;
}
export class TelegramClient {
  private readonly token: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly apiBase: string;
  constructor(
    token: string,
    fetch: typeof globalThis.fetch,
    apiBase = "https://api.telegram.org",
  ) {
    this.token = token;
    this.fetch = fetch;
    this.apiBase = apiBase;
  }
  private async call(
    method: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.fetch(
      `${this.apiBase}/bot${this.token}/${method}`,
      {
        method: "POST",
        signal: signal ?? AbortSignal.timeout(60000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const raw: unknown = await response.json();
    const data = z
      .object({
        ok: z.boolean(),
        result: z.unknown().optional(),
        description: z.string().optional(),
      })
      .parse(raw);
    if (!data.ok) {
      throw new Error(
        `telegram ${method}: ${data.description ?? response.status}`,
      );
    }
    return data.result;
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
    for (let index = 0; index < Math.max(text.length, 1); index += 4000) {
      await this.call("sendMessage", {
        chat_id: chatId,
        text: text.slice(index, index + 4000) || "…",
      });
    }
  }
  async sendTypingIndicator(chatId: number): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
  }
}
export class TelegramNotifier {
  private readonly client: TelegramTransport | undefined;
  constructor(client: TelegramTransport | undefined) {
    this.client = client;
  }
  async send(notify: Notify, text: string): Promise<void> {
    if (this.client && notify.telegram !== undefined) {
      await this.client.sendMessage(notify.telegram, text);
    }
  }
  async typing(notify: Notify): Promise<void> {
    if (this.client && notify.telegram !== undefined) {
      await this.client.sendTypingIndicator(notify.telegram);
    }
  }
}
export class TelegramPoller {
  private readonly harness: () => TelegramRuntime;
  private readonly threads: TelegramThreads;
  private readonly turns: TelegramTurns;
  private readonly client: TelegramTransport;
  private readonly allowed: ReadonlySet<number>;
  private readonly work: TelegramWork | undefined;
  constructor(
    harness: () => TelegramRuntime,
    threads: TelegramThreads,
    turns: TelegramTurns,
    client: TelegramTransport,
    allowed: ReadonlySet<number>,
    work?: TelegramWork,
  ) {
    this.harness = harness;
    this.threads = threads;
    this.turns = turns;
    this.client = client;
    this.allowed = allowed;
    this.work = work;
  }
  async pollUpdates(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const offset =
          (await this.harness().snapshot(TelegramState, BACKGROUND_CONTEXT))
            ?.offset ?? 0;
        const updates = await this.client.fetchUpdates(offset, signal);
        for (const update of updates) {
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        console.error(
          "telegram:",
          error instanceof Error ? error.message : error,
        );
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }
  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const chatId = message?.chat.id;
    const text = message?.text?.trim() ?? "";
    const advance = (): Promise<void> =>
      this.harness().commit(async (tx) => {
        (await tx.doc(TelegramState)).offset = update.update_id + 1;
      }, BACKGROUND_CONTEXT);
    if (chatId === undefined || !text) {
      await advance();
      return;
    }
    if (!this.allowed.has(chatId)) {
      await advance();
      console.log(`telegram: refused chat ${chatId}`);
      await this.client
        .sendMessage(
          chatId,
          `This kaeno is private. To allow this chat, add ${chatId} to telegram.allowedChatIds.`,
        )
        .catch(() => {});
      return;
    }
    const id = await this.threads.getOrCreateConversation(`telegram:${chatId}`);
    if (text === "/start") {
      await advance();
      await this.client.sendMessage(
        chatId,
        "Kaeno here. Send me a task. /jobs lists work, /cancel <id> cancels one, /stop stops this chat's work, /new resets context without cancelling work.",
      );
      return;
    }
    if (text === "/stop" || text === "/new") {
      const taskId = await this.harness().commit(async (tx) => {
        const state = await tx.doc(TelegramState);
        const taskId =
          text === "/stop"
            ? await this.turns.admitStop(tx, id)
            : await this.turns.admitReset(tx, id);
        state.offset = update.update_id + 1;
        return taskId;
      }, BACKGROUND_CONTEXT);
      await this.harness().waitForTask(taskId, BACKGROUND_CONTEXT);
      const reply =
        text === "/stop"
          ? "Stop requested. Worker cleanup may still be in progress; /jobs shows status."
          : "Started a fresh context. Existing work continues; /jobs lists it.";
      await this.client.sendMessage(chatId, reply);
      return;
    }
    if (text === "/jobs" && this.work) {
      await advance();
      await this.client.sendMessage(
        chatId,
        JSON.stringify(await this.work.listWork(id), null, 2),
      );
      return;
    }
    const cancel = /^\/cancel ([1-9][0-9]*)$/.exec(text);
    if (cancel && this.work) {
      try {
        const taskId = await this.harness().commit(async (tx) => {
          const taskId = await this.turns.admitWorkCancellation(
            tx,
            id,
            parseTaskId(Number(cancel[1])),
          );
          (await tx.doc(TelegramState)).offset = update.update_id + 1;
          return taskId;
        }, BACKGROUND_CONTEXT);
        await this.harness().waitForTask(taskId, BACKGROUND_CONTEXT);
        await this.client.sendMessage(
          chatId,
          `Cancellation requested for work #${cancel[1]}.`,
        );
      } catch (error) {
        // Recovery: acknowledge the failed command and advance its update rather than retry it indefinitely.
        await advance();
        await this.client.sendMessage(chatId, String(error));
      }
      return;
    }
    await this.harness().commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      if (state.offset > update.update_id) {
        return;
      }
      state.offset = update.update_id + 1;
      await this.turns.admitUserTurn(
        tx,
        id,
        text,
        `telegram:${update.update_id}`,
        { telegram: chatId },
      );
    }, BACKGROUND_CONTEXT);
  }
}
