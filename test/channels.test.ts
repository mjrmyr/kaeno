// Telegram against a mock Telegram Bot API and a scripted model.
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { pollTelegram, telegramClient, telegramNotifier } from "../src/telegram.ts";
import { defineTurn } from "../src/threads.ts";

const until = async (check: () => boolean, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 25))) if (check()) return;
  throw new Error("timed out");
};

describe("channels", () => {
  it("serves allow-listed Telegram chats exactly once, refuses others", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kaeno-channels-"));
    // Mock Telegram: hands out updates by offset (re-delivering the first one once more), records sent messages.
    const updates = [
      { update_id: 10, message: { chat: { id: 111 }, text: "hello" } },
      { update_id: 11, message: { chat: { id: 222 }, text: "let me in" } },
    ];
    let redelivered = false;
    const sent: { chat_id: number; text: string }[] = [];
    const telegram = createServer(async (req, res) => {
      let raw = ""; for await (const c of req) raw += c;
      const body = JSON.parse(raw || "{}");
      const method = req.url!.split("/").pop();
      let result: unknown = true;
      if (method === "getUpdates") {
        let batch = updates.filter(u => u.update_id >= body.offset);
        if (!redelivered && body.offset > 10) { redelivered = true; batch = [updates[0]!, ...batch]; } // at-least-once delivery
        if (!batch.length) await new Promise(r => setTimeout(r, 100));
        result = batch;
      }
      if (method === "sendMessage") sent.push(body);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
    });
    await new Promise<void>(ok => telegram.listen(0, "127.0.0.1", ok));
    const client = telegramClient("TEST", `http://127.0.0.1:${(telegram.address() as AddressInfo).port}`);

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(Array.from({ length: 20 }, () => (request: any) => {
      const last = request.messages.findLast((m: any) => m.role === "user");
      const text = typeof last.content === "string" ? last.content : last.content.map((p: any) => p.text ?? "").join("");
      return fauxAssistantMessage([fauxText(`echo: ${text.split("\n").pop()}`)]);
    }));
    const Turn = defineTurn(() => telegramNotifier(client));
    const registry = createRegistry();
    registry.install(defineExtension({ name: "kaeno-channels", tasks: [Turn] }));
    const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "k.sqlite")), { models, registry }, BACKGROUND_CONTEXT);
    harness.resume();
    const deps = { harness: () => harness, agent: { template: "kaeno", change: () => ({ model: { provider: "faux", modelId: "faux-1" } }) } };

    const stop = new AbortController();
    void pollTelegram({ ...deps, client, allowed: new Set([111]), Turn, signal: stop.signal });
    await until(() => sent.some(m => m.chat_id === 111) && sent.some(m => m.chat_id === 222));
    await new Promise(r => setTimeout(r, 500)); // give a duplicate the chance to show up
    expect(sent.filter(m => m.chat_id === 111).map(m => m.text)).toEqual(["echo: hello"]); // once, despite redelivery
    expect(sent.find(m => m.chat_id === 222)!.text).toMatch(/private.*222/);
    stop.abort();

    await harness.close(BACKGROUND_CONTEXT);
    await new Promise<void>(ok => telegram.close(() => ok()));
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});
