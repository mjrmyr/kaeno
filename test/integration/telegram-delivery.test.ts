import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { openKaeno, type Kaeno } from "../../src/core/application/index.ts";
import {
  TelegramState,
  telegramChannel,
  type TelegramTransport,
} from "../../src/channels/telegram/index.ts";

async function sent(core: Kaeno): Promise<Readonly<Record<string, string>>> {
  return (
    (await core.harness.snapshot(TelegramState, context))?.threadOfSent ?? {}
  );
}

async function started(options: { topics?: boolean } = {}) {
  const client = {
    fetchUpdates: vi.fn<TelegramTransport["fetchUpdates"]>().mockImplementation(
      (_offset, signal) =>
        new Promise((resolve) =>
          signal.aborted
            ? resolve([])
            : signal.addEventListener("abort", () => resolve([]), {
                once: true,
              }),
        ),
    ),
    sendMessage: vi
      .fn<TelegramTransport["sendMessage"]>()
      .mockResolvedValue([901]),
    sendTypingIndicator: vi
      .fn<TelegramTransport["sendTypingIndicator"]>()
      .mockResolvedValue(undefined),
    createTopic: vi.fn<TelegramTransport["createTopic"]>(),
    download: vi.fn<TelegramTransport["download"]>(),
  };
  const onError = vi.fn<(error: unknown) => void>();
  const channel = telegramChannel({
    allowedChatIds: [111],
    client,
    onError,
    ...options,
  });
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models: createModels(),
    assistant: {
      model: { provider: "faux", modelId: "faux-1" },
      instructions: "R",
    },
    channels: [channel],
  });
  const state = {
    get sent() {
      return sent(core);
    },
  };
  const delivery = channel.delivery;
  if (!delivery?.openThread) {
    throw new Error("Telegram has no delivery");
  }
  return {
    client,
    onError,
    state,
    delivery: { ...delivery, openThread: delivery.openThread },
    async stop() {
      await core.close();
    },
  };
}
it("does not deliver to removed, malformed or unapproved addresses", async () => {
  const { client, delivery, state, stop } = await started();
  try {
    for (const address of [
      "222",
      "0111",
      "-111",
      "not-a-chat",
      "111:0",
      "111:x",
      "111:7:1",
      "222:7",
    ]) {
      await expect(
        delivery.send({ channel: "telegram", address }, "secret", "t"),
      ).rejects.toThrow("not an allowed private chat");
      await expect(
        delivery.typing?.({ channel: "telegram", address }),
      ).rejects.toThrow("not an allowed private chat");
    }
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.sendTypingIndicator).not.toHaveBeenCalled();
    await delivery.send(
      { channel: "telegram", address: "111" },
      "reply",
      "telegram:111",
    );
    expect(client.sendMessage).toHaveBeenCalledExactlyOnceWith(
      111,
      "reply",
      {},
    );
    await delivery.send(
      { channel: "telegram", address: "111:7", replyTo: "5" },
      "in topic",
      "telegram:111/topic:7",
    );
    expect(client.sendMessage).toHaveBeenLastCalledWith(111, "in topic", {
      threadId: 7,
      replyTo: 5,
    });
    expect(await state.sent).toEqual({ "111:901": "telegram:111/topic:7" });
    await delivery.typing?.({ channel: "telegram", address: "111:7" });
    expect(client.sendTypingIndicator).toHaveBeenCalledWith(111, 7);
  } finally {
    await stop();
  }
});
it("opens a ticket's thread as a topic when enabled, otherwise as a reply chain anchored at the owner's message", async () => {
  const route = { channel: "telegram", address: "111", replyTo: "5" };
  const topics = await started({ topics: true });
  try {
    topics.client.createTopic.mockResolvedValueOnce(77);
    expect(await topics.delivery.openThread(route, "Research")).toEqual({
      key: "telegram:111/topic:77",
      route: { channel: "telegram", address: "111:77" },
    });
    expect(topics.client.createTopic).toHaveBeenCalledWith(111, "Research");
    const unavailable = new Error("topics unavailable");
    topics.client.createTopic.mockRejectedValueOnce(unavailable);
    expect(await topics.delivery.openThread(route, "Research")).toEqual({
      key: "telegram:111/reply:5",
      route,
    });
    expect(topics.onError).toHaveBeenCalledWith(unavailable);
    expect(await topics.state.sent).toEqual({
      "111:5": "telegram:111/reply:5",
    });
    topics.client.createTopic.mockClear();
    expect(
      await topics.delivery.openThread(
        { channel: "telegram", address: "111:77", replyTo: "6" },
        "Nested",
      ),
    ).toEqual({
      key: "telegram:111/reply:6",
      route: { channel: "telegram", address: "111:77", replyTo: "6" },
    });
    expect(topics.client.createTopic).not.toHaveBeenCalled();
  } finally {
    await topics.stop();
  }
  const chains = await started();
  try {
    expect(await chains.delivery.openThread(route, "Research")).toEqual({
      key: "telegram:111/reply:5",
      route,
    });
    expect(chains.client.createTopic).not.toHaveBeenCalled();
    expect(
      await chains.delivery.openThread(
        { channel: "telegram", address: "111" },
        "Research",
      ),
    ).toBeUndefined();
  } finally {
    await chains.stop();
  }
});
