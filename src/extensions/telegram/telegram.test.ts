import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  TelegramClient,
  loadTelegram,
  telegramExtension,
  type TelegramTransport,
} from "./index.ts";

function response(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }));
}
it("long-polls only messages using the persisted offset and an abortable request", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    response([
      {
        update_id: 12,
        message: {
          chat: { id: 111, type: "private" },
          from: { id: 111, is_bot: false },
          text: "hello",
        },
      },
    ]),
  );
  const client = new TelegramClient("token", fetch);
  const abort = new AbortController();
  expect(await client.fetchUpdates(10, abort.signal)).toHaveLength(1);
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
      new Response(JSON.stringify({ ok: true, result: [] }), { status: 500 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 429 })),
    );
  const client = new TelegramClient("token", fetch);
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
    .mockResolvedValueOnce(response({ file_path: "voice/file_1.oga" }))
    .mockResolvedValueOnce(new Response(new Uint8Array([7, 8])))
    .mockResolvedValueOnce(response({ file_path: "voice/file_1.oga" }))
    .mockResolvedValueOnce(new Response("", { status: 404 }));
  const client = new TelegramClient("token", fetch);
  expect(await client.download("abc")).toEqual(new Uint8Array([7, 8]));
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
    file_id: "abc",
  });
  expect(fetch.mock.calls[1][0]).toBe(
    "https://api.telegram.org/file/bottoken/voice/file_1.oga",
  );
  await expect(client.download("abc")).rejects.toThrow();
});
it("splits plain-text replies safely, preserves Unicode and uses the requested chat", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => response(true));
  const client = new TelegramClient("token", fetch);
  const text = `${"x".repeat(1999)}🙂${"y".repeat(3000)}`;
  await client.sendMessage(111, text);
  const bodies = fetch.mock.calls.map(([, init]) =>
    JSON.parse(String(init?.body)),
  );
  expect(bodies.map((body) => body.text).join("")).toBe(text);
  expect(
    bodies.every(
      (body) =>
        body.chat_id === 111 &&
        body.text.length <= 4000 &&
        body.text.isWellFormed() &&
        body.parse_mode === undefined,
    ),
  ).toBe(true);
  await client.sendTypingIndicator(222);
  expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body))).toEqual({
    chat_id: 222,
    action: "typing",
  });
});
it("does not deliver to removed, malformed or unapproved addresses", async () => {
  const client: TelegramTransport = {
    fetchUpdates: vi.fn<TelegramTransport["fetchUpdates"]>(),
    sendMessage: vi.fn<TelegramTransport["sendMessage"]>(),
    sendTypingIndicator: vi.fn<TelegramTransport["sendTypingIndicator"]>(),
    download: vi.fn<TelegramTransport["download"]>(),
  };
  const extension = telegramExtension({ allowedChatIds: [111], client });
  for (const address of ["222", "0111", "-111", "not-a-chat"]) {
    await expect(extension.delivery?.send(address, "secret")).rejects.toThrow(
      "not an allowed private chat",
    );
  }
  await extension.delivery?.send("111", "reply");
  expect(client.sendMessage).toHaveBeenCalledExactlyOnceWith(111, "reply");
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
