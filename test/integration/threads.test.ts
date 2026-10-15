import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  configure,
  type ConversationId,
  createRegistry,
  Harness,
  MemoryStorage,
  type Tx,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.ts";
import { createThreadFixture, refreshThreads, thread } from "./composition.ts";
import { required, SANDBOX_RESOURCES } from "./values.ts";
it("refreshes an idle thread even before its first model submission, without duplicating it", async () => {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  let version = "first";
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
      await configure(tx, id, { instructions: version });
      return { template, skills: [] };
    },
  });
  try {
    const id = await thread(deps, "test:empty");
    version = "second";
    expect(await thread(deps, "test:empty")).toBe(id);
    expect(
      (await harness.snapshot(AgentDoc, id, BACKGROUND_CONTEXT))?.instructions,
    ).toBe("second");
    version = "third";
    await refreshThreads(deps);
    expect(
      (await harness.snapshot(AgentDoc, id, BACKGROUND_CONTEXT))?.instructions,
    ).toBe("third");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
