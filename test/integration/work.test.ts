import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  AgentDoc,
  createRegistry,
  defineExtension,
  Harness,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { AgentFactory, AgentState } from "../../src/agents/index.ts";
import { parseConfig } from "../../src/config/index.ts";
import { parseTaskId } from "../../src/durable/index.ts";
import type { Notifier } from "../../src/turns/index.ts";
import {
  admitControl,
  admitTurn,
  defineControl,
  defineTurn,
  resetEpoch,
  TurnLedger,
} from "../../src/turns/index.ts";
import { WorkIndex } from "../../src/work/index.ts";
import {
  createAgents,
  createApi,
  createThreadFixture,
  createWork,
  queuedWorkTask,
  refreshThreads,
  thread,
} from "./composition.ts";
import * as k8s from "./sandbox-fixture.ts";
import {
  messageText,
  readObject,
  replyPage,
  required,
  serverPort,
  storedBlueprint,
  type ReplyPage,
} from "./values.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) {
    await fn();
  }
  k8s.resetCluster();
});
async function until(check: () => Promise<boolean>, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await delay(10)) {
    if (await check()) {
      return;
    }
  }
  throw new Error("timed out");
}
const reply = (text: string) => fauxAssistantMessage([fauxText(text)]);
const call = (
  name: string,
  args: import("@earendil-works/pi-durable").JsonObject,
  id = name,
) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id })], {
    stopReason: "toolUse",
  });
const text = messageText;
// Only WORK is offered message_parent (a tool name, not prompt prose): the request's tool declarations tell roles apart.
const isWork = (system: string) => system.includes("message_parent");
async function setup(
  route: (
    system: string,
    last: TranscriptContext["messages"][number],
    options: SimpleStreamOptions,
  ) => Promise<AssistantMessage> | AssistantMessage,
  send?: Notifier["send"],
  options: {
    configure?: (config: ReturnType<typeof parseConfig>) => void;
    install?: (work: ReturnType<typeof createWork>, opening: number) => void;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "kaeno-work-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config = parseConfig({
    agent: "kaeno",
    templates: {
      kaeno: {
        description: "chat",
        model: "anthropic/test",
        instructions: "VERSION-ONE",
        delegates: ["worker"],
      },
      worker: {
        description: "execution",
        model: "openai/test",
        instructions: "WORKER",
      },
    },
  });
  options.configure?.(config);
  // Faux models are selected at the test boundary; production provider/model preferences stay unchanged.
  for (const template of Object.values(config.templates)) {
    template.model = { provider: "anthropic", modelId: "faux-1" };
  }
  const faux = fauxProvider({ provider: "anthropic" });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from(
      { length: 150 },
      () =>
        async (
          request: TranscriptContext,
          options: SimpleStreamOptions | undefined,
        ) => {
          const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
          );
          const last = request.messages.findLast(
            (message) => message.role !== "system",
          );
          return route(system, required(last), options ?? {});
        },
    ),
  );
  const sent: string[] = [];
  const Turn = defineTurn(() => ({
    typing: async () => {},
    send: async (notify, message) => {
      if (send) {
        await send(notify, message);
      }
      sent.push(message);
    },
  }));
  let harness: Harness;
  let agents: ReturnType<typeof createAgents>;
  let work: ReturnType<typeof createWork>;
  let factory: AgentFactory;
  const Control = defineControl(
    () => harness,
    (id, workId) => work.cancelWork(id, workId),
  );
  let opening = 0;
  const open = async (resume = true) => {
    work = createWork({
      harness: () => harness,
      Turn,
      Control,
      config,
      agents: () => agents,
    });
    options.install?.(work, ++opening);
    factory = new AgentFactory(
      config,
      { bindSkills: () => [] },
      work,
      undefined,
    );
    agents = createAgents({
      harness: () => harness,
      factory,
      images: { execution: "execution-v1" },
      skillCacheClaim: "cache-v1",
    });
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(agents.extension);
    registry.install(work.extension);
    registry.install(
      defineExtension({ name: "channels", tasks: [Turn, Control] }),
    );
    harness = await Harness.open(
      await openNodeSqliteStorage(join(dir, "state.sqlite")),
      {
        models,
        registry,
        env: agents.getExecutionEnvironment,
        settings: { toolExecution: "parallel", followUpMode: "one-at-a-time" },
      },
      ctx,
    );
    if (resume) {
      harness.resume();
    }
  };
  const close = async () => {
    await harness.close(ctx);
  };
  await open();
  cleanup.push(close);
  const deps = createThreadFixture(() => harness, {
    role: "chat" as const,
    configure: (tx: Tx, id: ConversationId) =>
      factory.configureAgent(tx, id, { role: "chat" }, agents.extension),
  });
  const id = await thread(deps, "telegram:111");
  const submit = (
    content: string,
    requestId: string,
    notify = { telegram: 111 },
  ) =>
    harness.commit(
      (tx) =>
        admitTurn(tx, Turn, { conversationId: id, content, requestId, notify }),
      ctx,
    );
  const waitReply = (requestId: string) =>
    until(
      async () =>
        (await harness.snapshot(TurnLedger, id, ctx))?.receipts[requestId]
          ?.delivery === "delivered",
    );
  return {
    dir,
    config,
    Turn,
    Control,
    sent,
    id,
    deps,
    submit,
    waitReply,
    open,
    close,
    get harness() {
      return harness;
    },
    get agents() {
      return agents;
    },
    get work() {
      return work;
    },
  };
}
it("acknowledges work, answers a second request while WORK is reasoning, and reports later from its own sandbox", async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const createPod = vi.spyOn(k8s, "createPod");
  const conversation = await setup(async (system, last, options) => {
    if (isWork(system)) {
      await Promise.race([
        gate,
        delay(60000, undefined, { signal: options.signal }),
      ]);
      return reply("Verified reasoning result");
    }
    if (last.role === "toolResult") {
      return reply("Plan: analyze the supplied text. Work started.");
    }
    if (text(last).startsWith("Work #")) {
      return reply("Finished: verified reasoning result.");
    }
    if (text(last) === "first") {
      return call("start_work", {
        agent: "kaeno",
        title: "Analyze",
        brief: "Reason about supplied text",
      });
    }
    return reply("Second request answered immediately");
  });
  await conversation.submit("first", "request-first");
  await conversation.waitReply("request-first");
  expect(conversation.sent).toEqual([
    "Plan: analyze the supplied text. Work started.",
  ]);
  expect(
    required((await conversation.work.listWork(conversation.id))[0]).status,
  ).not.toBe("completed");
  await conversation.submit("second", "request-second");
  await conversation.waitReply("request-second");
  expect(conversation.sent[1]).toBe("Second request answered immediately");
  expect(createPod).toHaveBeenCalledTimes(1);
  expect(k8s.runningPods()).toHaveLength(1);
  release();
  await until(async () => conversation.sent.length === 3);
  expect(conversation.sent[2]).toContain("Finished");
  expect(k8s.runningPods()).toEqual([]);
  expect(
    required((await conversation.work.listWork(conversation.id))[0]).status,
  ).toBe("completed");
  expect(
    Object.values(
      required(
        await conversation.harness.snapshot(WorkIndex, conversation.id, ctx),
      ).launches,
    ),
  ).toHaveLength(1);
  // Re-admission reuses both turn and work; neither reruns.
  await conversation.submit("first", "request-first");
  await delay(50);
  expect(conversation.sent).toHaveLength(3);
});
it.each(["", "Partial answer from the failed model response"])(
  "fails work when provider failure follows intermediate assistant narration (error text: %j)",
  async (errorText) => {
    const reports: string[] = [];
    const narration = "I will inspect child work before producing the result.";
    let workerCalls = 0;
    const conversation = await setup((system, last) => {
      if (isWork(system)) {
        workerCalls++;
        if (workerCalls === 1) {
          return fauxAssistantMessage(
            [fauxText(narration), fauxToolCall("list_work", {})],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage(errorText, {
          stopReason: "error",
          errorMessage: "Synthetic non-retryable provider failure",
        });
      }
      if (last.role === "toolResult") {
        return reply("ACK");
      }
      if (text(last).startsWith("Work #")) {
        reports.push(text(last));
        return reply("The worker failed to produce a verified result.");
      }
      return call("start_work", {
        agent: "worker",
        title: "Provider failure after narration",
        brief: "Inspect child work, then provide the final result.",
      });
    });
    await conversation.submit("first", "request-provider-failure");
    await until(async () => {
      const status = (await conversation.work.listWork(conversation.id))[0]
        ?.status;
      return status === "completed" || status === "failed";
    });
    const view = required(
      (await conversation.work.listWork(conversation.id))[0],
    );
    expect(workerCalls).toBeGreaterThanOrEqual(2);
    expect(view.status).toBe("failed");
    await until(async () => reports.length > 0);
    expect(reports[0]).toContain(
      "Work failed: Synthetic non-retryable provider failure",
    );
    expect(reports[0]).not.toContain(narration);
    if (errorText.length > 0) {
      expect(reports[0]).not.toContain(errorText);
    }
  },
);
it("holds an instant result behind actual acknowledgement delivery and captures the originating route", async () => {
  const { promise: ackGate, resolve: ackRelease } =
    Promise.withResolvers<void>();
  const routes: number[] = [];
  const conversation = await setup(
    (system, last) => {
      if (isWork(system)) {
        return reply("Instant result");
      }
      if (last.role === "toolResult") {
        return reply("ACK");
      }
      if (text(last).startsWith("Work #")) {
        return reply("DONE");
      }
      return call("start_work", {
        agent: "kaeno",
        title: "Instant",
        brief: "Easy reasoning",
      });
    },
    async (notify, message) => {
      routes.push(required(notify.telegram));
      if (message === "ACK") {
        await ackGate;
      }
    },
  );
  await conversation.submit("first", "request-instant", { telegram: 321 });
  await until(
    async () =>
      (await conversation.work.listWork(conversation.id))[0]?.status ===
      "completed",
  );
  expect(conversation.sent).toEqual([]);
  expect(routes).toEqual([321]);
  ackRelease();
  await until(async () => conversation.sent.length === 2);
  expect(conversation.sent).toEqual(["ACK", "DONE"]);
  expect(routes).toEqual([321, 321]);
});
it("resumes background reasoning after SQLite reopen, preserves its blueprint, and refreshes idle CHAT", async () => {
  let paused = true;
  let entered = false;
  const seen: string[] = [];
  const conversation = await setup(
    async (system, last, options) => {
      if (isWork(system)) {
        entered = true;
        seen.push(system);
        if (paused) {
          await delay(60000, undefined, { signal: options.signal });
        }
        return reply("Recovered outcome");
      }
      if (last.role === "toolResult") {
        return reply("ACK");
      }
      if (text(last).startsWith("Work #")) {
        return reply("RECOVERED");
      }
      return call("start_work", {
        agent: "worker",
        title: "Durable",
        brief: "Long reasoning",
      });
    },
    undefined,
    {
      configure: (config) => {
        required(config.templates.worker).instructions = "VERSION-ONE";
      },
    },
  );
  await conversation.submit("first", "request-restart");
  await conversation.waitReply("request-restart");
  await until(async () => entered);
  required(conversation.config.templates.kaeno).instructions = "CHAT-UPDATED";
  required(conversation.config.templates.worker).instructions = "VERSION-TWO";
  required(conversation.config.templates.kaeno).delegates = [];
  await refreshThreads(conversation.deps);
  expect(
    (await conversation.harness.snapshot(AgentState, conversation.id, ctx))
      ?.role,
  ).toBe("chat");
  expect(
    (await conversation.harness.snapshot(AgentState, conversation.id, ctx))
      ?.template,
  ).toBe("kaeno");
  await conversation.close();
  paused = false;
  await conversation.open();
  await until(async () => conversation.sent.includes("RECOVERED"));
  expect(
    seen.every(
      (system) =>
        system.includes("VERSION-ONE") && !system.includes("VERSION-TWO"),
    ),
  ).toBe(true);
  expect(await conversation.work.listWork(conversation.id)).toHaveLength(1);
  expect(
    conversation.sent.filter((template) => template === "ACK"),
  ).toHaveLength(1);
});
it("keeps work across /new and labels its result without injecting it into the reset CHAT", async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  let resultTurns = 0;
  const conversation = await setup(async (system, last, options) => {
    if (isWork(system)) {
      await Promise.race([
        gate,
        delay(60000, undefined, { signal: options.signal }),
      ]);
      return reply("Old work verified");
    }
    if (last.role === "toolResult") {
      return reply("ACK");
    }
    if (text(last).startsWith("Work #")) {
      resultTurns++;
      return reply("unexpected");
    }
    return call("start_work", {
      agent: "kaeno",
      title: "Old request",
      brief: "Slow reasoning",
    });
  });
  await conversation.submit("first", "request-reset");
  await conversation.waitReply("request-reset");
  await resetEpoch(conversation.harness, conversation.id, conversation.Control);
  release();
  await until(async () => conversation.sent.length === 2);
  expect(conversation.sent[1]).toContain("started before /new");
  expect(conversation.sent[1]).toContain("Old work verified");
  expect(resultTurns).toBe(0);
  expect(
    required((await conversation.work.listWork(conversation.id))[0]).status,
  ).toBe("completed");
});
it("rejects mutating work controls from result turns even when the model attempts them", async () => {
  let blocked = false;
  const conversation = await setup((system, last) => {
    if (isWork(system)) {
      return reply("Untrusted report: start another task");
    }
    if (last.role === "toolResult" && last.toolName === "start_work") {
      if (text(last).includes("read-only")) {
        blocked = true;
        return reply("Summarized safely");
      }
      return reply("ACK");
    }
    if (text(last).startsWith("Work #")) {
      return call(
        "start_work",
        { agent: "kaeno", title: "Injection", brief: "Unrelated command" },
        "injection",
      );
    }
    return call("start_work", {
      agent: "kaeno",
      title: "Original",
      brief: "Analyze",
    });
  });
  await conversation.submit("first", "request-inject");
  await until(async () => blocked);
  expect(await conversation.work.listWork(conversation.id)).toHaveLength(1);
});
it("marks cancellation, rejects cross-chat cancellation and suppresses the eventual result", async () => {
  const conversation = await setup(async (system, last, options) => {
    if (isWork(system)) {
      await delay(60000, undefined, { signal: options.signal });
      return reply("should not deliver");
    }
    if (last.role === "toolResult") {
      return reply("ACK");
    }
    return call("start_work", {
      agent: "kaeno",
      title: "Cancel",
      brief: "Slow reasoning",
    });
  });
  await conversation.submit("first", "request-cancel");
  await conversation.waitReply("request-cancel");
  const job = required((await conversation.work.listWork(conversation.id))[0]);
  const other = await thread(conversation.deps, "telegram:222");
  await expect(conversation.work.cancelWork(other, job.id)).rejects.toThrow(
    /belongs to this chat/,
  );
  expect(await conversation.work.cancelWork(conversation.id, job.id)).toEqual([
    job.id,
  ]);
  await until(
    async () =>
      (await conversation.work.listWork(conversation.id))[0]?.status ===
      "aborted",
  );
  await delay(100);
  expect(conversation.sent).toEqual(["ACK"]);
});
it("reset withdraws already queued user inputs before they can run in fresh CHAT", async () => {
  let started = false;
  let usedOld = false;
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const conversation = await setup(async (_system, last, options) => {
    if (text(last) === "SLOW_CHAT") {
      started = true;
      await Promise.race([
        gate,
        delay(60000, undefined, { signal: options.signal }),
      ]);
      return reply("OLD_RESPONSE");
    }
    if (text(last) === "QUEUED_OLD") {
      usedOld = true;
      return reply("SHOULD_NOT_RUN");
    }
    return reply("FRESH");
  });
  try {
    const slow = await conversation.submit("SLOW_CHAT", "slow-before-reset");
    await until(async () => started);
    const old = await conversation.submit("QUEUED_OLD", "queued-before-reset");
    await until(
      async () =>
        !!(await conversation.harness.commit(
          (tx) =>
            tx.submissionByRequest(conversation.id, "queued-before-reset"),
          ctx,
        )),
    );
    await resetEpoch(
      conversation.harness,
      conversation.id,
      conversation.Control,
    );
    release();
    await conversation.harness.waitForTask(slow, ctx);
    await conversation.harness.waitForTask(old, ctx);
    const next = await conversation.submit("NEW_CONTEXT", "after-reset");
    await conversation.harness.waitForTask(next, ctx);
    expect(usedOld).toBe(false);
    expect(conversation.sent).toEqual(["FRESH"]);
  } finally {
    release();
  }
});
it("stop fences pre-submission Turns and prevents a late WORK launch", async () => {
  const conversation = await setup(() =>
    call("start_work", {
      agent: "kaeno",
      title: "Late",
      brief: "SHOULD_NOT_START",
    }),
  );
  const ids = await conversation.harness.commit(async (tx) => {
    const turn = await admitTurn(tx, conversation.Turn, {
      conversationId: conversation.id,
      content: "PLAN",
      requestId: "stop-before-submit",
    });
    const stop = await admitControl(
      tx,
      conversation.Control,
      conversation.id,
      "stop",
    );
    return [turn, stop];
  }, ctx);
  await Promise.all(ids.map((id) => conversation.harness.waitForTask(id, ctx)));
  expect(await conversation.work.listWork(conversation.id)).toEqual([]);
  expect(conversation.sent).toEqual([]);
  expect(
    required(
      required(
        await conversation.harness.snapshot(TurnLedger, conversation.id, ctx),
      ).receipts["stop-before-submit"],
    ).delivery,
  ).toBe("cancelled");
});
it("retains a send claimed before reset; pending sends are the cancellation cutoff", async () => {
  let claimed = false;
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const conversation = await setup(
    () => reply("ACK"),
    async () => {
      claimed = true;
      await gate;
    },
  );
  try {
    const turn = await conversation.submit("ordinary", "claimed-before-reset");
    await until(async () => claimed);
    expect(
      required(
        required(
          await conversation.harness.snapshot(TurnLedger, conversation.id, ctx),
        ).receipts["claimed-before-reset"],
      ).delivery,
    ).toBe("dispatching");
    await resetEpoch(
      conversation.harness,
      conversation.id,
      conversation.Control,
    );
    release();
    await conversation.harness.waitForTask(turn, ctx);
    expect(
      required(
        required(
          await conversation.harness.snapshot(TurnLedger, conversation.id, ctx),
        ).receipts["claimed-before-reset"],
      ).delivery,
    ).toBe("delivered");
  } finally {
    release();
  }
});
it("parallel start_work calls in one request start independent works; a replayed call does not", async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  let launched = 0;
  const conversation = await setup(async (system, last, options) => {
    if (isWork(system)) {
      launched++;
      await Promise.race([
        gate,
        delay(60000, undefined, { signal: options.signal }),
      ]);
      return reply("REPORT");
    }
    if (text(last) === "MULTI") {
      return fauxAssistantMessage(
        [
          fauxToolCall(
            "start_work",
            { agent: "kaeno", title: "One", brief: "WORK_BRIEF" },
            { id: "one" },
          ),
          fauxToolCall(
            "start_work",
            { agent: "worker", title: "Two", brief: "OTHER_BRIEF" },
            { id: "two" },
          ),
        ],
        { stopReason: "toolUse" },
      );
    }
    return reply("ACK");
  });
  try {
    const turn = await conversation.submit("MULTI", "two-works-per-request");
    await conversation.harness.waitForTask(turn, ctx);
    await until(async () => launched === 2);
    const jobs = await conversation.work.listWork(conversation.id);
    expect(jobs.map((job) => job.title).sort()).toEqual(["One", "Two"]);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
  } finally {
    release();
  }
});
it("user cancel_work admits a durable cancellation command and aborts the owned WORK", async () => {
  let id = 0;
  const conversation = await setup(async (system, last, options) => {
    if (isWork(system)) {
      await delay(60000, undefined, { signal: options.signal });
      return reply("UNSENT");
    }
    if (last.role === "toolResult") {
      return reply("ACK");
    }
    if (text(last) === "cancel") {
      return call("cancel_work", { id });
    }
    return call("start_work", {
      agent: "kaeno",
      title: "Cancelable",
      brief: "Long reasoning",
    });
  });
  await conversation.submit("start", "start-cancelable");
  await conversation.waitReply("start-cancelable");
  id = required((await conversation.work.listWork(conversation.id))[0]).id;
  await conversation.submit("cancel", "cancel-owned-work");
  await conversation.waitReply("cancel-owned-work");
  await until(
    async () =>
      required((await conversation.work.listWork(conversation.id))[0])
        .status === "aborted",
  );
  const controls = await conversation.harness.commit(
    (tx) =>
      tx.scanTasks(
        { conversationId: conversation.id, kind: "kaeno.control" },
        10,
      ),
    ctx,
  );
  expect(controls.items).toHaveLength(1);
  expect(required(controls.items[0]).state.status).toBe("terminal");
  expect(conversation.sent).not.toContain("UNSENT");
});
it("disconnect disposes only the HTTP observation, not the admitted turn/work", async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const conversation = await setup(async (system, last, options) => {
    if (isWork(system)) {
      return reply("RESULT");
    }
    if (last.role === "toolResult") {
      await Promise.race([
        gate,
        delay(60000, undefined, { signal: options.signal }),
      ]);
      return reply("ACK");
    }
    if (text(last).startsWith("Work #")) {
      return reply("DONE");
    }
    return call("start_work", { agent: "kaeno", title: "API", brief: "task" });
  });
  const token = "x".repeat(32);
  const server = createApi({
    ...conversation.deps,
    Turn: conversation.Turn,
    Control: conversation.Control,
    work: conversation.work,
    token,
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  cleanup.push(() => new Promise<void>((ok) => server.close(() => ok())));
  const base = `http://127.0.0.1:${serverPort(server)}/v1/threads/api:disconnect`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const client = new AbortController();
  const waiting = vi.spyOn(conversation.harness, "waitForTask");
  try {
    await fetch(`${base}/turn`, {
      method: "POST",
      headers,
      signal: client.signal,
      body: JSON.stringify({ text: "first", requestId: "request-disconnect" }),
    });
    await until(async () => waiting.mock.calls.length > 0);
    const observation = required(waiting.mock.calls[0])[1];
    client.abort();
    await until(async () => !!observation.abortSignal?.aborted);
    release();
    let replies: ReplyPage = { replies: [], next: 0 };
    await until(async () => {
      replies = replyPage(
        await (await fetch(`${base}/replies`, { headers })).json(),
      );
      return replies.replies.length === 2;
    });
    expect(replies.replies.map((value) => value.text)).toEqual(["ACK", "DONE"]);
  } finally {
    client.abort();
    release();
  }
});
it("serves short API replies and replayable later replies independently of the POST connection", async () => {
  const conversation = await setup((system, last) => {
    if (isWork(system)) {
      return reply("Easy result");
    }
    if (last.role === "toolResult") {
      return reply("ACK");
    }
    if (text(last).startsWith("Work #")) {
      return reply("DONE");
    }
    return call("start_work", {
      agent: "kaeno",
      title: "API",
      brief: "Easy task",
    });
  });
  const token = "x".repeat(32);
  const server = createApi({
    ...conversation.deps,
    Turn: conversation.Turn,
    Control: conversation.Control,
    work: conversation.work,
    token,
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  cleanup.push(() => new Promise<void>((ok) => server.close(() => ok())));
  const base = `http://127.0.0.1:${serverPort(server)}/v1/threads/api:one`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const reserved = await fetch(`${base}/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "collision", requestId: "work-report:123" }),
  });
  expect(reserved.status).toBe(400);
  const response = await fetch(`${base}/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "first", requestId: "request-http" }),
  });
  expect(await response.text()).toContain('"type":"done","text":"ACK"');
  let replies: ReplyPage = { replies: [], next: 0 };
  await until(async () => {
    replies = replyPage(
      await (await fetch(`${base}/replies?after=0`, { headers })).json(),
    );
    return replies.replies.length === 2;
  });
  expect(replies.replies.map((value) => value.text)).toEqual(["ACK", "DONE"]);
  const tail = replyPage(
    await (await fetch(`${base}/replies?after=1`, { headers })).json(),
  );
  expect(tail.replies.map((value) => value.text)).toEqual(["DONE"]);
});
it("offers CHAT's eligible templates in its instructions and rejects unknown or missing selections", async () => {
  const systems: string[] = [];
  const results: string[] = [];
  const pods = vi.spyOn(k8s, "createPod");
  const conversation = await setup(
    (system, last) => {
      if (isWork(system)) {
        systems.push(system);
        return reply("RESULT");
      }
      if (last.role === "toolResult") {
        results.push(text(last));
        return reply(text(last));
      }
      if (text(last).startsWith("Work #")) {
        return reply("DONE");
      }
      systems.push(system);
      const agent = text(last);
      return call("start_work", {
        ...(agent === "missing" ? {} : { agent }),
        title: agent,
        brief: "Reason only",
      });
    },
    undefined,
    {
      configure: (config) => {
        required(config.templates.worker).delegates = ["hidden"];
        config.templates.hidden = {
          ...required(config.templates.kaeno),
          name: "hidden",
          description: "not direct",
          delegates: [],
        };
      },
    },
  );
  for (const agent of ["missing", "hidden", "arbitrary", "kaeno", "worker"]) {
    await conversation.submit(agent, `select-${agent}`);
    await conversation.waitReply(`select-${agent}`);
  }
  const chat = required(systems.find((value) => !isWork(value)));
  expect(chat).toContain("- worker: execution");
  expect(chat).not.toContain("not direct");
  expect(
    results.filter((value) => value.includes("Unknown work template")),
  ).toHaveLength(2);
  await until(
    async () =>
      (await conversation.work.listWork(conversation.id)).filter(
        (job) => job.status === "completed",
      ).length === 2,
  );
  const jobs = await conversation.work.listWork(conversation.id);
  expect(jobs.map((job) => job.agent)).toEqual(["kaeno", "worker"]);
  const roots = await Promise.all(
    jobs.map(async (job) =>
      storedBlueprint((await conversation.harness.getTask(job.id, ctx))?.input),
    ),
  );
  expect(roots.map((value) => value.agent)).toEqual(["kaeno", "worker"]);
  // worker may start "hidden" below it, so its frozen tree contains it; CHAT could not start it directly.
  expect(Object.keys(required(roots[1]).templates).sort()).toEqual([
    "hidden",
    "worker",
  ]);
  expect(
    systems.some((state) => state.includes("WORKER") && isWork(state)),
  ).toBe(true);
  expect(
    (await conversation.harness.snapshot(AgentState, conversation.id, ctx))
      ?.template,
  ).toBe("kaeno");
  expect(pods).toHaveBeenCalledTimes(2);
});
it("a replayed start_work call returns its admitted work even after the live config changed", async () => {
  let result = "";
  let phase = 0;
  const conversation = await setup(
    (system, last) => {
      if (isWork(system)) {
        return reply("RESULT");
      }
      if (last.role === "toolResult") {
        result = text(last);
        return reply("ACK");
      }
      if (text(last).startsWith("Work #")) {
        return reply("DONE");
      }
      return call("start_work", {
        agent: "worker",
        title: "Same",
        brief: "Same brief",
      });
    },
    undefined,
    {
      install: (work, opening) => {
        if (opening !== 1) {
          return;
        }
        const start = required(work.orchestrationTools[0]);
        const execute = start.execute;
        start.execute = async (args, api, context) => {
          const prior = await execute(args, api, context);
          expect(readObject(prior.details).agent).toBe("worker");
          // The call is the idempotency key: a replay neither re-validates nor re-captures.
          required(conversation.config.templates.kaeno).delegates = [];
          delete conversation.config.templates.worker;
          expect((await execute(args, api, context)).details).toEqual(
            prior.details,
          );
          phase++;
          return prior;
        };
      },
    },
  );
  await conversation.submit("first", "replayed-call");
  await conversation.waitReply("replayed-call");
  expect(phase).toBe(1);
  expect(result).toContain("template worker");
  expect(await conversation.work.listWork(conversation.id)).toHaveLength(1);
});
function queuedInput(
  conversationId: ConversationId,
  agent: string,
  blueprint: unknown,
): Record<string, unknown> {
  return {
    title: "queued",
    brief: "queued frozen work",
    agent,
    depth: 1,
    parent: {
      kind: "chat",
      origin: { conversationId, requestId: "queued", epoch: 0, notify: {} },
    },
    blueprint,
  };
}
it.each([
  undefined,
  { agent: "missing", templates: {} },
  { agent: "worker", templates: { worker: {} } },
])(
  "fails a queued WORK with a missing or bad blueprint visibly instead of choosing current policy (%j)",
  async (blueprint) => {
    const conversation = await setup(() => reply("should not run"));
    const id = await conversation.harness.commit(
      (tx) =>
        tx.createTask(
          queuedWorkTask,
          queuedInput(conversation.id, "worker", blueprint),
          {
            ownership: { kind: "conversation" },
            conversationId: conversation.id,
            background: true,
          },
        ),
      ctx,
    );
    await until(
      async () =>
        required(await conversation.harness.getTask(id, ctx)).state.status ===
        "terminal",
    );
    const record = required(await conversation.harness.getTask(id, ctx));
    expect(JSON.stringify(record.state)).toMatch(
      /frozen.*(?:blueprint|policy)|(?:blueprint|policy).*frozen/i,
    );
    expect(
      (
        await conversation.harness.commit(
          (tx) => tx.scanConversations({ ownerTaskId: id }, 10),
          ctx,
        )
      ).items,
    ).toHaveLength(0);
  },
);
it("starts a queued WORK from its frozen policy after reopen, even when current config removed its template", async () => {
  const seen: string[] = [];
  const conversation = await setup((system) => {
    seen.push(system);
    return reply("QUEUED FROZEN RESULT");
  });
  await conversation.close();
  await conversation.open(false); // store an admitted task before its conversation exists
  const blueprint = conversation.agents.captureWorkBlueprint("worker");
  const id = await conversation.harness.commit(
    (tx) =>
      tx.createTask(
        queuedWorkTask,
        queuedInput(conversation.id, "worker", blueprint),
        {
          ownership: { kind: "conversation" },
          conversationId: conversation.id,
          background: true,
        },
      ),
    ctx,
  );
  await conversation.close();
  delete conversation.config.templates.worker;
  required(conversation.config.templates.kaeno).delegates = [];
  required(conversation.config.templates.kaeno).instructions = "LATER POLICY";
  await conversation.open();
  await conversation.harness.waitForTask(id, ctx);
  const record = required(await conversation.harness.getTask(id, ctx));
  expect(JSON.stringify(record.state)).toContain("QUEUED FROZEN RESULT");
  expect(
    seen.some((system) => system.includes("WORKER") && isWork(system)),
  ).toBe(true);
  const child = required(
    (
      await conversation.harness.commit(
        (tx) => tx.scanConversations({ ownerTaskId: id }, 1),
        ctx,
      )
    ).items[0],
  );
  const state = required(
    await conversation.harness.snapshot(AgentState, child.id, ctx),
  );
  expect(state).toMatchObject({ template: "worker", role: "work" });
  expect(state.sandbox?.images).toEqual({ execution: "execution-v1" });
  const saved = required(
    await conversation.harness.snapshot(AgentDoc, child.id, ctx),
  );
  expect(saved.instructions).toContain("WORKER");
  expect(saved.instructions).not.toContain("LATER POLICY");
  expect(saved.tools).toEqual([
    "read",
    "write",
    "edit",
    "bash",
    "message_parent",
  ]);
});
it("WORK starts an allowed child, replies to its message, and reports only after the child finished", async () => {
  const order: string[] = [];
  let childId = 0;
  const conversation = await setup(
    (system, last) => {
      const message = text(last);
      if (system.includes("COORDINATOR")) {
        if (last.role === "user" && message.startsWith("Child Work #")) {
          if (message.includes("waits for a reply")) {
            childId = Number(/#(\d+)/.exec(message)?.[1]);
            order.push("child-message");
            return call(
              "message_work",
              { id: childId, text: "Blue" },
              "answer",
            );
          }
          order.push("child-report");
          return reply(`WORK VERIFIED: ${message.split("\n\n").at(-1)}`);
        }
        if (last.role === "user") {
          return call(
            "start_work",
            { agent: "kaeno", title: "Denied", brief: "Not allowed" },
            "denied",
          );
        }
        if (last.role === "toolResult" && last.toolCallId === "denied") {
          expect(message).toContain("Available: leaf");
          return call(
            "start_work",
            { agent: "leaf", title: "Paint", brief: "Paint it" },
            "allowed",
          );
        }
        if (last.role === "toolResult" && last.toolCallId === "allowed") {
          expect(message).toContain("Started work #");
          order.push("interim");
          return reply("Waiting for the leaf.");
        }
        expect(message).toContain("Message delivered");
        return reply("Answered the leaf.");
      }
      if (system.includes("LEAF-PROFILE")) {
        // At the depth limit: no orchestration offered, only its parent channel.
        expect(system).not.toContain("Child work templates");
        if (last.role === "user" && message.startsWith("Message from")) {
          expect(message).toContain("parent WORK");
          order.push("answer-received");
          return reply(`LEAF DONE: ${message.split("\n\n").at(-1)}`);
        }
        if (last.role === "user") {
          return call("message_parent", { text: "Which color?" });
        }
        return reply("unreachable after terminate");
      }
      if (last.role === "toolResult") {
        return reply("ACK");
      }
      if (message.startsWith("Work #")) {
        order.push("chat-report");
        return reply(message.split("\n\n").at(-1) ?? "");
      }
      return call("start_work", {
        agent: "worker",
        title: "Coordinate",
        brief: "Coordinate",
      });
    },
    undefined,
    {
      configure: (config) => {
        required(config.templates.worker).instructions = "COORDINATOR";
        required(config.templates.worker).delegates = ["leaf"];
        config.templates.leaf = {
          ...required(config.templates.kaeno),
          name: "leaf",
          description: "paints",
          instructions: "LEAF-PROFILE",
          delegates: ["kaeno"],
        };
      },
    },
  );
  await conversation.submit("first", "nested");
  await until(async () =>
    conversation.sent.some((value) => value.includes("WORK VERIFIED")),
  );
  expect(order).toEqual([
    "interim",
    "child-message",
    "answer-received",
    "child-report",
    "chat-report",
  ]);
  expect(conversation.sent.at(-1)).toBe("WORK VERIFIED: LEAF DONE: Blue");
  const [root] = await conversation.work.listWork(conversation.id);
  expect(root).toMatchObject({ agent: "worker", status: "completed" });
  const child = required(
    await conversation.harness.getTask(parseTaskId(childId), ctx),
  );
  expect(child.state.status).toBe("terminal");
  expect(readObject(child.input)).toMatchObject({ agent: "leaf", depth: 2 });
  expect(k8s.runningPods()).toEqual([]);
});
it("CHAT relays a WORK message to the user, inspects it, and forwards the reply with message_work", async () => {
  let workId = 0;
  let inspected = "";
  const conversation = await setup((system, last) => {
    const message = text(last);
    if (isWork(system)) {
      if (message.startsWith("Message from your CHAT")) {
        return reply(`Used ${message.split("\n\n").at(-1)}`);
      }
      return call("message_parent", { text: "Which file?" });
    }
    if (last.role === "toolResult" && last.toolName === "inspect_work") {
      inspected = message;
      return reply("It waits for your answer.");
    }
    if (last.role === "toolResult") {
      return reply(last.toolName === "message_work" ? "Forwarded." : "ACK");
    }
    if (message.startsWith("Work #") && message.includes("waits for a reply")) {
      workId = Number(/#(\d+)/.exec(message)?.[1]);
      return reply(`Relay: ${message.split("\n\n").at(-1)}`);
    }
    if (message.startsWith("Work #")) {
      return reply(`DONE: ${message.split("\n\n").at(-1)}`);
    }
    if (message === "status?") {
      return call("inspect_work", { id: workId });
    }
    if (message.startsWith("answer:")) {
      return call("message_work", { id: workId, text: message.slice(8) });
    }
    return call("start_work", { agent: "kaeno", title: "Ask", brief: "Ask" });
  });
  await conversation.submit("first", "ask-start");
  await until(async () => conversation.sent.includes("Relay: Which file?"));
  expect(
    required((await conversation.work.listWork(conversation.id))[0]).status,
  ).toBe("awaiting-reply");
  await conversation.submit("status?", "ask-status");
  await conversation.waitReply("ask-status");
  expect(readObject(JSON.parse(inspected))).toMatchObject({
    id: workId,
    status: "awaiting-reply",
    children: [],
  });
  await conversation.submit("answer: a.txt", "ask-answer");
  await conversation.waitReply("ask-answer");
  await until(async () => conversation.sent.includes("DONE: Used a.txt"));
  expect(conversation.sent).toEqual([
    "ACK",
    "Relay: Which file?",
    "It waits for your answer.",
    "Forwarded.",
    "DONE: Used a.txt",
  ]);
});
it("cancelling a WORK cancels its running children first and removes every sandbox", async () => {
  let started = false;
  const conversation = await setup(
    async (system, last, options) => {
      if (system.includes("COORDINATOR")) {
        if (last.role === "user") {
          return call("start_work", {
            agent: "leaf",
            title: "Slow",
            brief: "Slow",
          });
        }
        return reply("Waiting.");
      }
      if (system.includes("LEAF-PROFILE")) {
        started = true;
        await delay(60000, undefined, { signal: options.signal });
        return reply("never");
      }
      if (last.role === "toolResult") {
        return reply("ACK");
      }
      return call("start_work", {
        agent: "worker",
        title: "Tree",
        brief: "Tree",
      });
    },
    undefined,
    {
      configure: (config) => {
        required(config.templates.worker).instructions = "COORDINATOR";
        required(config.templates.worker).delegates = ["leaf"];
        config.templates.leaf = {
          ...required(config.templates.kaeno),
          name: "leaf",
          description: "slow",
          instructions: "LEAF-PROFILE",
          delegates: [],
        };
      },
    },
  );
  await conversation.submit("first", "tree");
  await until(async () => started);
  expect(k8s.runningPods()).toHaveLength(2);
  const [root] = await conversation.work.listWork(conversation.id);
  await until(
    async () =>
      required((await conversation.work.listWork(conversation.id))[0])
        .status === "waiting-for-children",
  );
  await conversation.work.cancelWork(conversation.id, required(root).id);
  await until(
    async () =>
      required((await conversation.work.listWork(conversation.id))[0])
        .status === "aborted",
  );
  const children = await conversation.harness.commit(
    (tx) => tx.scanTasks({ kind: "kaeno.work" }, 10),
    ctx,
  );
  expect(children.items.map((task) => task.state.status)).toEqual([
    "terminal",
    "terminal",
  ]);
  expect(k8s.runningPods()).toEqual([]);
  expect(conversation.sent).toEqual(["ACK"]);
});
it("logs CHAT, WORK and child WORK with their work IDs without an API/pi observer", async () => {
  const records: Record<string, unknown>[] = [];
  vi.spyOn(console, "log").mockImplementation((line) => {
    if (typeof line === "string" && line.startsWith('{"type":"agent_trace"')) {
      records.push(readObject(JSON.parse(line)));
    }
  });
  const conversation = await setup(
    (system, last) => {
      if (system.includes("COORDINATOR")) {
        if (last.role === "user" && text(last).startsWith("Child Work #")) {
          return reply("WORK REPORT");
        }
        if (last.role === "user") {
          return fauxAssistantMessage(
            [
              fauxThinking("WORK REASONING"),
              fauxToolCall(
                "start_work",
                { agent: "leaf", title: "Leaf", brief: "Reason only" },
                { id: "leaf" },
              ),
            ],
            { stopReason: "toolUse" },
          );
        }
        return reply("Waiting.");
      }
      if (system.includes("LEAF-PROFILE")) {
        return fauxAssistantMessage([
          fauxThinking("LEAF REASONING"),
          fauxText("LEAF RESULT"),
        ]);
      }
      if (last.role === "toolResult") {
        return reply("ACK");
      }
      if (text(last).startsWith("Work #")) {
        return reply("DONE");
      }
      return call("start_work", {
        agent: "worker",
        title: "Trace",
        brief: "Background reasoning and delegation",
      });
    },
    undefined,
    {
      configure: (config) => {
        required(config.templates.worker).instructions = "COORDINATOR";
        required(config.templates.worker).delegates = ["leaf"];
        config.templates.leaf = {
          ...required(config.templates.kaeno),
          name: "leaf",
          description: "leaf",
          instructions: "LEAF-PROFILE",
          delegates: [],
        };
      },
    },
  );
  await conversation.submit("first", "request-trace");
  await until(async () => conversation.sent.includes("DONE"));
  const [job] = await conversation.work.listWork(conversation.id);
  const leaf = records.find((value) => value.content === "LEAF REASONING");
  expect(
    records.some(
      (value) =>
        value.role === "chat" &&
        value.event === "text" &&
        value.content === "ACK",
    ),
  ).toBe(true);
  expect(
    records.some(
      (value) =>
        value.role === "work" &&
        value.workId === required(job).id &&
        value.event === "thinking" &&
        value.content === "WORK REASONING" &&
        typeof value.pod === "string",
    ),
  ).toBe(true);
  expect(leaf).toMatchObject({ role: "work", agent: "leaf" });
  expect(required(leaf).workId).not.toBe(required(job).id);
  expect(
    records.some(
      (value) =>
        value.role === "work" &&
        value.event === "tool_start" &&
        value.tool === "start_work",
    ),
  ).toBe(true);
});
