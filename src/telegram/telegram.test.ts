import { expect, it, vi } from "vitest";
import {
  createMockRuntime,
  createMockTransaction,
} from "../../test/mocks/durable.ts";
import { conversationId, taskId } from "../../test/mocks/identifiers.ts";
import {
  TelegramClient,
  TelegramNotifier,
  TelegramPoller,
  type TelegramThreads,
  type TelegramTransport,
  type TelegramTurns,
} from "./index.ts";
vi.mock("@earendil-works/pi-durable", async () => {
  const { createMockSdk } = await import("../../test/mocks/sdk.ts");
  return createMockSdk();
});
it("parses update data through an injected HTTP transport", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        ok: true,
        result: [
          { update_id: 12, message: { chat: { id: 111 }, text: "hello" } },
        ],
      }),
    ),
  );
  const client = new TelegramClient(
    "token",
    transport,
    "https://telegram.test",
  );
  expect(await client.fetchUpdates(10, new AbortController().signal)).toEqual([
    { update_id: 12, message: { chat: { id: 111 }, text: "hello" } },
  ]);
  expect(transport.mock.calls[0][0]).toBe(
    "https://telegram.test/bottoken/getUpdates",
  );
});
it("rejects malformed updates and API failures rather than admitting them", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, result: [{ update_id: "bad" }] }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "denied" })),
    );
  const client = new TelegramClient("token", transport);
  await expect(
    client.fetchUpdates(0, new AbortController().signal),
  ).rejects.toThrow();
  await expect(client.sendMessage(111, "hello")).rejects.toThrow(/denied/);
});
it("splits outbound messages while retaining the caller's chat route", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () => new Response(JSON.stringify({ ok: true, result: true })),
    );
  const client = new TelegramClient("token", transport);
  await client.sendMessage(111, "x".repeat(4001));
  expect(transport).toHaveBeenCalledTimes(2);
});
it("sends notifications only to their captured Telegram route", async () => {
  const client: TelegramTransport = {
    fetchUpdates: vi.fn<TelegramTransport["fetchUpdates"]>(),
    sendMessage: vi
      .fn<TelegramTransport["sendMessage"]>()
      .mockResolvedValue(undefined),
    sendTypingIndicator: vi
      .fn<TelegramTransport["sendTypingIndicator"]>()
      .mockResolvedValue(undefined),
  };
  const notifier = new TelegramNotifier(client);
  await notifier.send({}, "no route");
  await notifier.send({ telegram: 111 }, "reply");
  expect(client.sendMessage).toHaveBeenCalledExactlyOnceWith(111, "reply");
  await notifier.send(
    { route: { channel: "telegram", address: "222" } },
    "generic reply",
  );
  expect(client.sendMessage).toHaveBeenLastCalledWith(222, "generic reply");
  await expect(
    notifier.send(
      { route: { channel: "unknown", address: "1" } },
      "no adapter",
    ),
  ).rejects.toThrow(/No delivery adapter/);
  await expect(
    new TelegramNotifier(undefined).send({ telegram: 111 }, "pending"),
  ).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
});
it("admits allowed messages through mocked thread, turn and SDK boundaries", async () => {
  const tx = createMockTransaction();
  const runtime = createMockRuntime(tx);
  const stop = new AbortController();
  const client: TelegramTransport = {
    fetchUpdates: vi
      .fn<TelegramTransport["fetchUpdates"]>()
      .mockImplementation(async () => {
        return [
          { update_id: 12, message: { chat: { id: 111 }, text: "hello" } },
        ];
      }),
    sendMessage: vi.fn<TelegramTransport["sendMessage"]>(),
    sendTypingIndicator: vi.fn<TelegramTransport["sendTypingIndicator"]>(),
  };
  const threads: TelegramThreads = {
    getOrCreateConversation: vi
      .fn<TelegramThreads["getOrCreateConversation"]>()
      .mockResolvedValue(conversationId(24)),
  };
  const turns: TelegramTurns = {
    admitUserTurn: vi
      .fn<TelegramTurns["admitUserTurn"]>()
      .mockImplementation(async () => {
        stop.abort();
        return taskId(36);
      }),
    admitStop: vi.fn<TelegramTurns["admitStop"]>(),
    admitReset: vi.fn<TelegramTurns["admitReset"]>(),
    admitWorkCancellation: vi.fn<TelegramTurns["admitWorkCancellation"]>(),
  };
  await new TelegramPoller(
    () => runtime,
    threads,
    turns,
    client,
    new Set([111]),
  ).pollUpdates(stop.signal);
  expect(threads.getOrCreateConversation).toHaveBeenCalledExactlyOnceWith(
    "telegram:111",
  );
  expect(turns.admitUserTurn).toHaveBeenCalledExactlyOnceWith(
    tx,
    conversationId(24),
    "hello",
    "telegram:12",
    { telegram: 111 },
  );
});
it("stops observing an admitted control on shutdown without waiting for it to finish", async () => {
  const runtime = createMockRuntime();
  const stop = new AbortController();
  runtime.waitForTask = async (_id, context) => {
    expect(context.abortSignal).toBeDefined();
    stop.abort();
    expect(context.abortSignal?.aborted).toBe(true);
    throw new Error("Observation aborted");
  };
  const client: TelegramTransport = {
    fetchUpdates: async () => [
      { update_id: 1, message: { chat: { id: 111 }, text: "/stop" } },
    ],
    sendMessage: vi.fn<TelegramTransport["sendMessage"]>(),
    sendTypingIndicator: vi.fn<TelegramTransport["sendTypingIndicator"]>(),
  };
  const turns: TelegramTurns = {
    admitUserTurn: vi.fn<TelegramTurns["admitUserTurn"]>(),
    admitStop: vi
      .fn<TelegramTurns["admitStop"]>()
      .mockResolvedValue(taskId(36)),
    admitReset: vi.fn<TelegramTurns["admitReset"]>(),
    admitWorkCancellation: vi.fn<TelegramTurns["admitWorkCancellation"]>(),
  };
  await new TelegramPoller(
    () => runtime,
    { getOrCreateConversation: async () => conversationId(24) },
    turns,
    client,
    new Set([111]),
  ).pollUpdates(stop.signal);
  expect(turns.admitStop).toHaveBeenCalledOnce();
  expect(client.sendMessage).not.toHaveBeenCalled();
});
