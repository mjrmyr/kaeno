// Telegram channel: long polling (outbound only, no ingress), one kaeno thread per chat.
// Each accepted message becomes a durable Turn task in the same commit that advances the update offset, so a
// restart neither drops nor repeats a message. Only allow-listed chats are served.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import type { Notifier, ThreadDeps } from "./threads.ts";
import { thread } from "./threads.ts";

export const TelegramState = defineDoc<{ offset: number }>({
  kind: "kaeno.telegram", version: 1, scope: "session", initial: () => ({ offset: 0 }),
});

export function telegramClient(token: string, apiBase = "https://api.telegram.org") {
  async function call(method: string, body: object, signal?: AbortSignal) {
    const response = await fetch(`${apiBase}/bot${token}/${method}`, {
      method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json() as { ok: boolean; result?: any; description?: string };
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? response.status}`);
    return data.result;
  }
  return {
    call,
    async send(chatId: number, text: string) {
      for (let i = 0; i < Math.max(text.length, 1); i += 4000) await call("sendMessage", { chat_id: chatId, text: text.slice(i, i + 4000) || "…" });
    },
    typing: (chatId: number) => call("sendChatAction", { chat_id: chatId, action: "typing" }),
  };
}
export type TelegramClient = ReturnType<typeof telegramClient>;

export const telegramNotifier = (client: TelegramClient | undefined): Notifier => ({
  send: async (notify, text) => { if (client && notify.telegram !== undefined) await client.send(notify.telegram, text); },
  typing: async notify => { if (client && notify.telegram !== undefined) await client.typing(notify.telegram); },
});

type Deps = ThreadDeps & { client: TelegramClient; allowed: Set<number>; Turn: any; signal: AbortSignal };

export async function pollTelegram(deps: Deps) {
  const { client, allowed, harness, signal } = deps;
  while (!signal.aborted) {
    try {
      const offset = (await harness().snapshot(TelegramState, BACKGROUND_CONTEXT))?.offset ?? 0;
      const updates = await client.call("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }, signal) as any[];
      for (const update of updates) await handle(deps, update);
    } catch (error) {
      if (signal.aborted) return;
      console.error("telegram:", error instanceof Error ? error.message : error);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function handle(deps: Deps, update: any) {
  const { client, allowed, harness } = deps;
  const message = update.message;
  const chatId: number | undefined = message?.chat?.id;
  const text: string = (message?.text ?? "").trim();
  const advance = () => harness().commit(async tx => { (await tx.doc(TelegramState)).offset = update.update_id + 1; }, BACKGROUND_CONTEXT);
  if (chatId === undefined || !text) return advance();
  if (!allowed.has(chatId)) {
    await advance();
    console.log(`telegram: refused chat ${chatId}`);
    return client.send(chatId, `This kaeno is private. To allow this chat, add ${chatId} to telegram.allowedChatIds.`).catch(() => {});
  }
  const key = `telegram:${chatId}`;
  const conversationId = await thread(deps, key);
  const conversation = await harness().conversation(conversationId, BACKGROUND_CONTEXT);
  if (text === "/start") { await advance(); return client.send(chatId, "Kaeno here. Send me a task. /stop aborts the current work, /new starts a fresh context."); }
  if (text === "/stop") { await advance(); await conversation?.abort(BACKGROUND_CONTEXT); return; }
  if (text === "/new") { await advance(); await conversation?.reset(undefined, BACKGROUND_CONTEXT); return client.send(chatId, "Started a fresh context."); }
  // One commit: the turn exists if and only if the offset moved past this update.
  await harness().commit(async tx => {
    const state = await tx.doc(TelegramState);
    if (state.offset > update.update_id) return;
    state.offset = update.update_id + 1;
    await tx.createTask(deps.Turn, {
      conversationId, content: text, requestId: `telegram:${update.update_id}`, notify: { telegram: chatId },
    }, { ownership: { kind: "conversation" }, conversationId, background: true });
  }, BACKGROUND_CONTEXT);
}
