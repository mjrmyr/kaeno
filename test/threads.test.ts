import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { AgentDoc, configure, type Tx, type ConversationId, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { parseConfig } from "../src/config.ts";
import { thread, refreshThreads } from "../src/threads.ts";

it("refreshes an idle thread even before its first model submission, without duplicating it", async () => {
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  let version = "first";
  const template = parseConfig({ agent: "kaeno", templates: { kaeno: { description: "chat", model: "anthropic/chat", instructions: "profile" } } }).templates.kaeno!;
  const deps = { harness: () => harness, agent: { configure: async (tx: Tx, id: ConversationId) => {
    await configure(tx, id, { instructions: version });
    return { template, skills: [] };
  } } };
  try {
    const id = await thread(deps, "test:empty");
    version = "second";
    expect(await thread(deps, "test:empty")).toBe(id);
    expect((await harness.snapshot(AgentDoc, id, BACKGROUND_CONTEXT))?.instructions).toBe("second");
    version = "third";
    await refreshThreads(deps);
    expect((await harness.snapshot(AgentDoc, id, BACKGROUND_CONTEXT))?.instructions).toBe("third");
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
