import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  openKaeno,
  type AgentProfile,
  type Kaeno,
  type WorkEnvironment,
} from "../../src/core/application/index.ts";
const model = { provider: "faux", modelId: "faux-1" };
const orchestration = [
  "start_work",
  "message_work",
  "list_work",
  "cancel_work",
];
const assistant = {
  model,
  instructions: "LIFECYCLE CHAT",
  tools: orchestration,
};
function agent(id: string, tools: string[]): AgentProfile {
  return {
    id,
    description: id,
    setup: { model, instructions: `AGENT:${id}`, tools },
  };
}
function scripted(respond: FauxResponseFactory) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 60 }, () => respond));
  return models;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Missing lifecycle record");
  }
  return value;
}
function launch(agent: string, brief: string) {
  return call("start_work", { agent, title: agent, brief });
}
function call(name: string, args: Record<string, string | number>) {
  return fauxAssistantMessage([fauxToolCall(name, args)], {
    stopReason: "toolUse",
  });
}
async function turn(core: Kaeno, conversation: string, text: string) {
  const id = await core.threads.getOrCreateConversation(conversation);
  const task = await core.harness.commit(
    (tx) => core.turns.admitUserTurn(tx, id, text, text),
    ctx,
  );
  await core.harness.waitForTask(task, ctx);
  return id;
}
async function works(core: Kaeno) {
  return (
    await core.harness.commit(
      (tx) => tx.scanTasks({ kind: "kaeno.work" }, 100),
      ctx,
    )
  ).items;
}
async function waitState(core: Kaeno, awaiting: string) {
  await vi.waitFor(
    async () => {
      expect(
        (await works(core)).some(
          (record) =>
            record.state.status !== "terminal" &&
            z
              .object({ awaiting: z.string().optional() })
              .parse(record.state.checkpoint).awaiting === awaiting,
        ),
      ).toBe(true);
    },
    { timeout: 5000 },
  );
}
function environment() {
  const released: number[] = [];
  const env: WorkEnvironment = {
    identity: "test",
    cwd: "/workspace",
    ensure: async () => {},
    release: async (work, runtime) => {
      expect(
        (await runtime.snapshot(LiveDoc, work.conversationId, ctx))?.run,
      ).toBeFalsy();
      released.push(work.workId);
    },
    reconcile: async () => {},
    executionEnvironment: async () => undefined,
  };
  return { env, released };
}
it("keeps two real question/reply cycles live and reports only the final answer", async () => {
  let workId = 0;
  let workerTurns = 0;
  let questionReports = 0;
  const observed: string[] = [];
  const storage = new MemoryStorage();
  const commits = vi.spyOn(storage, "commit");
  const models = scripted(async (request) => {
    const prompt = getCurrentSystemPrompt(request.messages);
    const last = request.messages.findLast(
      (message) => message.role !== "system",
    );
    if (prompt.includes("AGENT:worker")) {
      workerTurns++;
      observed.push(JSON.stringify(last));
      if (workerTurns <= 2) {
        return call("message_parent", { text: `QUESTION ${workerTurns}` });
      }
      return fauxAssistantMessage("VERIFIED FINAL");
    }
    if (last?.role === "user") {
      const text = JSON.stringify(last.content);
      if (text.includes("launch")) {
        return launch("worker", "ORIGINAL BRIEF");
      }
      if (text.includes("sent a message and waits")) {
        questionReports++;
        return fauxAssistantMessage(`RELAY ${questionReports}`);
      }
      if (text.includes("reply-")) {
        return call("message_work", {
          id: workId,
          text: text.includes("reply-1") ? "ANSWER ONE" : "ANSWER TWO",
        });
      }
      return fauxAssistantMessage("FINAL RELAY");
    }
    return fauxAssistantMessage("ACK");
  });
  const { env, released } = environment();
  const core = await openKaeno({
    storage,
    models,
    assistant,
    work: {
      agents: [agent("worker", ["message_parent"])],
      tools: ["message_parent"],
      environment: env,
    },
  });
  try {
    await turn(core, "cycles", "launch");
    await waitState(core, "reply");
    workId = required((await works(core))[0]).id;
    await vi.waitFor(() => expect(questionReports).toBe(1));
    expect(released).toEqual([]);
    await turn(core, "cycles", "reply-1");
    await vi.waitFor(() => expect(questionReports).toBe(2));
    await waitState(core, "reply");
    await turn(core, "cycles", "reply-2");
    await core.harness.waitForTask(required((await works(core))[0]).id, ctx);
    expect((await works(core))[0]?.state).toMatchObject({
      status: "terminal",
      outcome: {
        status: "completed",
        result: { status: "completed", text: "VERIFIED FINAL" },
      },
    });
    expect(observed[0]).toContain("ORIGINAL BRIEF");
    expect(observed[1]).toContain("ANSWER ONE");
    expect(observed[2]).toContain("ANSWER TWO");
    // Release is best-effort after the terminal commit.
    await vi.waitFor(() => expect(released).toEqual([workId]));
    // CHAT report admission and its next WORK checkpoint must be one storage commit.
    for (const ordinal of [1, 2, "final"]) {
      const reportCommits = commits.mock.calls.filter(([writes]) =>
        writes.some(
          (write) =>
            write.type === "task" &&
            write.value.kind === "kaeno.turn" &&
            write.value.state.status === "pending" &&
            z.object({ requestId: z.string() }).parse(write.value.input)
              .requestId === `activity-result:${workId}:${ordinal}`,
        ),
      );
      expect(reportCommits).toHaveLength(1);
      const state =
        ordinal === "final"
          ? {
              outcome: expect.objectContaining({
                result: { status: "completed", text: "VERIFIED FINAL" },
              }),
            }
          : {
              checkpoint: expect.objectContaining({
                phase: "supervise",
                sent: ordinal,
                awaiting: "reply",
              }),
            };
      expect(required(reportCommits[0])[0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "task",
            value: expect.objectContaining({
              id: workId,
              state: expect.objectContaining(state),
            }),
          }),
        ]),
      );
    }
  } finally {
    await core.close();
  }
});
it("reopens an awaiting-reply SQLite checkpoint without repeating the brief or question", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-work-lifecycle-"));
  const path = join(directory, "db.sqlite");
  let workerTurns = 0;
  let questionReports = 0;
  let workId = 0;
  const models = scripted(async (request) => {
    const last = request.messages.findLast(
      (message) => message.role !== "system",
    );
    if (getCurrentSystemPrompt(request.messages).includes("AGENT:worker")) {
      workerTurns++;
      if (workerTurns === 1) {
        return call("message_parent", { text: "PERSISTED QUESTION" });
      }
      expect(JSON.stringify(last)).toContain("RECOVERED ANSWER");
      return fauxAssistantMessage("RECOVERED FINAL");
    }
    if (last?.role === "user") {
      const text = JSON.stringify(last.content);
      if (text.includes("launch")) {
        return launch("worker", "ONCE ONLY BRIEF");
      }
      if (text.includes("sent a message and waits")) {
        questionReports++;
      }
      if (text.includes("answer-after-reopen")) {
        return call("message_work", { id: workId, text: "RECOVERED ANSWER" });
      }
    }
    return fauxAssistantMessage("ACK");
  });
  const { env, released } = environment();
  const options = {
    models,
    assistant,
    work: {
      agents: [agent("worker", ["message_parent"])],
      tools: ["message_parent"],
      environment: env,
    },
  };
  let core = await openKaeno({
    ...options,
    storage: await openNodeSqliteStorage(path),
  });
  try {
    await turn(core, "recover", "launch");
    await waitState(core, "reply");
    await vi.waitFor(() => expect(questionReports).toBe(1));
    const record = required((await works(core))[0]);
    workId = record.id;
    await core.close();
    core = await openKaeno({
      ...options,
      storage: await openNodeSqliteStorage(path),
    });
    await turn(core, "recover", "answer-after-reopen");
    await core.harness.waitForTask(record.id, ctx);
    expect(workerTurns).toBe(2);
    expect(questionReports).toBe(1);
    expect(await works(core)).toHaveLength(1);
    expect((await works(core))[0]?.state).toMatchObject({
      outcome: { result: { text: "RECOVERED FINAL" } },
    });
    // Release is best-effort after the terminal commit.
    await vi.waitFor(() => expect(released).toEqual([workId]));
  } finally {
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it.each([false, true])(
  "uses the newest response instead of tool-round narration (error=%s)",
  async (fail) => {
    let rounds = 0;
    const models = scripted(async (request) => {
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      if (getCurrentSystemPrompt(request.messages).includes("AGENT:worker")) {
        rounds++;
        if (rounds === 1) {
          return fauxAssistantMessage(
            [fauxText("STALE NARRATION"), fauxToolCall("list_work", {})],
            { stopReason: "toolUse" },
          );
        }
        return fail
          ? fauxAssistantMessage([], {
              stopReason: "error",
              errorMessage: "newest-response-failed",
            })
          : fauxAssistantMessage("NEWEST VERIFIED ANSWER");
      }
      if (
        last?.role === "user" &&
        JSON.stringify(last.content).includes("launch")
      ) {
        return launch("worker", "Run");
      }
      return fauxAssistantMessage("ACK");
    });
    const { env, released } = environment();
    const core = await openKaeno({
      storage: new MemoryStorage(),
      models,
      assistant,
      work: {
        agents: [agent("worker", ["list_work"])],
        tools: ["list_work"],
        environment: env,
      },
    });
    try {
      await turn(core, "newest", "launch");
      const record = required((await works(core))[0]);
      await core.harness.waitForTask(record.id, ctx);
      expect((await works(core))[0]?.state).toMatchObject({
        status: "terminal",
        outcome: {
          result: {
            status: fail ? "failed" : "completed",
            text: fail
              ? "Work failed: newest-response-failed"
              : "NEWEST VERIFIED ANSWER",
          },
        },
      });
      // Release is best-effort after the terminal commit.
      await vi.waitFor(() => expect(released).toEqual([record.id]));
    } finally {
      await core.close();
    }
  },
);
it("waits for a live child, then cancels the subtree and releases both", async () => {
  let parentId = 0;
  let childStarted = false;
  const models = scripted(async (request) => {
    const prompt = getCurrentSystemPrompt(request.messages);
    const last = request.messages.findLast(
      (message) => message.role !== "system",
    );
    if (prompt.includes("AGENT:leaf")) {
      childStarted = true;
      return call("message_parent", { text: "CHILD BLOCKED" });
    }
    if (prompt.includes("AGENT:parent")) {
      if (
        last?.role === "user" &&
        JSON.stringify(last.content).includes("PARENT BRIEF")
      ) {
        return launch("leaf", "LEAF BRIEF");
      }
      return fauxAssistantMessage("PARENT NARRATION WHILE CHILD LIVES");
    }
    if (last?.role === "user") {
      const text = JSON.stringify(last.content);
      if (text.includes("launch")) {
        return launch("parent", "PARENT BRIEF");
      }
      if (text.includes("cancel-tree")) {
        return call("cancel_work", { id: parentId });
      }
    }
    return fauxAssistantMessage("ACK");
  });
  const { env, released } = environment();
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant,
    work: {
      agents: [
        agent("parent", ["start_work"]),
        agent("leaf", ["message_parent"]),
      ],
      tools: ["start_work", "message_parent"],
      environment: env,
      maxDepth: 2,
      maxConcurrent: 2,
    },
  });
  try {
    await turn(core, "tree", "launch");
    await vi.waitFor(() => expect(childStarted).toBe(true));
    await waitState(core, "children");
    const records = await works(core);
    const parent = required(
      records.find(
        (record) =>
          z.object({ agent: z.string() }).parse(record.input).agent ===
          "parent",
      ),
    );
    const child = required(records.find((record) => record.id !== parent.id));
    parentId = parent.id;
    expect(parent.state.status).not.toBe("terminal");
    expect(released).toEqual([]);
    await turn(core, "tree", "cancel-tree");
    await core.harness.waitForTask(parent.id, ctx);
    expect((await core.harness.getTask(child.id, ctx))?.state).toMatchObject({
      status: "terminal",
      outcome: { status: "aborted" },
    });
    expect((await core.harness.getTask(parent.id, ctx))?.state).toMatchObject({
      status: "terminal",
      outcome: { status: "aborted" },
    });
    // Release is best-effort after each terminal commit, so assert membership, not order.
    await vi.waitFor(() =>
      expect([...released].sort()).toEqual([child.id, parent.id].sort()),
    );
  } finally {
    await core.close();
  }
});
it("rejects steering before brief admission, then accepts a reply after the brief", async () => {
  const ensuring = Promise.withResolvers<void>();
  const allowBrief = Promise.withResolvers<void>();
  let workId = 0;
  let workerTurns = 0;
  const toolResults: string[] = [];
  const workerInputs: string[] = [];
  const models = scripted(async (request) => {
    const last = request.messages.findLast(
      (message) => message.role !== "system",
    );
    if (getCurrentSystemPrompt(request.messages).includes("AGENT:worker")) {
      workerInputs.push(JSON.stringify(last));
      workerTurns++;
      return workerTurns === 1
        ? call("message_parent", { text: "READY FOR REPLY" })
        : fauxAssistantMessage("ADMISSION VERIFIED");
    }
    if (last?.role === "toolResult" && last.toolName === "message_work") {
      toolResults.push(JSON.stringify(last));
    }
    if (last?.role === "user") {
      const text = JSON.stringify(last.content);
      if (text.includes("launch")) {
        return launch("worker", "FIRST BRIEF");
      }
      if (text.includes("reply-before-brief")) {
        return call("message_work", { id: workId, text: "TOO EARLY" });
      }
      if (text.includes("reply-after-brief")) {
        return call("message_work", { id: workId, text: "ADMITTED REPLY" });
      }
    }
    return fauxAssistantMessage("ACK");
  });
  const { env, released } = environment();
  env.ensure = async () => {
    ensuring.resolve();
    await allowBrief.promise;
  };
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant,
    work: {
      agents: [agent("worker", ["message_parent"])],
      tools: ["message_parent"],
      environment: env,
    },
  });
  try {
    await turn(core, "admission", "launch");
    await ensuring.promise;
    const record = required((await works(core))[0]);
    workId = record.id;
    await turn(core, "admission", "reply-before-brief");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toContain("still starting");
    expect(workerInputs).toEqual([]);
    allowBrief.resolve();
    await waitState(core, "reply");
    await turn(core, "admission", "reply-after-brief");
    await core.harness.waitForTask(record.id, ctx);
    expect(toolResults).toHaveLength(2);
    expect(toolResults[1]).toContain("Message delivered");
    expect(workerInputs).toHaveLength(2);
    expect(workerInputs[0]).toContain("FIRST BRIEF");
    expect(workerInputs[1]).toContain("ADMITTED REPLY");
    expect(workerInputs.join("\n")).not.toContain("TOO EARLY");
    // Release is best-effort after the terminal commit.
    await vi.waitFor(() => expect(released).toEqual([record.id]));
  } finally {
    allowBrief.resolve();
    await core.close();
  }
});
