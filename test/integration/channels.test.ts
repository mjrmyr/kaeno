import { defineTurn } from "../../src/turns/index.ts";
import { createThreadFixture } from "./composition.ts";
import { required } from "./values.ts";
// Telegram against a mock Telegram Bot API and a scripted model.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import {
  configure,
  type ConversationId,
  createRegistry,
  defineExtension,
  Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.ts";
import {
  TelegramClient,
  TelegramNotifier,
  TelegramPoller,
} from "../../src/telegram/index.ts";
import { defineControl, TurnCoordinator } from "../../src/turns/index.ts";
import { messageText, SANDBOX_RESOURCES, serverPort } from "./values.ts";
const until = async (check: () => boolean, ms = 10000) => {
  for (
    const end = Date.now() + ms;
    Date.now() < end;
    await new Promise((resolve) => setTimeout(resolve, 25))
  ) {
    if (check()) {
      return;
    }
  }
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
    const sent: {
      chat_id: number;
      text: string;
    }[] = [];
    const telegram = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
      }
      const body = JSON.parse(raw || "{}");
      const method = required(req.url).split("/").pop();
      let result: unknown = true;
      if (method === "getUpdates") {
        let batch = updates.filter((update) => update.update_id >= body.offset);
        if (!redelivered && body.offset > 10) {
          redelivered = true;
          batch = [required(updates[0]), ...batch];
        } // at-least-once delivery
        if (!batch.length) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        result = batch;
      }
      if (method === "sendMessage") {
        sent.push(body);
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, result }));
    });
    await new Promise<void>((ok) => telegram.listen(0, "127.0.0.1", ok));
    const client = new TelegramClient(
      "TEST",
      fetch,
      `http://127.0.0.1:${serverPort(telegram)}`,
    );
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(
      Array.from({ length: 20 }, () => (request: TranscriptContext) => {
        const last = request.messages.findLast(
          (message) => message.role === "user",
        );
        const text = messageText(required(last));
        return fauxAssistantMessage([
          fauxText(`echo: ${text.split("\n").pop()}`),
        ]);
      }),
    );
    const Turn = defineTurn(() => new TelegramNotifier(client));
    const Control = defineControl(
      () => harness,
      async () => [],
    );
    const registry = createRegistry();
    registry.install(
      defineExtension({ name: "kaeno-channels", tasks: [Turn, Control] }),
    );
    const harness = await Harness.open(
      await openNodeSqliteStorage(join(dir, "k.sqlite")),
      { models, registry },
      BACKGROUND_CONTEXT,
    );
    harness.resume();
    const template = required(
      parseConfig({
        agent: "kaeno",
        sandboxResources: SANDBOX_RESOURCES,
        templates: {
          kaeno: {
            description: "chat",
            model: "anthropic/chat",
            instructions: "profile",
          },
        },
      }).templates.kaeno,
    );
    const deps = createThreadFixture(() => harness, {
      configure: async (tx: Tx, id: ConversationId) => {
        await configure(tx, id, {
          model: { provider: "faux", modelId: "faux-1" },
        });
        return { template, skills: [] };
      },
    });
    const stop = new AbortController();
    const coordinator = new TurnCoordinator(() => harness, Turn, Control);
    const poller = new TelegramPoller(
      () => harness,
      deps.threads,
      coordinator,
      client,
      new Set([111]),
    );
    void poller.pollUpdates(stop.signal);
    await until(
      () =>
        sent.some((message) => message.chat_id === 111) &&
        sent.some((message) => message.chat_id === 222),
    );
    await new Promise((resolve) => setTimeout(resolve, 500)); // give a duplicate the chance to show up
    expect(
      sent
        .filter((message) => message.chat_id === 111)
        .map((message) => message.text),
    ).toEqual(["echo: hello"]); // once, despite redelivery
    expect(
      required(sent.find((message) => message.chat_id === 222)).text,
    ).toMatch(/private.*222/);
    stop.abort();
    await harness.close(BACKGROUND_CONTEXT);
    await new Promise<void>((ok) => telegram.close(() => ok()));
    await rm(dir, { recursive: true, force: true });
  }, 30000);
});
