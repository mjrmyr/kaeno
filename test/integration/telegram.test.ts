import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
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
import { TurnLedger } from "../../src/core/turns/index.ts";
import { listWork } from "../../src/core/work/index.ts";
import {
  telegramExtension,
  TelegramApiError,
  type TelegramTransport,
  type TelegramUpdate,
} from "../../src/extensions/telegram/index.ts";

function message(
  update_id: number,
  chatId: number,
  text: string,
): TelegramUpdate {
  return {
    update_id,
    message: {
      chat: { id: chatId, type: "private" },
      from: { id: chatId, is_bot: false },
      text,
    },
  };
}
function inbox() {
  const updates: TelegramUpdate[] = [];
  let changed = Promise.withResolvers<void>();
  const client = {
    sendMessage: vi
      .fn<TelegramTransport["sendMessage"]>()
      .mockResolvedValue(undefined),
    sendTypingIndicator: vi
      .fn<TelegramTransport["sendTypingIndicator"]>()
      .mockResolvedValue(undefined),
    download: vi
      .fn<TelegramTransport["download"]>()
      .mockResolvedValue(new Uint8Array([1, 2, 3])),
    fetchUpdates: vi
      .fn<TelegramTransport["fetchUpdates"]>()
      .mockImplementation(async (offset, signal) => {
        while (!signal.aborted) {
          const available = updates.filter(
            (update) => update.update_id >= offset,
          );
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
  return {
    client,
    push(...batch: TelegramUpdate[]) {
      updates.push(...batch);
      changed.resolve();
      changed = Promise.withResolvers<void>();
    },
  };
}
function call(name: string, args: JsonObject) {
  return answer([fauxToolCall(name, args)], { stopReason: "toolUse" });
}
async function open(options: {
  inbox: ReturnType<typeof inbox>;
  respond: FauxResponseFactory;
  storage?: Storage;
  work?: boolean;
  allowedChatIds?: number[];
}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 100 }, () => options.respond));
  const model = { provider: "faux", modelId: "faux-1" };
  const errors = vi.fn<(error: unknown) => void>();
  const core = await openKaeno({
    storage: options.storage ?? new MemoryStorage(),
    models,
    assistant: {
      model,
      instructions: "CHAT",
      tools: options.work ? ["start_work", "message_work"] : [],
    },
    extensions: [
      telegramExtension({
        allowedChatIds: options.allowedChatIds ?? [111, 222],
        client: options.inbox.client,
        onError: errors,
      }),
    ],
    ...(options.work
      ? {
          work: {
            agents: [
              {
                id: "worker",
                description: "Worker",
                setup: {
                  model,
                  instructions: "WORKER",
                  tools: ["message_parent"],
                },
              },
            ],
            tools: ["message_parent"],
            maxConcurrent: 2,
          },
        }
      : {}),
  });
  return { core, errors };
}
async function caughtUp(input: ReturnType<typeof inbox>, offset: number) {
  await vi.waitFor(() =>
    expect(
      input.client.fetchUpdates.mock.calls.some(([after]) => after >= offset),
    ).toBe(true),
  );
}
async function thread(core: Kaeno, chatId: number) {
  const found = (await core.threads.listConversations()).find(
    (entry) => entry.key === `telegram:${chatId}`,
  );
  if (!found) {
    throw new Error("Missing Telegram thread");
  }
  return found.conversationId;
}

it("authenticates private human senders before creating threads and admits duplicate updates only once", async () => {
  const input = inbox();
  const { core } = await open({
    inbox: input,
    respond: async () => answer("HELLO"),
  });
  try {
    input.push(
      message(1, 333, "unauthorized"),
      {
        update_id: 2,
        message: {
          chat: { id: 111, type: "group" },
          from: { id: 111, is_bot: false },
          text: "not private",
        },
      },
      {
        update_id: 3,
        message: {
          chat: { id: 111, type: "private" },
          from: { id: 111, is_bot: true },
          text: "bot",
        },
      },
      {
        update_id: 4,
        message: {
          chat: { id: 111, type: "private" },
          from: { id: 222, is_bot: false },
          text: "wrong sender",
        },
      },
      { update_id: 5 },
      message(6, 111, "hello"),
      message(6, 111, "hello"),
    );
    await caughtUp(input, 7);
    await vi.waitFor(() =>
      expect(input.client.sendMessage).toHaveBeenCalledExactlyOnceWith(
        111,
        "HELLO",
      ),
    );
    expect(await core.threads.listConversations()).toHaveLength(1);
    const id = await thread(core, 111);
    const turns = await core.harness.commit(
      (tx) => tx.scanTasks({ kind: "kaeno.turn", conversationId: id }, 100),
      context,
    );
    expect(turns.items).toHaveLength(1);
    expect(turns.items[0].input).toMatchObject({
      requestId: "telegram:6",
      notify: { route: { channel: "telegram", address: "111" } },
    });
    expect(input.client.sendTypingIndicator).toHaveBeenCalledWith(111);
  } finally {
    await core.close();
  }
});

it("pushes autonomous worker questions and final results to the originating chat without another user message", async () => {
  const input = inbox();
  const { core } = await open({
    inbox: input,
    work: true,
    respond: async (request) => {
      const last = request.messages.findLast(
        (entry) => entry.role !== "system",
      );
      const content = JSON.stringify(last?.content);
      if (getCurrentSystemPrompt(request.messages).includes("WORKER")) {
        return content.includes("Use main")
          ? answer("VERIFIED REPORT")
          : call("message_parent", { text: "Which branch?" });
      }
      if (last?.role === "toolResult") {
        return answer("WORKING");
      }
      if (content.includes("waits for a reply")) {
        const match = content.match(/Work #(\d+)/);
        if (!match) {
          throw new Error("Missing work ID");
        }
        return call("message_work", { id: Number(match[1]), text: "Use main" });
      }
      return content.includes("VERIFIED REPORT")
        ? answer("COMPLETE")
        : call("start_work", {
            agent: "worker",
            title: "Research",
            brief: "Investigate",
          });
    },
  });
  try {
    input.push(message(1, 111, "launch"));
    await vi.waitFor(() =>
      expect(input.client.sendMessage).toHaveBeenCalledWith(111, "COMPLETE"),
    );
    const id = await thread(core, 111);
    const replies = (await core.turns.readReplies(id, 0)).replies;
    expect(
      replies.filter((reply) => reply.source.kind === "user"),
    ).toHaveLength(1);
    expect(
      replies.filter((reply) => reply.source.kind === "activity-result"),
    ).toHaveLength(2);
    expect(
      input.client.sendMessage.mock.calls.every(([chatId]) => chatId === 111),
    ).toBe(true);
    expect(await listWork(() => core.harness, id)).toMatchObject([
      { status: "completed" },
    ]);
  } finally {
    await core.close();
  }
});

it("lists work, rejects foreign cancellation, resets without cancelling work, and stops only its own chat", async () => {
  const input = inbox();
  const { core } = await open({
    inbox: input,
    work: true,
    respond: async (request) => {
      const last = request.messages.findLast(
        (entry) => entry.role !== "system",
      );
      if (getCurrentSystemPrompt(request.messages).includes("WORKER")) {
        return call("message_parent", { text: "Waiting for a decision" });
      }
      return last?.role === "user" &&
        JSON.stringify(last.content).includes("launch")
        ? call("start_work", {
            agent: "worker",
            title: "Question",
            brief: "Ask",
          })
        : answer("WAITING");
    },
  });
  try {
    input.push(message(1, 111, "launch"), message(2, 222, "launch"));
    await vi.waitFor(() =>
      expect(input.client.sendMessage).toHaveBeenCalledWith(222, "WAITING"),
    );
    const first = await thread(core, 111);
    const second = await thread(core, 222);
    await vi.waitFor(async () => {
      expect(await listWork(() => core.harness, first)).toMatchObject([
        { status: "awaiting-reply" },
      ]);
      expect(await listWork(() => core.harness, second)).toMatchObject([
        { status: "awaiting-reply" },
      ]);
    });
    const [own] = await listWork(() => core.harness, first);
    const [foreign] = await listWork(() => core.harness, second);
    input.push(
      message(3, 111, `/cancel ${foreign.id}`),
      message(4, 111, "/jobs"),
    );
    await caughtUp(input, 5);
    expect(input.client.sendMessage).toHaveBeenCalledWith(
      111,
      expect.stringContaining("Activity is not owned by this conversation"),
    );
    expect(input.client.sendMessage).toHaveBeenCalledWith(
      111,
      expect.stringContaining(`#${own.id} Question [awaiting-reply]`),
    );
    input.push(message(5, 111, "/new"), message(5, 111, "/new"));
    await caughtUp(input, 6);
    await vi.waitFor(async () => {
      const ledger = await core.harness.snapshot(TurnLedger, first, context);
      expect(ledger?.epoch).toBe(1);
      expect(ledger?.control).toBeUndefined();
    });
    expect(await listWork(() => core.harness, first)).toMatchObject([
      { status: "awaiting-reply" },
    ]);
    input.push(message(6, 111, `/cancel ${own.id}`));
    await vi.waitFor(async () =>
      expect(
        (await core.harness.getTask(own.id, context))?.state,
      ).toMatchObject({ status: "terminal", outcome: { status: "aborted" } }),
    );
    expect(
      (await core.harness.getTask(foreign.id, context))?.state.status,
    ).not.toBe("terminal");
    input.push(message(7, 222, "/stop"), message(7, 222, "/stop"));
    await caughtUp(input, 8);
    await vi.waitFor(async () =>
      expect(
        (await core.harness.getTask(foreign.id, context))?.state,
      ).toMatchObject({ status: "terminal", outcome: { status: "aborted" } }),
    );
    expect(
      await core.harness.snapshot(TurnLedger, second, context),
    ).toMatchObject({ epoch: 1 });
  } finally {
    await core.close();
  }
});

it("does not let a permanently rejected command reply block another chat", async () => {
  const input = inbox();
  input.client.sendMessage.mockRejectedValueOnce(
    new TelegramApiError("sendMessage", 403),
  );
  const { core, errors } = await open({
    inbox: input,
    respond: async () => answer("HELLO"),
  });
  try {
    input.push(message(1, 111, "/help"), message(2, 222, "hello"));
    await caughtUp(input, 3);
    await vi.waitFor(() =>
      expect(input.client.sendMessage).toHaveBeenCalledWith(222, "HELLO"),
    );
    expect(errors).toHaveBeenCalledOnce();
  } finally {
    await core.close();
  }
});

it("recovers an undelivered assistant reply from SQLite without rerunning the model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-telegram-delivery-"));
  const file = join(directory, "durable.sqlite");
  const input = inbox();
  input.client.sendMessage.mockRejectedValue(new Error("Offline"));
  const respond = vi
    .fn<FauxResponseFactory>()
    .mockImplementation(async () => answer("PERSISTED ANSWER"));
  let core: Kaeno | undefined;
  try {
    ({ core } = await open({
      inbox: input,
      storage: await openNodeSqliteStorage(file),
      respond,
    }));
    input.push(message(20, 111, "hello"));
    await vi.waitFor(() =>
      expect(input.client.sendMessage).toHaveBeenCalledWith(
        111,
        "PERSISTED ANSWER",
      ),
    );
    await core.close();
    const recovered = inbox();
    recovered.push(message(20, 111, "hello"));
    ({ core } = await open({
      inbox: recovered,
      storage: await openNodeSqliteStorage(file),
      respond,
    }));
    await vi.waitFor(
      () =>
        expect(recovered.client.sendMessage).toHaveBeenCalledWith(
          111,
          "PERSISTED ANSWER",
        ),
      { timeout: 5000 },
    );
    const id = await thread(core, 111);
    await vi.waitFor(async () =>
      expect((await core?.turns.readReplies(id, 0))?.replies).toHaveLength(1),
    );
    expect(respond).toHaveBeenCalledOnce();
    expect(recovered.client.fetchUpdates.mock.calls[0][0]).toBe(21);
  } finally {
    await core?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "recovers command replies and offsets from SQLite without executing /new twice (revoke chat=%s)",
  async (revoke) => {
    const directory = await mkdtemp(join(tmpdir(), "kaeno-telegram-recovery-"));
    const file = join(directory, "durable.sqlite");
    const input = inbox();
    input.client.sendMessage.mockRejectedValue(
      new Error("Temporary Telegram outage"),
    );
    let core: Kaeno | undefined;
    try {
      const first = await open({
        inbox: input,
        storage: await openNodeSqliteStorage(file),
        respond: async () => answer("HELLO"),
      });
      core = first.core;
      input.push(message(10, 111, "/new"));
      await vi.waitFor(() => expect(first.errors).toHaveBeenCalledOnce());
      const id = await thread(core, 111);
      await vi.waitFor(async () => {
        const ledger = await core?.harness.snapshot(TurnLedger, id, context);
        expect(ledger?.epoch).toBe(1);
        expect(ledger?.control).toBeUndefined();
      });
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
        respond: async () => answer("HELLO"),
      }));
      await vi.waitFor(() =>
        expect(recovered.client.sendMessage).toHaveBeenCalledWith(
          destination,
          "HELLO",
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
          "Fresh context requested. Existing work continues; /jobs lists it.",
        );
      }
      expect(recovered.client.fetchUpdates.mock.calls[0][0]).toBe(11);
      expect(
        await core.harness.snapshot(TurnLedger, id, context),
      ).toMatchObject({
        epoch: 1,
      });
      expect(
        (
          await core.turns.readReplies(await thread(core, destination), 0)
        ).replies.filter((reply) => reply.source.kind === "user"),
      ).toHaveLength(1);
    } finally {
      await core?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

function media(
  update_id: number,
  fields: Partial<NonNullable<TelegramUpdate["message"]>>,
): TelegramUpdate {
  return {
    update_id,
    message: {
      chat: { id: 111, type: "private" },
      from: { id: 111, is_bot: false },
      ...fields,
    },
  };
}
function lastUserContent(request: Parameters<FauxResponseFactory>[0]) {
  return request.messages.findLast((entry) => entry.role === "user")?.content;
}

it("gives the model a photo with its caption, and refuses other files", async () => {
  const input = inbox();
  const seen: unknown[] = [];
  const { core } = await open({
    inbox: input,
    respond: async (request) => {
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
    await vi.waitFor(() =>
      expect(input.client.sendMessage).toHaveBeenCalledWith(111, "A CAT"),
    );
    await caughtUp(input, 4);
    expect(seen).toEqual([
      [
        { type: "text", text: "what is this?" },
        { type: "image", data: "AQID", mimeType: "image/jpeg" },
      ],
    ]);
    expect(input.client.download).toHaveBeenCalledExactlyOnceWith("large");
    for (const reason of [
      "Kaeno reads text and images",
      "Images are limited to 5 MB",
    ]) {
      expect(input.client.sendMessage).toHaveBeenCalledWith(
        111,
        expect.stringContaining(reason),
      );
    }
  } finally {
    await core.close();
  }
});
