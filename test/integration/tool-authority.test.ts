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
  type ConversationId,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { assistantToolPolicy } from "../../src/core/authority/index.ts";
import { parseTaskId } from "../../src/core/durable/index.ts";
import {
  admitTurn,
  defineTurn,
  TurnLedger,
} from "../../src/core/turns/index.ts";

it.each([
  { kind: "user", autonomous: false, fenced: false },
  { kind: "user", autonomous: false, fenced: true },
  { kind: "activity-result", autonomous: false, fenced: false },
  { kind: "activity-result", autonomous: true, fenced: false },
  { kind: "activity-result", autonomous: true, fenced: true },
] as const)(
  "gates mutations and preserves reads ($kind, autonomous=$autonomous, fenced=$fenced)",
  async ({ kind, autonomous, fenced }) => {
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
    let chatId: ConversationId;
    const policy = assistantToolPolicy(
      () => harness,
      tools,
      [read.name],
      autonomous ? [mutation.name] : [],
    );
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
      async () => {
        if (fenced) {
          await harness.commit(async (tx) => {
            (await tx.doc(TurnLedger, chatId)).epoch++;
          }, ctx);
        }
        return fauxAssistantMessage([fauxToolCall(mutation.name, {})], {
          stopReason: "toolUse",
        });
      },
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
      chatId = chat.id;
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
        !fenced && (kind === "user" || autonomous)
          ? ["mutation", "read"]
          : ["read"],
      );
      if (fenced) {
        expect(sent).not.toContain("DONE");
        expect(sent).toHaveLength(kind === "user" ? 0 : 1);
      } else {
        expect(sent).toEqual(["DONE"]);
      }
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
