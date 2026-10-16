import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  createRegistry,
  defineExtension,
  Harness,
  watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { minimalChatAgent } from "../../src/application/index.ts";
import { ApiServer } from "../../src/api/index.ts";
import { parseConfig } from "../../src/config/index.ts";
import { assertRecoveryCompatible } from "../../src/durable/index.ts";
import { ThreadDirectory } from "../../src/threads/index.ts";
import {
  defineControl,
  defineTurn,
  TurnCoordinator,
} from "../../src/turns/index.ts";

it("reopens native minimal conversations without WORK definitions or infrastructure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-minimal-"));
  const config = parseConfig({
    work: false,
    agent: "chat",
    templates: {
      chat: {
        description: "Chat",
        model: "anthropic/example",
        instructions: "Be helpful",
      },
    },
  });
  expect(config.sandboxResources).toBeUndefined();
  let harness: Harness | undefined;
  const getHarness = (): Harness => {
    if (!harness) {
      throw new Error("Harness is not open");
    }
    return harness;
  };
  const turn = defineTurn(() => ({
    send: async () => undefined,
    typing: async () => undefined,
  }));
  const control = defineControl(getHarness, async () => undefined);
  const turns = new TurnCoordinator(getHarness, turn, control);
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: "kaeno-channels", tasks: [turn, control] }),
  );
  const threads = new ThreadDirectory(getHarness, minimalChatAgent(config));
  const path = join(directory, "minimal.sqlite");
  try {
    harness = await Harness.open(
      await openNodeSqliteStorage(path),
      { registry, models: createModels(), settings: { extensions: [] } },
      context,
    );
    await assertRecoveryCompatible(harness, registry, context, {
      extensions: [],
    });
    const id = await threads.getOrCreateConversation("minimal");
    const binding = await harness.snapshot(AgentDoc, id, context);
    expect(binding).toMatchObject({
      extensions: [],
      tools: [],
      instructions: "Be helpful",
    });
    expect(binding?.cwd).toBeUndefined();
    await harness.close(context);
    harness = undefined;
    const reopened = await Harness.open(
      await openNodeSqliteStorage(path),
      { registry, models: createModels(), settings: { extensions: [] } },
      context,
    );
    harness = reopened;
    await assertRecoveryCompatible(reopened, registry, context, {
      extensions: [],
    });
    await threads.refreshIdleConversations();
    expect(await threads.getOrCreateConversation("minimal")).toBe(id);
    expect(await reopened.snapshot(AgentDoc, id, context)).toEqual(binding);
    expect((await reopened.inspect(context)).scheduling).toBe("paused");
    const api = new ApiServer(
      getHarness,
      threads,
      turns,
      undefined,
      {
        watchConversation: (conversation, ctx) =>
          watchEvents(reopened, conversation, ctx),
      },
      "secret",
    ).server;
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    try {
      const address = api.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP address");
      }
      for (const route of ["work", "work/1/artifacts"]) {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/v1/threads/absent/${route}`,
          { headers: { authorization: "Bearer secret" } },
        );
        expect(response.status).toBe(404);
      }
      expect((await threads.listConversations()).length).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        api.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } finally {
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
