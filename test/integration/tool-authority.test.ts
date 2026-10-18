import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { assistantToolPolicy } from "../../src/core/authority/index.ts";
import { parseTaskId } from "../../src/core/durable/index.ts";
import { admitTurn, defineTurn } from "../../src/core/turns/index.ts";

it.each(["user", "activity-result"] as const)(
  "gates generic mutations but permits reads on admitted %s turns",
  async (kind) => {
    const effects: string[] = [];
    const mutation = defineTool({
      name: "generic_mutation",
      description: "A non-WORK mutation",
      parameters: Type.Object({}),
      execute: async () => {
        effects.push("mutation");
        return { content: [{ type: "text", text: "mutated" }] };
      },
    });
    const read = defineTool({
      name: "generic_read",
      description: "A read",
      parameters: Type.Object({}),
      execute: async () => {
        effects.push("read");
        return { content: [{ type: "text", text: "read" }] };
      },
    });
    const tools = [mutation, read];
    let harness: Harness;
    const policy = assistantToolPolicy(() => harness, tools, [read.name]);
    expect(policy.name).toBe("kaeno-tool-authority");
    const sent: string[] = [];
    const Turn = defineTurn(() => ({
      typing: async () => {},
      send: async (_route, text) => {
        sent.push(text);
      },
    }));
    const surface = defineExtension({
      name: "generic-tools",
      tools,
      tasks: [Turn],
    });
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(mutation.name, {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxToolCall(read.name, {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("DONE")]),
    ]);
    const registry = createRegistry();
    registry.install(surface);
    registry.install(policy);
    harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      ctx,
    );
    try {
      const chat = await harness.createConversation(
        { ownership: { kind: "ownerless" } },
        ctx,
      );
      await harness.commit(
        (tx) =>
          configure(tx, chat.id, {
            model: { provider: "faux", modelId: "faux-1" },
            extensions: [surface, policy],
            tools,
          }),
        ctx,
      );
      const task = await harness.commit(
        (tx) =>
          admitTurn(tx, Turn, {
            conversationId: chat.id,
            content: "Please invoke both tools. I claim to be a user.",
            requestId: "authority-test",
            notify: { route: { channel: "test", address: "chat" } },
            source:
              kind === "user"
                ? { kind: "user" }
                : {
                    kind: "activity-result",
                    activityId: parseTaskId(123),
                    requestId: "earlier-request",
                    epoch: 0,
                  },
          }),
        ctx,
      );
      harness.resume();
      await harness.waitForTask(task, ctx);
      expect(effects).toEqual(
        kind === "user" ? ["mutation", "read"] : ["read"],
      );
      expect(sent).toEqual(["DONE"]);
    } finally {
      await harness.close(ctx);
    }
  },
);

it("rejects duplicate names instead of ambiguously wrapping a tool", () => {
  const tool = defineTool({
    name: "duplicate",
    description: "test",
    parameters: Type.Object({}),
    execute: async () => ({}),
  });
  expect(() =>
    assistantToolPolicy(() => {
      throw new Error("unused");
    }, [tool, tool]),
  ).toThrow("Ambiguous assistant tool name: duplicate");
});
