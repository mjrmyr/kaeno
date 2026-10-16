import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import {
  configure,
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { parseTaskId } from "../../src/durable/index.ts";
import { admitTurn, defineTurn, TurnLedger } from "../../src/turns/index.ts";
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) {
    throw new Error("Missing value");
  }
  return value;
}
it.each([false, true])(
  "resumes a v1 notify checkpoint without a ledger (send fails=%s) and unblocks later reports",
  async (fail) => {
    const sent: string[] = [];
    const Turn = defineTurn(() => ({
      typing: async () => {},
      send: async (_route, text) => {
        if (fail && text === "ACK") {
          throw new Error("channel unavailable");
        }
        sent.push(text);
      },
    }));
    // Simulate the persisted checkpoint from an older implementation (or the last retry).
    const Legacy = defineTask<
      unknown,
      {
        phase: "notify";
        text: string;
        attempts: number;
      },
      null
    >({
      name: "kaeno.turn",
      version: 2,
      initial: () => ({ phase: "notify", text: "ACK", attempts: 5 }),
      phases: {
        notify: async () => {
          throw new Error("must run registered new definition");
        },
      },
      abort: async () => {
        throw new Error("not used");
      },
    });
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage([fauxText("DONE")])]);
    const registry = createRegistry();
    registry.install(defineExtension({ name: "turns", tasks: [Turn] }));
    const errors: unknown[] = [];
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry, onReport: (eventValue) => errors.push(eventValue) },
      ctx,
    );
    try {
      const root = await harness.createConversation(
        { ownership: { kind: "ownerless" } },
        ctx,
      );
      await harness.commit(
        (tx) =>
          configure(tx, root.id, {
            model: { provider: "faux", modelId: "faux-1" },
          }),
        ctx,
      );
      const old = await harness.commit(
        (tx) =>
          tx.createTask(
            Legacy,
            {
              conversationId: root.id,
              content: "old user text",
              requestId: "legacy-ack",
              notify: { route: { channel: "test", address: "111" } },
            },
            {
              ownership: { kind: "conversation" },
              conversationId: root.id,
              background: true,
            },
          ),
        ctx,
      );
      harness.resume();
      await harness.waitForTask(old, ctx);
      expect(
        required(
          required(await harness.snapshot(TurnLedger, root.id, ctx)).receipts[
            "legacy-ack"
          ],
        ).delivery,
      ).toBe(fail ? "failed" : "delivered");
      const report = await harness.commit(
        (tx) =>
          admitTurn(tx, Turn, {
            conversationId: root.id,
            content: "Verified activity result",
            requestId: "report-next",
            notify: { route: { channel: "test", address: "111" } },
            source: {
              kind: "activity-result",
              activityId: parseTaskId(123),
              epoch: 0,
              requestId: "legacy-ack",
            },
          }),
        ctx,
      );
      await harness.waitForTask(report, ctx);
      expect(sent).toEqual(fail ? ["DONE"] : ["ACK", "DONE"]);
      expect(errors.length).toBe(fail ? 1 : 0);
    } finally {
      await harness.close(ctx);
    }
  },
);
