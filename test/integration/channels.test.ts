import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { defineExtension, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  openKaeno,
  type KaenoChannel,
} from "../../src/core/application/index.ts";
import { TelegramState } from "../../src/channels/telegram/index.ts";

const assistant = {
  model: { provider: "faux", modelId: "faux-1" },
  instructions: "Assist",
};

it("starts channels before scheduling resumes and aborts before reverse cleanup", async () => {
  const events: string[] = [];
  function channel(name: string): KaenoChannel {
    return {
      start: async (core, signal) => {
        expect((await core.harness.inspect(context)).scheduling).toBe("paused");
        events.push(`start:${name}`);
        signal.addEventListener("abort", () => events.push(`abort:${name}`), {
          once: true,
        });
        return async () => {
          expect(signal.aborted).toBe(true);
          events.push(`close:${name}`);
        };
      },
    };
  }
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models: createModels(),
    assistant,
    channels: [channel("first"), channel("second")],
  });
  await core.close();
  await core.close();
  expect(events).toEqual([
    "start:first",
    "start:second",
    "abort:first",
    "abort:second",
    "close:second",
    "close:first",
  ]);
});

it("cleans up started channels and extensions when a later channel fails to start", async () => {
  const events: string[] = [];
  await expect(
    openKaeno({
      storage: new MemoryStorage(),
      models: createModels(),
      assistant,
      extensions: [
        {
          durable: defineExtension({ name: "service" }),
          start: async () => {
            events.push("start:extension");
            return async () => {
              events.push("close:extension");
            };
          },
        },
      ],
      channels: [
        {
          start: async (_core, signal) => {
            events.push("start:channel");
            signal.addEventListener(
              "abort",
              () => events.push("abort:channel"),
              { once: true },
            );
            return async () => {
              events.push("close:channel");
            };
          },
        },
        {
          start: async () => {
            throw new Error("listener failed");
          },
        },
      ],
    }),
  ).rejects.toThrow("listener failed");
  expect(events).toEqual([
    "start:extension",
    "start:channel",
    "abort:channel",
    "close:channel",
    "close:extension",
  ]);
});

it("recovers Telegram state after removing its empty durable extension registration", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "kaeno-channel-registration-"),
  );
  const path = join(directory, "core.sqlite");
  try {
    const original = await openKaeno({
      storage: await openNodeSqliteStorage(path),
      models: createModels(),
      assistant,
      extensions: [{ durable: defineExtension({ name: "kaeno-telegram" }) }],
    });
    try {
      await original.harness.commit(async (tx) => {
        const state = await tx.doc(TelegramState);
        state.offset = 42;
        state.threadOfSent["111:7"] = "telegram:111";
        state.pending = { chatId: 111, text: "Acknowledged" };
      }, context);
    } finally {
      await original.close();
    }
    const recovered = await openKaeno({
      storage: await openNodeSqliteStorage(path),
      models: createModels(),
      assistant,
    });
    try {
      expect(
        await recovered.harness.snapshot(TelegramState, context),
      ).toMatchObject({
        offset: 42,
        threadOfSent: { "111:7": "telegram:111" },
        pending: { chatId: 111, text: "Acknowledged" },
      });
    } finally {
      await recovered.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
