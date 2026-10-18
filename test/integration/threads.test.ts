import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  configure,
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { ThreadDirectory } from "../../src/core/threads/index.ts";

it("refreshes an idle thread without duplicating its conversation", async () => {
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: createModels(),
      registry: createRegistry(),
    },
    context,
  );
  let instructions = "first";
  const threads = new ThreadDirectory(() => harness, {
    async configureChatConversation(tx, id): Promise<void> {
      await configure(tx, id, { instructions });
    },
  });
  try {
    const id = await threads.getOrCreateConversation("test:empty");
    instructions = "second";
    expect(await threads.getOrCreateConversation("test:empty")).toBe(id);
    expect((await harness.snapshot(AgentDoc, id, context))?.instructions).toBe(
      "second",
    );
    instructions = "third";
    await threads.refreshIdleConversations();
    expect((await harness.snapshot(AgentDoc, id, context))?.instructions).toBe(
      "third",
    );
  } finally {
    await harness.close(context);
  }
});
