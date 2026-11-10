import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TelegramClient, loadTelegram } from "./index.ts";

function response(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }));
}
it("long-polls only messages using the persisted offset and an abortable request", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    response([
      {
        update_id: 12,
        message: {
          message_id: 5,
          message_thread_id: 7,
          is_topic_message: true,
          reply_to_message: { message_id: 4, text: "earlier" },
          chat: { id: 111, type: "private" },
          from: { id: 111, is_bot: false },
          text: "hello",
        },
      },
    ]),
  );
  const client = new TelegramClient("token", fetch);
  const abort = new AbortController();
  expect(await client.fetchUpdates(10, abort.signal)).toMatchObject([
    {
      update_id: 12,
      message: {
        message_id: 5,
        message_thread_id: 7,
        reply_to_message: { message_id: 4, text: "earlier" },
      },
    },
  ]);
  expect(fetch.mock.calls[0][0]).toBe(
    "https://api.telegram.org/bottoken/getUpdates",
  );
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
    offset: 10,
    timeout: 50,
    allowed_updates: ["message"],
  });
  const signal = fetch.mock.calls[0][1]?.signal;
  abort.abort();
  expect(signal?.aborted).toBe(true);
});
it("rejects malformed updates, unsuccessful HTTP responses and Telegram API errors", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(response([{ update_id: "bad" }]))
    .mockResolvedValueOnce(
      response([
        {
          update_id: 1,
          message: { chat: { id: 111, type: "private" }, text: "hello" },
        },
      ]),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: [] }), { status: 500 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 429 })),
    );
  const client = new TelegramClient("token", fetch);
  await expect(
    client.fetchUpdates(0, new AbortController().signal),
  ).rejects.toThrow();
  await expect(
    client.fetchUpdates(0, new AbortController().signal),
  ).rejects.toThrow();
  await expect(client.sendMessage(111, "hello")).rejects.toThrow("500");
  await expect(client.sendMessage(111, "hello")).rejects.toThrow("429");
});
it("redacts the bot token from transport errors", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValue(
      new Error(
        "Unable to fetch https://api.telegram.org/botsecret-token/sendMessage",
      ),
    );
  await expect(
    new TelegramClient("secret-token", fetch).sendMessage(111, "hello"),
  ).rejects.toThrow("bot[redacted]/sendMessage");
});
it("downloads files through getFile", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(response({ file_path: "photos/file_1.jpg" }))
    .mockResolvedValueOnce(new Response(new Uint8Array([7, 8])))
    .mockResolvedValueOnce(response({ file_path: "photos/file_1.jpg" }))
    .mockResolvedValueOnce(new Response("", { status: 404 }));
  const client = new TelegramClient("token", fetch);
  expect(await client.download("abc")).toEqual(new Uint8Array([7, 8]));
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
    file_id: "abc",
  });
  expect(fetch.mock.calls[1][0]).toBe(
    "https://api.telegram.org/file/bottoken/photos/file_1.jpg",
  );
  await expect(client.download("abc")).rejects.toThrow();
});
it("splits plain-text replies safely, preserves Unicode, returns every message ID and quotes only once", async () => {
  let next = 100;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => response({ message_id: ++next }));
  const client = new TelegramClient("token", fetch);
  const text = `${"x".repeat(1999)}🙂${"y".repeat(3000)}`;
  expect(
    await client.sendMessage(111, text, { threadId: 7, replyTo: 5 }),
  ).toEqual([101, 102, 103]);
  const bodies = fetch.mock.calls.map(([, init]) =>
    JSON.parse(String(init?.body)),
  );
  expect(bodies.map((body) => body.text).join("")).toBe(text);
  expect(
    bodies.every(
      (body) =>
        body.chat_id === 111 &&
        body.message_thread_id === 7 &&
        body.text.length <= 4000 &&
        body.text.isWellFormed() &&
        body.parse_mode === undefined,
    ),
  ).toBe(true);
  expect(bodies.map((body) => body.reply_parameters)).toEqual([
    { message_id: 5, allow_sending_without_reply: true },
    undefined,
    undefined,
  ]);
  await client.sendMessage(111, "plain");
  const plain = JSON.parse(String(fetch.mock.lastCall?.[1]?.body));
  expect(plain).not.toHaveProperty("message_thread_id");
  expect(plain).not.toHaveProperty("reply_parameters");
  await client.sendTypingIndicator(222);
  expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body))).toEqual({
    chat_id: 222,
    action: "typing",
  });
  await client.sendTypingIndicator(222, 7);
  expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body))).toEqual({
    chat_id: 222,
    action: "typing",
    message_thread_id: 7,
  });
});
it("creates a topic with a name Telegram accepts and returns its thread ID", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(response({ message_thread_id: 77, name: "x" }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 400 })),
    );
  const client = new TelegramClient("token", fetch);
  expect(await client.createTopic(111, `${"🙂".repeat(130)}`)).toBe(77);
  expect(fetch.mock.calls[0][0]).toBe(
    "https://api.telegram.org/bottoken/createForumTopic",
  );
  const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(body.chat_id).toBe(111);
  expect(Array.from(body.name)).toHaveLength(128);
  await expect(client.createTopic(111, "Research")).rejects.toThrow("400");
});

it("loads strict owner configuration and requires a token and at least one private chat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-telegram-config-"));
  const file = join(directory, "telegram.json");
  const env = { KAENO_TELEGRAM_CONFIG: file, TELEGRAM_BOT_TOKEN: "token" };
  try {
    for (const config of [
      { allowedChatIds: [] },
      { allowedChatIds: [-1] },
      { allowedChatIds: [1.5] },
      { allowedChatIds: [111], token: "must-not-live-here" },
    ]) {
      await writeFile(file, JSON.stringify(config));
      await expect(loadTelegram(env)).rejects.toThrow();
    }
    await writeFile(file, JSON.stringify({ allowedChatIds: [111] }));
    await expect(
      loadTelegram({ KAENO_TELEGRAM_CONFIG: file }),
    ).rejects.toThrow();
    expect((await loadTelegram(env))?.delivery?.channel).toBe("telegram");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("is off without configuration and refuses a token without it", async () => {
  expect(await loadTelegram({})).toBeUndefined();
  await expect(loadTelegram({ TELEGRAM_BOT_TOKEN: "token" })).rejects.toThrow(
    "TELEGRAM_BOT_TOKEN requires KAENO_TELEGRAM_CONFIG",
  );
});
