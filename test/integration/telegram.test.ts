import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  getCurrentSystemPrompt,
  type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage as answer,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import {
  MemoryStorage,
  type Storage,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openKaeno, type Kaeno } from "../../src/core/application/index.ts";
import { Engine } from "../../src/core/router/index.ts";
import {
  telegramChannel,
  TelegramApiError,
  type TelegramTransport,
  type TelegramUpdate,
} from "../../src/channels/telegram/index.ts";
import { assignment, replies, ticketWhen } from "../mocks/router.ts";

type Message = NonNullable<TelegramUpdate["message"]>;
function message(
  update_id: number,
  chatId: number,
  text: string,
  fields: Partial<Message> = {},
): TelegramUpdate {
  return {
    update_id,
    message: {
      message_id: update_id,
      chat: { id: chatId, type: "private" },
      from: { id: chatId, is_bot: false },
      text,
      ...fields,
    },
  };
}
function inTopic(
  update_id: number,
  topic: number,
  text: string,
): TelegramUpdate {
  return message(update_id, 111, text, {
    message_thread_id: topic,
    is_topic_message: true,
  });
}
function inbox() {
  const updates: TelegramUpdate[] = [];
  const behindOffset: TelegramUpdate[] = [];
  let changed = Promise.withResolvers<void>();
  let nextMessage = 9000;
  const client = {
    sendMessage: vi
      .fn<TelegramTransport["sendMessage"]>()
      .mockImplementation(async () => [++nextMessage]),
    sendTypingIndicator: vi
      .fn<TelegramTransport["sendTypingIndicator"]>()
      .mockResolvedValue(undefined),
    createTopic: vi
      .fn<TelegramTransport["createTopic"]>()
      .mockRejectedValue(new TelegramApiError("createForumTopic", 400)),
    download: vi
      .fn<TelegramTransport["download"]>()
      .mockResolvedValue(new Uint8Array([1, 2, 3])),
    fetchUpdates: vi
      .fn<TelegramTransport["fetchUpdates"]>()
      .mockImplementation(async (offset, signal) => {
        while (!signal.aborted) {
          const available = [
            ...behindOffset.splice(0),
            ...updates.filter((update) => update.update_id >= offset),
          ];
          if (available.length) {
            return available;
          }
          const next = changed.promise;
          await new Promise<void>((resolve) => {
            function stop() {
              resolve();
            }
            signal.addEventListener("abort", stop, { once: true });
            void next.then(() => {
              signal.removeEventListener("abort", stop);
              resolve();
            });
          });
        }
        return [];
      }),
  };
  function wake() {
    changed.resolve();
    changed = Promise.withResolvers<void>();
  }
  return {
    client,
    push(...batch: TelegramUpdate[]) {
      updates.push(...batch);
      wake();
    },
    redeliver(...batch: TelegramUpdate[]) {
      behindOffset.push(...batch);
      wake();
    },
  };
}
function call(name: string, args: JsonObject) {
  return answer([fauxToolCall(name, args)], { stopReason: "toolUse" });
}
function batch(request: ModelContext): string {
  const start = request.messages.findLastIndex(
    (entry) => entry.role === "assistant",
  );
  return JSON.stringify(request.messages.slice(start + 1));
}
function lastUserContent(request: ModelContext) {
  return request.messages.findLast((entry) => entry.role === "user")?.content;
}
async function routerDefault(request: ModelContext) {
  const last = request.messages.findLast((entry) => entry.role !== "system");
  if (last?.role === "toolResult") {
    return answer("ok");
  }
  const text = batch(request);
  const report =
    /<report ticket=\\"(k[0-9]+)\\"[^>]*state=\\"ready\\"[^>]*>\\n([^<\\]*)/.exec(
      text,
    );
  if (report) {
    return call("reply", { to: report[1], text: `Done: ${report[2]}` });
  }
  const accepted = [
    ...text.matchAll(/<trigger id=\\"(t[0-9]+)\\"[^]*?task: ([A-Za-z]+)/g),
  ].map(([, trigger, title]) => ({
    trigger,
    kind: "accept",
    agent: "worker",
    title,
    ack: `On it: ${title}.`,
  }));
  if (accepted.length) {
    return call("route", { items: accepted });
  }
  return answer(text.includes("<trigger") ? "HELLO" : "noted");
}
async function workerDefault(request: ModelContext) {
  const content = JSON.stringify(lastUserContent(request));
  if (content.includes("follow-up")) {
    return answer("SECOND");
  }
  if (content.includes("wait")) {
    return call("report", { state: "waiting", text: "Which branch?" });
  }
  return answer("RESULT 42");
}

async function open(options: {
  inbox: ReturnType<typeof inbox>;
  router?: FauxResponseFactory;
  worker?: FauxResponseFactory;
  storage?: Storage;
  allowedChatIds?: number[];
  topics?: boolean;
}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const routerRequests: ModelContext[] = [];
  const workerRequests: ModelContext[] = [];
  faux.setResponses(
    Array.from({ length: 100 }, () => async (...args) => {
      const [request] = args;
      if (getCurrentSystemPrompt(request.messages).includes("WORKER")) {
        workerRequests.push(request);
        return (options.worker ?? workerDefault)(...args);
      }
      routerRequests.push(request);
      return (options.router ?? routerDefault)(...args);
    }),
  );
  const model = { provider: "faux", modelId: "faux-1" };
  const errors = vi.fn<(error: unknown) => void>();
  const core = await openKaeno({
    storage: options.storage ?? new MemoryStorage(),
    models,
    assistant: { model, instructions: "ROUTER", tools: ["route", "reply"] },
    channels: [
      telegramChannel({
        allowedChatIds: options.allowedChatIds ?? [111, 222],
        ...(options.topics === undefined ? {} : { topics: options.topics }),
        client: options.inbox.client,
        onError: errors,
      }),
    ],
    work: {
      agents: [
        {
          id: "worker",
          description: "Worker",
          setup: { model, instructions: "WORKER", tools: ["report"] },
        },
      ],
      tools: ["report"],
      maxConcurrent: 2,
    },
  });
  return { core, errors, routerRequests, workerRequests };
}
async function caughtUp(input: ReturnType<typeof inbox>, offset: number) {
  await vi.waitFor(() =>
    expect(
      input.client.fetchUpdates.mock.calls.some(([after]) => after >= offset),
    ).toBe(true),
  );
}
async function sent(
  input: ReturnType<typeof inbox>,
  ...expected: Parameters<TelegramTransport["sendMessage"]>
) {
  await vi.waitFor(() =>
    expect(input.client.sendMessage).toHaveBeenCalledWith(...expected),
  );
}

it("authenticates private human senders before recording anything and answers in the main chat", async () => {
  const input = inbox();
  const { core } = await open({ inbox: input });
  try {
    input.push(
      message(1, 333, "unauthorized"),
      message(2, 111, "not private", { chat: { id: 111, type: "group" } }),
      message(3, 111, "bot", { from: { id: 111, is_bot: true } }),
      message(4, 111, "wrong sender", { from: { id: 222, is_bot: false } }),
      { update_id: 5 },
      message(6, 111, "hello"),
    );
    await caughtUp(input, 7);
    await vi.waitFor(() =>
      expect(input.client.sendMessage).toHaveBeenCalledExactlyOnceWith(
        111,
        "HELLO",
        { replyTo: 6 },
      ),
    );
    expect(await core.router.recentTriggers(context)).toEqual(["t1"]);
    expect(await core.router.trigger("t1", context)).toMatchObject({
      key: "telegram:6",
      source: "telegram",
      threads: ["telegram:111"],
      authority: "owner",
      content: "hello",
      route: { channel: "telegram", address: "111", replyTo: "6" },
      disposition: { kind: "reply" },
    });
    expect(await core.router.thread("telegram:333", context)).toBeUndefined();
    expect(await replies(core, "telegram:111")).toEqual([
      expect.objectContaining({ text: "HELLO" }),
    ]);
    expect(input.client.sendTypingIndicator).toHaveBeenCalledWith(
      111,
      undefined,
    );
  } finally {
    await core.close();
  }
});

it("ignores a duplicate update, in one batch or redelivered later", async () => {
  const input = inbox();
  const { core, routerRequests } = await open({ inbox: input });
  try {
    input.push(message(1, 111, "hello"), message(1, 111, "hello"));
    await sent(input, 111, "HELLO", { replyTo: 1 });
    input.redeliver(message(1, 111, "hello"));
    input.push(message(2, 111, "/help"));
    await caughtUp(input, 3);
    await sent(input, 111, expect.stringContaining("Kaeno here."), {
      replyTo: 2,
    });
    expect(await core.router.recentTriggers(context)).toEqual(["t1"]);
    expect(routerRequests).toHaveLength(1);
    expect(
      input.client.sendMessage.mock.calls.filter(
        ([, text]) => text === "HELLO",
      ),
    ).toHaveLength(1);
  } finally {
    await core.close();
  }
});

it("opens a topic for an accepted ticket and passes later messages there straight to its worker", async () => {
  const input = inbox();
  input.client.createTopic.mockResolvedValue(77);
  const { core, routerRequests, workerRequests } = await open({
    inbox: input,
    topics: true,
  });
  try {
    input.push(message(1, 111, "task: Research"));
    await sent(input, 111, "On it: Research.", { threadId: 77 });
    expect(input.client.createTopic).toHaveBeenCalledExactlyOnceWith(
      111,
      "Research",
    );
    await sent(input, 111, "Done: RESULT 42", { threadId: 77 });
    expect(JSON.stringify(workerRequests[0].messages)).toContain(
      "task: Research",
    );
    expect(await core.router.ticket("k1", context)).toMatchObject({
      ownThread: "telegram:111/topic:77",
      followed: [],
      systemWakes: 0,
      replyThread: "telegram:111",
    });
    await ticketWhen(core, "k1", (ticket) => ticket.status === "idle");

    const routerTurns = routerRequests.length;
    input.push(inTopic(2, 77, "follow-up question"));
    await sent(input, 111, "Done: SECOND", { threadId: 77 });
    expect(await core.router.trigger("t2", context)).toMatchObject({
      threads: ["telegram:111/topic:77"],
      route: { channel: "telegram", address: "111:77", replyTo: "2" },
      disposition: { kind: "passed", tickets: ["k1"] },
    });
    const later = routerRequests.slice(routerTurns).map(batch).join("\n");
    expect(later).not.toContain('<trigger id=\\"t2\\"');
    expect(later).toContain("<passed");
    const second = JSON.stringify(workerRequests.at(-1)?.messages);
    expect(second).toContain("RESULT 42");
    expect(second).toContain("follow-up question");
    expect((await core.router.ticket("k1", context)).assignments).toHaveLength(
      2,
    );
  } finally {
    await core.close();
  }
});

it("falls back to a reply chain when no topic can be created; a reply to the ack reaches the same ticket", async () => {
  const input = inbox();
  const { core, errors, workerRequests } = await open({
    inbox: input,
    topics: true,
  });
  try {
    input.push(message(1, 111, "task: Research"));
    await sent(input, 111, "On it: Research.", { replyTo: 1 });
    expect(input.client.createTopic).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledWith(expect.any(TelegramApiError));
    await sent(input, 111, "Done: RESULT 42", { replyTo: 1 });
    expect((await core.router.ticket("k1", context)).ownThread).toBe(
      "telegram:111/reply:1",
    );
    await ticketWhen(core, "k1", (ticket) => ticket.status === "idle");

    input.push(
      message(2, 111, "follow-up on the ack", {
        reply_to_message: { message_id: 9001, text: "On it: Research." },
      }),
    );
    await sent(input, 111, "Done: SECOND", { replyTo: 1 });
    expect(await core.router.trigger("t2", context)).toMatchObject({
      threads: ["telegram:111/reply:1"],
      quote: "On it: Research.",
      disposition: { kind: "passed", tickets: ["k1"] },
    });
    expect(JSON.stringify(workerRequests.at(-1)?.messages)).toContain(
      "follow-up on the ack",
    );
    input.push(
      message(3, 111, "another follow-up", {
        reply_to_message: { message_id: 1, text: "task: Research" },
      }),
    );
    await vi.waitFor(async () =>
      expect(await core.router.trigger("t3", context)).toMatchObject({
        disposition: { kind: "passed", tickets: ["k1"] },
      }),
    );
  } finally {
    await core.close();
  }
});

it("answers commands deterministically: /stop in a topic stops only its ticket, /new keeps tickets running", async () => {
  const input = inbox();
  input.client.createTopic.mockResolvedValueOnce(77).mockResolvedValueOnce(78);
  const { core } = await open({ inbox: input, topics: true });
  const compact = vi.spyOn(core.router, "compact");
  try {
    input.push(message(1, 111, "task: First wait"));
    await sent(input, 111, "On it: First.", { threadId: 77 });
    input.push(message(2, 111, "task: Second wait"));
    await sent(input, 111, "On it: Second.", { threadId: 78 });
    for (const ticket of ["k1", "k2"]) {
      await ticketWhen(
        core,
        ticket,
        (value) => value.reports.at(-1)?.state === "waiting",
        `${ticket}'s question`,
      );
    }
    const first = await assignment(core, "k1");
    const second = await assignment(core, "k2");

    input.push(inTopic(3, 77, "/stop"));
    await sent(
      input,
      111,
      "Stopped k1. Sandbox cleanup may still be in progress.",
      { threadId: 77, replyTo: 3 },
    );
    await vi.waitFor(async () =>
      expect((await core.harness.getTask(first, context))?.state).toMatchObject(
        { status: "terminal", outcome: { status: "aborted" } },
      ),
    );
    expect((await core.router.ticket("k1", context)).status).toBe("ended");
    expect((await core.router.ticket("k2", context)).status).toBe("running");

    input.push(message(4, 111, "/jobs"), message(5, 111, "/show k2"));
    await sent(input, 111, 'k2 "Second" [waiting]', { replyTo: 4 });
    await sent(input, 111, 'k2 "Second" [waiting]\n\nWhich branch?', {
      replyTo: 5,
    });

    input.push(message(6, 111, "/new"), message(6, 111, "/new"));
    await sent(
      input,
      111,
      "Fresh context requested. Tickets keep running; /jobs lists them.",
      { replyTo: 6 },
    );
    await caughtUp(input, 7);
    expect(compact).toHaveBeenCalledOnce();
    await expect(compact.mock.results[0]?.value).resolves.toBeUndefined();
    expect((await core.router.ticket("k2", context)).status).toBe("running");

    input.push(message(7, 111, "/cancel 2"));
    await sent(input, 111, "Cancellation requested for k2.", { replyTo: 7 });
    await vi.waitFor(async () =>
      expect(
        (await core.harness.getTask(second, context))?.state,
      ).toMatchObject({ status: "terminal", outcome: { status: "aborted" } }),
    );

    input.push(
      message(8, 111, "/stop"),
      message(9, 111, "/status"),
      message(10, 111, "/bogus"),
    );
    await sent(input, 111, "Nothing is running.", { replyTo: 8 });
    await sent(input, 111, "No open tickets.", { replyTo: 9 });
    await sent(input, 111, expect.stringMatching(/^Unknown command\. /), {
      replyTo: 10,
    });
    expect(await core.router.recentTriggers(context)).toEqual(["t1", "t2"]);
  } finally {
    await core.close();
  }
});

it("/stop in the main chat stops every ticket", async () => {
  const input = inbox();
  const { core } = await open({ inbox: input });
  try {
    input.push(message(1, 111, "task: First wait"));
    await sent(input, 111, "On it: First.", { replyTo: 1 });
    input.push(message(2, 222, "task: Second wait"));
    await sent(input, 222, "On it: Second.", { replyTo: 2 });
    await assignment(core, "k1");
    await assignment(core, "k2");
    input.push(message(3, 111, "/stop"));
    await sent(
      input,
      111,
      "Stopped k1, k2. Sandbox cleanup may still be in progress.",
      { replyTo: 3 },
    );
    expect(await core.router.listTickets(context)).toEqual([]);
  } finally {
    await core.close();
  }
});

it("does not let a permanently rejected command reply block another chat", async () => {
  const input = inbox();
  input.client.sendMessage.mockRejectedValueOnce(
    new TelegramApiError("sendMessage", 403),
  );
  const { core, errors } = await open({ inbox: input });
  try {
    input.push(message(1, 111, "/help"), message(2, 222, "hello"));
    await caughtUp(input, 3);
    await sent(input, 222, "HELLO", { replyTo: 2 });
    expect(errors).toHaveBeenCalledOnce();
  } finally {
    await core.close();
  }
});

it("does not send an answer above the 100-word cap and tells the owner instead", async () => {
  const input = inbox();
  const long = Array.from({ length: 120 }, () => "word").join(" ");
  const { core, routerRequests } = await open({
    inbox: input,
    router: async () => answer(long),
  });
  try {
    input.push(message(1, 111, "tell me everything"));
    await sent(
      input,
      111,
      "⚠️ Kaeno could not handle that message. Please send it again.",
      { replyTo: 1 },
    );
    expect(routerRequests).toHaveLength(2);
    expect(
      input.client.sendMessage.mock.calls.some(([, text]) => text === long),
    ).toBe(false);
  } finally {
    await core.close();
  }
});

it("recovers an undelivered router reply from SQLite without rerunning the model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-telegram-delivery-"));
  const file = join(directory, "durable.sqlite");
  const input = inbox();
  input.client.sendMessage.mockRejectedValue(new Error("Offline"));
  const router = vi
    .fn<FauxResponseFactory>()
    .mockImplementation(async () => answer("PERSISTED ANSWER"));
  let core: Kaeno | undefined;
  try {
    ({ core } = await open({
      inbox: input,
      storage: await openNodeSqliteStorage(file),
      router,
    }));
    input.push(message(20, 111, "hello"));
    await sent(input, 111, "PERSISTED ANSWER", { replyTo: 20 });
    await core.close();
    const recovered = inbox();
    recovered.push(message(20, 111, "hello"));
    ({ core } = await open({
      inbox: recovered,
      storage: await openNodeSqliteStorage(file),
      router,
    }));
    await vi.waitFor(
      () =>
        expect(recovered.client.sendMessage).toHaveBeenCalledWith(
          111,
          "PERSISTED ANSWER",
          { replyTo: 20 },
        ),
      { timeout: 8000 },
    );
    const recoveredCore = core;
    await vi.waitFor(async () =>
      expect(await replies(recoveredCore, "telegram:111")).toHaveLength(1),
    );
    expect(router).toHaveBeenCalledOnce();
    expect(recovered.client.fetchUpdates.mock.calls[0][0]).toBe(21);
  } finally {
    await core?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

it.each([false, true])(
  "recovers command replies and offsets from SQLite without executing /new twice (revoke chat=%s)",
  async (revoke) => {
    const directory = await mkdtemp(join(tmpdir(), "kaeno-telegram-recovery-"));
    const file = join(directory, "durable.sqlite");
    const input = inbox();
    input.client.sendMessage.mockRejectedValue(
      new Error("Temporary Telegram outage"),
    );
    const compact = vi.spyOn(Engine.prototype, "compact");
    let core: Kaeno | undefined;
    try {
      const first = await open({
        inbox: input,
        storage: await openNodeSqliteStorage(file),
      });
      core = first.core;
      input.push(message(10, 111, "/new"));
      await vi.waitFor(() => expect(first.errors).toHaveBeenCalledOnce());
      expect(compact).toHaveBeenCalledOnce();
      await core.close();
      const recovered = inbox();
      const destination = revoke ? 222 : 111;
      recovered.push(
        message(10, 111, "/new"),
        message(11, destination, "hello"),
      );
      ({ core } = await open({
        inbox: recovered,
        storage: await openNodeSqliteStorage(file),
        allowedChatIds: revoke ? [222] : [111, 222],
      }));
      await vi.waitFor(() =>
        expect(recovered.client.sendMessage).toHaveBeenCalledWith(
          destination,
          "HELLO",
          { replyTo: 11 },
        ),
      );
      if (revoke) {
        expect(
          recovered.client.sendMessage.mock.calls.every(
            ([chatId]) => chatId !== 111,
          ),
        ).toBe(true);
      } else {
        expect(recovered.client.sendMessage).toHaveBeenCalledWith(
          111,
          "Fresh context requested. Tickets keep running; /jobs lists them.",
          { replyTo: 10 },
        );
      }
      expect(recovered.client.fetchUpdates.mock.calls[0][0]).toBe(11);
      expect(compact).toHaveBeenCalledOnce();
      expect(await replies(core, `telegram:${destination}`)).toEqual([
        expect.objectContaining({ text: "HELLO" }),
      ]);
    } finally {
      compact.mockRestore();
      await core?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

function media(update_id: number, fields: Partial<Message>): TelegramUpdate {
  return {
    update_id,
    message: {
      message_id: update_id,
      chat: { id: 111, type: "private" },
      from: { id: 111, is_bot: false },
      ...fields,
    },
  };
}

it("gives the router a photo with its caption, and refuses other files", async () => {
  const input = inbox();
  const seen: unknown[] = [];
  const { core } = await open({
    inbox: input,
    router: async (request) => {
      seen.push(lastUserContent(request));
      return answer("A CAT");
    },
  });
  try {
    input.push(
      media(1, {
        caption: "what is this?",
        photo: [
          { file_id: "small", file_size: 10 },
          { file_id: "large", file_size: 3 },
        ],
      }),
      media(2, { document: { file_id: "doc", mime_type: "application/pdf" } }),
      media(3, {
        document: {
          file_id: "huge",
          mime_type: "image/png",
          file_size: 6 * 1024 * 1024,
        },
      }),
    );
    await sent(input, 111, "A CAT", { replyTo: 1 });
    await caughtUp(input, 4);
    expect(seen).toEqual([
      [
        {
          type: "text",
          text: expect.stringMatching(
            /^<trigger id="t1" thread="telegram:111" source="telegram" authority="owner" mode="explicit">\nwhat is this\?\n<\/trigger>$/,
          ),
        },
        { type: "image", data: "AQID", mimeType: "image/jpeg" },
      ],
    ]);
    expect(input.client.download).toHaveBeenCalledExactlyOnceWith("large");
    for (const [reason, replyTo] of [
      ["Kaeno reads text and images", 2],
      ["Images are limited to 5 MB", 3],
    ] as const) {
      await sent(
        input,
        111,
        expect.stringContaining(`Could not accept that request: ${reason}`),
        { replyTo },
      );
    }
    expect(await core.router.recentTriggers(context)).toEqual(["t1"]);
  } finally {
    await core.close();
  }
});
