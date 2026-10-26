import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage as answer,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  defineExtension,
  defineTool,
  MemoryStorage,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { openKaeno, type Kaeno } from "../../src/core/application/index.ts";
import { parseTaskId } from "../../src/core/durable/index.ts";

const model = { provider: "faux", modelId: "faux-1" };
const orchestration = ["start_work", "message_work", "cancel_work"];
function call(name: string, args: JsonObject) {
  return answer([fauxToolCall(name, args)], { stopReason: "toolUse" });
}
async function user(core: Kaeno, key: string) {
  const chat = await core.threads.getOrCreateConversation(key);
  const turn = await core.harness.commit(
    (tx) => core.turns.admitUserTurn(tx, chat, "launch", `launch:${key}`),
    context,
  );
  await core.harness.waitForTask(turn, context);
  return chat;
}
async function works(core: Kaeno) {
  return (
    await core.harness.commit(
      (tx) => tx.scanTasks({ kind: "kaeno.work" }, 100),
      context,
    )
  ).items;
}

it("starts follow-on work from a final report without another user turn, but denies unrelated mutations", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const mutation = vi.fn<() => void>();
  const unrelated = defineTool({
    name: "unrelated_mutation",
    description: "A non-WORK mutation",
    parameters: Type.Object({}),
    execute: async () => {
      mutation();
      return { content: [{ type: "text", text: "mutated" }] };
    },
  });
  const denied: string[] = [];
  faux.setResponses(
    Array.from({ length: 40 }, () => async (request) => {
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      const content = JSON.stringify(last?.content);
      if (getCurrentSystemPrompt(request.messages).includes("WORKER")) {
        return answer(
          content.includes("follow-on") ? "SECOND RESULT" : "FIRST RESULT",
        );
      }
      if (last?.role === "toolResult") {
        if (last.toolName === unrelated.name) {
          denied.push(content);
          return call("start_work", {
            agent: "worker",
            title: "Second",
            brief: "Perform follow-on verification",
          });
        }
        return answer("STARTED");
      }
      if (content.includes("FIRST RESULT")) {
        return call(unrelated.name, {});
      }
      if (content.includes("SECOND RESULT")) {
        return answer("OBJECTIVE COMPLETE");
      }
      return call("start_work", {
        agent: "worker",
        title: "First",
        brief: "Investigate",
      });
    }),
  );
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant: {
      model,
      instructions: "CHAT",
      tools: [...orchestration, unrelated.name],
    },
    extensions: [
      { durable: defineExtension({ name: "unrelated", tools: [unrelated] }) },
    ],
    work: {
      agents: [
        {
          id: "worker",
          description: "Worker",
          setup: { model, instructions: "WORKER", tools: [] },
        },
      ],
      tools: orchestration,
      maxConcurrent: 1,
    },
  });
  try {
    const chat = await user(core, "follow-through");
    await vi.waitFor(async () => {
      expect((await core.turns.readReplies(chat, 0)).replies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: "OBJECTIVE COMPLETE",
            source: expect.objectContaining({
              kind: "activity-result",
              activityId: expect.any(Number),
              requestId: expect.stringMatching(/^activity-result:/),
              epoch: 0,
            }),
          }),
        ]),
      );
    });
    const records = await works(core);
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.state.status === "terminal")).toBe(
      true,
    );
    expect(
      records.find((record) =>
        JSON.stringify(record.input).includes('"title":"Second"'),
      )?.input,
    ).toMatchObject({
      parent: {
        kind: "chat",
        origin: {
          conversationId: chat,
          epoch: 0,
          requestId: expect.stringMatching(/^activity-result:/),
        },
      },
    });
    expect(mutation).not.toHaveBeenCalled();
    expect(denied).toHaveLength(1);
    expect(denied[0]).toContain("Assistant mutation requires a user turn");
    expect(
      (await core.turns.readReplies(chat, 0)).replies.filter(
        (reply) => reply.source.kind === "user",
      ),
    ).toHaveLength(1);
  } finally {
    await core.close();
  }
});

it("cancels its worker from a question result while rejecting cross-chat steering and cancellation", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let foreignWork = 0;
  let ownWork = 0;
  const rejections: string[] = [];
  faux.setResponses(
    Array.from({ length: 40 }, () => async (request) => {
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      const content = JSON.stringify(last?.content);
      if (getCurrentSystemPrompt(request.messages).includes("WORKER")) {
        return call("message_parent", { text: "Need a decision" });
      }
      if (last?.role === "toolResult") {
        if (last.toolName === "message_work") {
          rejections.push(content);
          return call("cancel_work", { id: foreignWork });
        }
        if (last.toolName === "cancel_work" && rejections.length === 1) {
          rejections.push(content);
          return call("cancel_work", { id: ownWork });
        }
        return answer("ACKNOWLEDGED");
      }
      if (content.includes("waits for a reply")) {
        if (foreignWork === 0) {
          return answer("WAITING FOR USER");
        }
        const match = content.match(/Work #(\d+)/);
        if (!match) {
          throw new Error("Missing work ID");
        }
        ownWork = Number(match[1]);
        return call("message_work", {
          id: foreignWork,
          text: "Cannot steer another chat",
        });
      }
      return call("start_work", {
        agent: "worker",
        title: "Question",
        brief: "Ask a question",
      });
    }),
  );
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant: { model, instructions: "CHAT", tools: orchestration },
    work: {
      agents: [
        {
          id: "worker",
          description: "Worker",
          setup: { model, instructions: "WORKER", tools: ["message_parent"] },
        },
      ],
      tools: [...orchestration, "message_parent"],
      maxConcurrent: 2,
    },
  });
  try {
    const otherChat = await user(core, "other");
    await vi.waitFor(async () => {
      expect(
        (await core.turns.readReplies(otherChat, 0)).replies.some(
          (reply) => reply.text === "WAITING FOR USER",
        ),
      ).toBe(true);
    });
    foreignWork = (await works(core))[0].id;
    const chat = await user(core, "owner");
    await vi.waitFor(async () => {
      expect(
        await core.harness.getTask(parseTaskId(ownWork), context),
      ).toMatchObject({
        state: { status: "terminal", outcome: { status: "aborted" } },
      });
    });
    expect(rejections).toHaveLength(2);
    expect(
      rejections.every((text) => text.includes("was not started here")),
    ).toBe(true);
    expect(
      await core.harness.getTask(parseTaskId(foreignWork), context),
    ).toMatchObject({
      abortRequested: false,
      state: { status: "running", checkpoint: { awaiting: "reply" } },
    });
    expect(
      (await core.turns.readReplies(chat, 0)).replies.filter(
        (reply) => reply.source.kind === "user",
      ),
    ).toHaveLength(1);
  } finally {
    await core.close();
  }
});
