// Telegram channel: long polling (outbound only, no ingress), one kaeno thread per chat.
// Each accepted message becomes a durable Turn task in the same commit that advances the update offset, so a
// restart neither drops nor repeats a message. Only allow-listed chats are served.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import type { Notifier, ThreadDeps } from "./threads.ts";
import { thread } from "./threads.ts";
import { admitTurn, admitControl, admitCancel, type ControlTask } from "./turns.ts";
import type { WorkController } from "./work.ts";

export const TelegramState = defineDoc<{ offset: number }>({
  kind: "kaeno.telegram", version: 1, scope: "session", initial: () => ({ offset: 0 }),
});

export function telegramClient(token: string, apiBase = "https://api.telegram.org") {
  async function call(method: string, body: object, signal?: AbortSignal) {
    const response = await fetch(`${apiBase}/bot${token}/${method}`, {
      method: "POST", signal: signal ?? AbortSignal.timeout(60_000), headers: { "content-type": "application/json" }, body: JSON.stringify(body),
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

type Deps = ThreadDeps & { client: TelegramClient; allowed: Set<number>; Turn: any; work?: WorkController; Control?: ControlTask; signal: AbortSignal };

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
  if (text === "/start") { await advance(); return client.send(chatId, "Kaeno here. Send me a task. /jobs lists work, /cancel <id> cancels one, /stop stops this chat's work, /new resets context without cancelling work."); }
  if (text === "/stop") {
    if (deps.Control) {
      const id = await harness().commit(async tx => {
        const state = await tx.doc(TelegramState);
        const id = await admitControl(tx, deps.Control!, conversationId, "stop");
        state.offset = update.update_id + 1; return id;
      }, BACKGROUND_CONTEXT);
      await harness().waitForTask(id, BACKGROUND_CONTEXT);
    } else { await advance(); await conversation?.abort(BACKGROUND_CONTEXT); }
    return client.send(chatId, "Stop requested. Worker cleanup may still be in progress; /jobs shows status.");
  }
  if (text === "/new") {
    if (deps.Control) {
      const id = await harness().commit(async tx => {
        const state = await tx.doc(TelegramState);
        const id = await admitControl(tx, deps.Control!, conversationId, "reset");
        state.offset = update.update_id + 1; return id;
      }, BACKGROUND_CONTEXT);
      await harness().waitForTask(id, BACKGROUND_CONTEXT);
    } else { await advance(); await conversation?.reset(undefined, BACKGROUND_CONTEXT); }
    return client.send(chatId, "Started a fresh context. Existing work continues; /jobs lists it.");
  }
  if (text === "/jobs" && deps.work) { await advance(); return client.send(chatId, JSON.stringify(await deps.work.list(conversationId), null, 2)); }
  const cancel = /^\/cancel ([1-9][0-9]*)$/.exec(text);
  if (cancel && deps.work) {
    try {
      if (deps.Control) {
        const id = await harness().commit(async tx => {
          const state = await tx.doc(TelegramState);
          const id = await admitCancel(tx, deps.Control!, conversationId, Number(cancel[1]) as import("@earendil-works/pi-durable").TaskId);
          state.offset = update.update_id + 1; return id;
        }, BACKGROUND_CONTEXT);
        await harness().waitForTask(id, BACKGROUND_CONTEXT);
      } else { await advance(); await deps.work.cancel(conversationId, Number(cancel[1]) as import("@earendil-works/pi-durable").TaskId); }
      return client.send(chatId, `Cancellation requested for work #${cancel[1]}.`);
    } catch (error) { await advance(); return client.send(chatId, String(error)); }
  }
  // One commit: the turn exists if and only if the offset moved past this update.
  await harness().commit(async tx => {
    const state = await tx.doc(TelegramState);
    if (state.offset > update.update_id) return;
    state.offset = update.update_id + 1;
    await admitTurn(tx, deps.Turn, {
      conversationId, content: text, requestId: `telegram:${update.update_id}`, notify: { telegram: chatId },
    });
  }, BACKGROUND_CONTEXT);
}
