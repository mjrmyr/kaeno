import type { JsonObject } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import {
  defineExtension,
  defineTool,
  LiveDoc,
  MemoryStorage,
} from "@earendil-works/pi-durable";
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
import {
  assignment,
  isRouterRequest,
  receive,
  ROUTER_ASSISTANT_TOOLS,
  sinceLastAnswer,
  startTicket,
  ticketConversation,
  ticketWhen,
  until,
} from "../mocks/router.ts";
const model = { provider: "faux", modelId: "faux-1" };
const assistant = {
  model,
  instructions: "LIFECYCLE ROUTER",
  tools: [...ROUTER_ASSISTANT_TOOLS],
};
function agent(id: string, tools: string[]): AgentProfile {
  return {
    id,
    description: id,
    setup: { model, instructions: `AGENT:${id}`, tools },
  };
}
function scripted(respond: FauxResponseFactory, onQuestion = () => {}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 60 }, () => async (...args) => {
      const [request] = args;
      if (!isRouterRequest(request)) {
        return respond(...args);
      }
      if (sinceLastAnswer(request).includes('state=\\"waiting\\"')) {
        onQuestion();
        return fauxAssistantMessage("RELAY");
      }
      return fauxAssistantMessage("ACK");
    }),
  );
  return models;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Missing lifecycle record");
  }
  return value;
}
function launch(agent: string, brief: string) {
  return call("start_work", {
    assignment: { kind: "task" },
    agent,
    title: agent,
    brief,
  });
}
async function ticket(core: Kaeno, agent: string, brief: string, key: string) {
  const id = await startTicket(core, {
    agent,
    title: agent,
    content: brief,
    key,
  });
  await assignment(core, id);
  return `test:ticket:${key}`;
}
function call(name: string, args: JsonObject) {
  return fauxAssistantMessage([fauxToolCall(name, args)], {
    stopReason: "toolUse",
  });
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
  const models = scripted(
    async (request) => {
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      workerTurns++;
      observed.push(JSON.stringify(last));
      if (workerTurns <= 2) {
        return call("message_parent", { text: `QUESTION ${workerTurns}` });
      }
      return fauxAssistantMessage("VERIFIED FINAL");
    },
    () => questionReports++,
  );
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
    const thread = await ticket(core, "worker", "ORIGINAL BRIEF", "cycles");
    await waitState(core, "reply");
    workId = required((await works(core))[0]).id;
    await vi.waitFor(() => expect(questionReports).toBe(1));
    expect(released).toEqual([]);
    await receive(core, "ANSWER ONE", { thread });
    await vi.waitFor(() => expect(questionReports).toBe(2));
    await waitState(core, "reply");
    await receive(core, "ANSWER TWO", { thread });
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
    expect(await works(core)).toHaveLength(1);
    expect(
      (await core.router.ticket("k1", ctx)).reports.map(
        (report) => report.state,
      ),
    ).toEqual(["waiting", "waiting", "ready"]);
    // Release is best-effort after the terminal commit.
    await vi.waitFor(() => expect(released).toEqual([workId]));
    for (const ordinal of [1, 2, "final"]) {
      const reportCommits = commits.mock.calls.filter(([writes]) =>
        writes.some(
          (write) =>
            write.type === "task" &&
            write.value.kind === "kaeno.dispatch" &&
            write.value.state.status === "pending" &&
            z.object({ requestId: z.string() }).safeParse(write.value.input)
              .data?.requestId === `report:${workId}:${ordinal}`,
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
  const briefs: string[] = [];
  const models = scripted(
    async (request) => {
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      briefs.push(
        ...request.messages.flatMap((message) =>
          JSON.stringify(message).includes("ONCE ONLY BRIEF")
            ? [JSON.stringify(message)]
            : [],
        ),
      );
      workerTurns++;
      if (workerTurns === 1) {
        return call("message_parent", { text: "PERSISTED QUESTION" });
      }
      expect(JSON.stringify(last)).toContain("RECOVERED ANSWER");
      return fauxAssistantMessage("RECOVERED FINAL");
    },
    () => questionReports++,
  );
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
    const thread = await ticket(core, "worker", "ONCE ONLY BRIEF", "recover");
    await waitState(core, "reply");
    await vi.waitFor(() => expect(questionReports).toBe(1));
    const record = required((await works(core))[0]);
    workId = record.id;
    await core.close();
    core = await openKaeno({
      ...options,
      storage: await openNodeSqliteStorage(path),
    });
    await receive(core, "RECOVERED ANSWER", { thread });
    await core.harness.waitForTask(record.id, ctx);
    expect(workerTurns).toBe(2);
    expect(questionReports).toBe(1);
    expect(briefs).toHaveLength(2);
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
      throw new Error(`Unexpected request: ${JSON.stringify(last)}`);
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
      await ticket(core, "worker", "Run", "newest");
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
      const done = await ticketWhen(
        core,
        "k1",
        (value) => value.status === "idle",
      );
      expect(done.reports.at(-1)).toMatchObject({
        state: fail ? "failed" : "ready",
        summary: fail
          ? "Work failed: newest-response-failed"
          : "NEWEST VERIFIED ANSWER",
      });
      // Release is best-effort after the terminal commit.
      await vi.waitFor(() => expect(released).toEqual([record.id]));
    } finally {
      await core.close();
    }
  },
);
it("waits for a live child, then cancels the subtree and releases both", async () => {
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
    throw new Error(`Unexpected request: ${JSON.stringify(last)}`);
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
    await ticket(core, "parent", "PARENT BRIEF", "tree");
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
    expect(child.input).toMatchObject({ brief: "LEAF BRIEF" });
    expect(parent.state.status).not.toBe("terminal");
    expect(released).toEqual([]);
    const stopped = await core.harness.commit(
      (tx) => core.router.stopTicket(tx, "k1", "owner", "cancel-tree"),
      ctx,
    );
    expect(stopped).toEqual([parent.id]);
    await core.router.abortWorks(stopped, ctx);
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
    const ended = await core.router.ticket("k1", ctx);
    expect(ended.status).toBe("ended");
    expect(ended.reports).toEqual([]);
  } finally {
    await core.close();
  }
});
it("holds an owner's message until the brief is admitted, then accepts a reply after it", async () => {
  const ensuring = Promise.withResolvers<void>();
  const allowBrief = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const workerInputs: string[] = [];
  const pause = defineTool({
    name: "pause",
    description: "Let steered input arrive",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "resumed" }] }),
  });
  const models = scripted(async (request) => {
    const inputs = JSON.stringify(
      request.messages.filter((message) => message.role === "user"),
    );
    workerInputs.push(inputs);
    if (inputs.includes("ADMITTED REPLY")) {
      return fauxAssistantMessage("ADMISSION VERIFIED");
    }
    if (inputs.includes("EARLY MESSAGE")) {
      return call("message_parent", { text: "READY FOR REPLY" });
    }
    await held.promise;
    return call("pause", {});
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
    extensions: [
      { durable: defineExtension({ name: "pause-test", tools: [pause] }) },
    ],
    work: {
      agents: [agent("worker", ["message_parent", "pause"])],
      tools: ["message_parent", "pause"],
      environment: env,
    },
  });
  async function early() {
    return (await core.harness.inspect(ctx)).tasks.find(
      ({ record: task }) =>
        task.kind === "kaeno.dispatch" &&
        JSON.stringify(task.input).includes("EARLY MESSAGE"),
    )?.record.state.status;
  }
  try {
    const thread = await ticket(core, "worker", "FIRST BRIEF", "admission");
    await ensuring.promise;
    const record = required((await works(core))[0]);
    await receive(core, "EARLY MESSAGE", { thread });
    await until(async () => (await early()) === "running", "the held message");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await early()).toBe("running");
    expect(workerInputs).toEqual([]);
    allowBrief.resolve();
    const conversation = await ticketConversation(core, "k1");
    await until(
      async () =>
        (await core.harness.commit(
          (tx) => tx.submissionByRequest(conversation, "input:k1:t2"),
          ctx,
        )) !== undefined,
      "the steer",
    );
    held.resolve();
    await waitState(core, "reply");
    await receive(core, "ADMITTED REPLY", { thread });
    await core.harness.waitForTask(record.id, ctx);
    expect((await works(core))[0]?.state).toMatchObject({
      outcome: { result: { text: "ADMISSION VERIFIED" } },
    });
    expect(workerInputs).toHaveLength(3);
    expect(workerInputs[0]).toContain("FIRST BRIEF");
    expect(workerInputs[0]).not.toContain("EARLY MESSAGE");
    expect(workerInputs[1]).toContain("EARLY MESSAGE");
    expect(workerInputs[2]).toContain("ADMITTED REPLY");
    // Release is best-effort after the terminal commit.
    await vi.waitFor(() => expect(released).toEqual([record.id]));
  } finally {
    allowBrief.resolve();
    held.resolve();
    await core.close();
  }
});

it.each(["local", "architectural"])(
  "rejects incomplete %s implementation dispatch before admission and delivers the behavior contract to the child",
  async (designKind) => {
    const contract = {
      kind: "implementation",
      expectedBehavior:
        "Worker B on ticket k1 continues the PR published by finished worker A; ticket k2 gets its own identity.",
      observedMismatch:
        "Inspection found publication lookup keyed by disposable worker ID; continuation loses the existing PR.",
      stateOwner:
        "Ticket owns publication identity; worker owns its local checkout.",
      checks: [
        {
          scenario:
            "A publishes and finishes; B continues k1; C publishes from k2",
          assertion: "B updates A's PR; C cannot inherit it",
          run: "Add lifecycle regression in github-workers.test.ts; npx vitest run --project integration test/integration/github-workers.test.ts",
        },
      ],
      design: {
        kind: "architectural",
        ownershipRepair: "Key publication identity by ticket and repository",
        workaround:
          "Add github_resume to find publication state of finished workers",
        decision:
          "Repair ownership; no finished-worker lookup or resume tool is needed",
      },
    };
    const invalid = [
      undefined,
      { kind: "implementation" },
      { ...contract, observedMismatch: "   " },
      { ...contract, checks: [] },
      { ...contract, checks: [{ ...contract.checks[0], assertion: " " }] },
      {
        ...contract,
        design: { kind: "architectural", decision: "Add resume" },
      },
    ];
    let attempts = 0;
    let childInput = "";
    let core: Kaeno;
    const models = scripted(async (request) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      if (prompt.includes("AGENT:implementer")) {
        childInput = JSON.stringify(request.messages);
        return fauxAssistantMessage("CONTRACT VERIFIED");
      }
      expect(prompt).toContain("assignment.kind=implementation");
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      if (attempts > 0 && attempts <= invalid.length) {
        // The real SDK validator must reject before WorkIndex/task/slot admission.
        expect(last).toMatchObject({ role: "toolResult", isError: true });
        expect(await works(core)).toHaveLength(1);
      }
      if (attempts <= invalid.length) {
        const assignment =
          attempts < invalid.length
            ? invalid[attempts]
            : {
                ...contract,
                design:
                  designKind === "local" ? { kind: "local" } : contract.design,
              };
        attempts++;
        return call("start_work", {
          agent: "implementer",
          title: "Repair continuation",
          brief:
            "Proposed fix: add github_resume. Reassess that proposal against the contract.",
          ...(assignment === undefined ? {} : { assignment }),
        });
      }
      return fauxAssistantMessage("PARENT DONE");
    });
    core = await openKaeno({
      storage: new MemoryStorage(),
      models,
      assistant,
      work: {
        agents: [agent("parent", ["start_work"]), agent("implementer", [])],
        tools: ["start_work"],
        maxDepth: 2,
        maxConcurrent: 2,
      },
    });
    try {
      await ticket(
        core,
        "parent",
        "Inspect and delegate the change",
        "contract",
      );
      await ticketWhen(core, "k1", (value) => value.status === "idle");
      expect(attempts).toBe(invalid.length + 1);
      const records = await works(core);
      expect(records).toHaveLength(2);
      const child = required(
        records.find(
          (record) =>
            z.object({ agent: z.string() }).parse(record.input).agent ===
            "implementer",
        ),
      );
      const brief = z.object({ brief: z.string() }).parse(child.input).brief;
      expect(brief).toContain(contract.expectedBehavior);
      expect(brief).toContain(contract.observedMismatch);
      expect(brief).toContain(contract.stateOwner);
      expect(brief).toContain(contract.checks[0].assertion);
      expect(brief).toContain(contract.checks[0].run);
      if (designKind === "architectural") {
        expect(brief).toContain(contract.design.ownershipRepair);
        expect(brief).toContain(contract.design.workaround);
        expect(brief).toContain(contract.design.decision);
      } else {
        expect(brief).not.toContain("## Ownership repair vs workaround");
      }
      expect(brief.indexOf("# Implementation contract")).toBeLessThan(
        brief.indexOf("Proposed fix:"),
      );
      // It is not just metadata: the actual child model sees the persisted artifact.
      expect(childInput).toContain(contract.stateOwner);
      expect(childInput).toContain(
        "proposed approach below is not an acceptance criterion",
      );
      expect(child.state).toMatchObject({
        status: "terminal",
        outcome: { status: "completed" },
      });
    } finally {
      await core.close();
    }
  },
);
