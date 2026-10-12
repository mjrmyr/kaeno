import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
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
import { z } from "zod";
import { AgentFactory, AgentState } from "../../src/agents/index.ts";
import { parseConfig } from "../../src/config/index.ts";
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
  historicalWorkTask,
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
        sandbox: true,
        tools: ["bash"],
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
      capture: (agent) => agents.captureWorkBlueprint(agent),
      configure: (tx, id, right, workId) =>
        agents.configureWorkConversation(tx, id, right, workId),
      clean: (id) => agents.isWorkClean(id),
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
    agents.shutdown();
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
it("acknowledges work, answers a second request while WORK is reasoning, and reports later without any worker", async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const createPod = vi.spyOn(k8s, "createPod");
  const conversation = await setup(async (system, last, options) => {
    if (system.includes("Kaeno WORK")) {
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
  release();
  await until(async () => conversation.sent.length === 3);
  expect(conversation.sent[2]).toContain("Finished");
  expect(createPod).not.toHaveBeenCalled();
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
it("holds an instant result behind actual acknowledgement delivery and captures the originating route", async () => {
  const { promise: ackGate, resolve: ackRelease } =
    Promise.withResolvers<void>();
  const routes: number[] = [];
  const conversation = await setup(
    (system, last) => {
      if (system.includes("Kaeno WORK")) {
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
      if (system.includes("Kaeno WORK")) {
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
    if (system.includes("Kaeno WORK")) {
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
    if (system.includes("Kaeno WORK")) {
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
    if (system.includes("Kaeno WORK")) {
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
it("one request cannot launch two independent WORK coordinators", async () => {
  let launched = false;
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const conversation = await setup(async (system, last, options) => {
    if (system.includes("Kaeno WORK")) {
      launched = true;
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
            { agent: "kaeno", title: "Two", brief: "OTHER_BRIEF" },
            { id: "two" },
          ),
        ],
        { stopReason: "toolUse" },
      );
    }
    return reply("ACK");
  });
  try {
    const turn = await conversation.submit("MULTI", "one-work-per-request");
    await conversation.harness.waitForTask(turn, ctx);
    await until(async () => launched);
    expect(await conversation.work.listWork(conversation.id)).toHaveLength(1);
  } finally {
    release();
  }
});
it("user cancel_work admits a durable cancellation command and aborts the owned WORK", async () => {
  let id = 0;
  const conversation = await setup(async (system, last, options) => {
    if (system.includes("Kaeno WORK")) {
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
    if (system.includes("Kaeno WORK")) {
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
    if (system.includes("Kaeno WORK")) {
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
it("offers only primary/direct templates, requires explicit selection, and keeps CHAT primary across two WORK roots", async () => {
  const systems: string[] = [];
  const pods = vi.spyOn(k8s, "createPod");
  const conversation = await setup(
    (system, last) => {
      if (system.includes("Kaeno WORK")) {
        systems.push(system);
        return reply("RESULT");
      }
      if (last.role === "toolResult") {
        return reply(text(last));
      }
      if (text(last).startsWith("Work #")) {
        return reply("DONE");
      }
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
  const schema = z
    .object({
      properties: z.object({
        agent: z.object({
          type: z.string(),
          enum: z.array(z.string()),
          description: z.string(),
        }),
      }),
      required: z.array(z.string()),
    })
    .parse(conversation.work.tools[0]?.parameters);
  expect(schema.properties.agent.type).toBe("string");
  expect(schema.properties.agent.enum).toEqual(["kaeno", "worker"]);
  expect(schema.properties.agent.description).toContain("worker: execution");
  expect(schema.required).toContain("agent");
  for (const agent of ["missing", "hidden", "arbitrary", "kaeno", "worker"]) {
    await conversation.submit(agent, `select-${agent}`);
    await conversation.waitReply(`select-${agent}`);
  }
  await until(
    async () =>
      (await conversation.work.listWork(conversation.id)).filter(
        (job) => job.status === "completed",
      ).length === 2,
  );
  const jobs = await conversation.work.listWork(conversation.id);
  expect(jobs).toHaveLength(2);
  const roots = await Promise.all(
    jobs.map(async (job) =>
      storedBlueprint((await conversation.harness.getTask(job.id, ctx))?.input),
    ),
  );
  expect(roots.map((value) => value.agent)).toEqual(["kaeno", "worker"]);
  expect(
    systems.some(
      (state) => state.includes("WORKER") && state.includes("Kaeno WORK"),
    ),
  ).toBe(true);
  expect(
    (await conversation.harness.snapshot(AgentState, conversation.id, ctx))
      ?.template,
  ).toBe("kaeno");
  expect(pods).not.toHaveBeenCalled();
});
it.each([true, false])(
  "replays old durable missing-agent execute intent safely (already admitted=%s)",
  async (admitted) => {
    let interrupted = false;
    let replayResult = "";
    const conversation = await setup(
      (system, last) => {
        if (system.includes("Kaeno WORK")) {
          return reply("FROZEN RESULT");
        }
        if (last.role === "toolResult") {
          replayResult = text(last);
          return reply("ACK");
        }
        if (text(last).startsWith("Work #")) {
          return reply("DONE");
        }
        return call("start_work", { title: "Old call", brief: "Old brief" });
      },
      undefined,
      {
        install: (work, opening) => {
          if (opening !== 1) {
            return;
          }
          const start = required(work.tools[0]);
          // Simulate the old schema/implementation, not a newly invalid model call. SDK stores execute intent.
          start.parameters = Type.Object({
            title: Type.String(),
            brief: Type.String(),
          });
          const execute = start.execute;
          start.execute = async (args, api, context) => {
            if (admitted) {
              await execute(
                { ...readObject(args), agent: "worker" },
                api,
                context,
              );
            }
            interrupted = true;
            await delay(60000, undefined, { signal: context.abortSignal });
            throw new Error("unreachable");
          };
        },
      },
    );
    await conversation.submit("old", "old-request");
    await until(async () => interrupted);
    await conversation.close();
    delete conversation.config.templates.worker;
    required(conversation.config.templates.kaeno).delegates = [];
    await conversation.open();
    await conversation.waitReply("old-request");
    if (admitted) {
      expect(replayResult).toContain("template worker");
      expect(await conversation.work.listWork(conversation.id)).toHaveLength(1);
      expect(
        storedBlueprint(
          (
            await conversation.harness.getTask(
              required((await conversation.work.listWork(conversation.id))[0])
                .id,
              ctx,
            )
          )?.input,
        ).agent,
      ).toBe("worker");
    } else {
      expect(replayResult).toContain("requires an explicit eligible agent");
      expect(await conversation.work.listWork(conversation.id)).toHaveLength(0);
    }
  },
);
it("receipt-first admission returns frozen choice before capture and conflicts on changed template or identity", async () => {
  let result = "";
  let phase = 0;
  const conversation = await setup(
    (system, last) => {
      if (system.includes("Kaeno WORK")) {
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
        const start = required(work.tools[0]);
        const execute = start.execute;
        start.execute = async (args, api, context) => {
          const prior = await execute(args, api, context);
          expect(readObject(prior.details).agent).toBe("worker");
          // Receipt wins even if current config no longer offers or can capture this template.
          required(conversation.config.templates.kaeno).delegates = [];
          delete conversation.config.templates.worker;
          expect((await execute(args, api, context)).details).toEqual(
            prior.details,
          );
          await expect(
            execute({ ...readObject(args), agent: "kaeno" }, api, context),
          ).rejects.toThrow(/different WORK template/);
          await expect(
            execute({ ...readObject(args), brief: "changed" }, api, context),
          ).rejects.toThrow(/One WORK/);
          phase++;
          return prior;
        };
      },
    },
  );
  await conversation.submit("first", "receipt-first");
  await conversation.waitReply("receipt-first");
  expect(phase).toBe(1);
  expect(result).toContain("template worker");
});
it.each([
  undefined,
  { agent: "missing", templates: {} },
  { agent: "worker", templates: { worker: {} } },
])(
  "fails old queued WORK with missing/bad blueprint visibly instead of choosing current primary (%j)",
  async (blueprint) => {
    const conversation = await setup(() => reply("should not run"));
    const task = historicalWorkTask;
    const id = await conversation.harness.commit(
      (tx) =>
        tx.createTask(
          task,
          {
            title: "broken",
            brief: "broken",
            blueprint,
            origin: {
              conversationId: conversation.id,
              requestId: "broken",
              epoch: 0,
            },
          },
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
it("selected sandboxed WORK has no execution surface and delegates only frozen targets to leaf WORKERs", async () => {
  let verified = false;
  const pods = vi.spyOn(k8s, "createPod");
  const conversation = await setup(
    (system, last) => {
      if (system.includes("Kaeno WORK")) {
        if (last.role === "user") {
          // Remove/change current targets before delegation: only the admitted blueprint is authoritative.
          delete conversation.config.templates.leaf;
          required(conversation.config.templates.worker).delegates = ["kaeno"];
          return call("bash", { command: "should-not-run" });
        }
        if (last.role === "toolResult" && last.toolName === "bash") {
          expect(text(last)).toContain("not available");
          return call(
            "delegate",
            { agent: "kaeno", task: "Not allowlisted" },
            "denied",
          );
        }
        if (last.role === "toolResult" && last.toolCallId === "denied") {
          expect(text(last)).toContain("Available: leaf");
          return call(
            "delegate",
            { agent: "leaf", task: "Allowed" },
            "allowed",
          );
        }
        expect(text(last)).toContain("LEAF VERIFIED");
        verified = true;
        return reply("WORK VERIFIED");
      }
      if (system.includes("LEAF-PROFILE")) {
        if (last.role === "user") {
          return call("delegate", { agent: "kaeno", task: "No grandchildren" });
        }
        expect(text(last)).toContain("not available");
        return reply("LEAF VERIFIED");
      }
      if (last.role === "toolResult") {
        return reply("ACK");
      }
      if (text(last).startsWith("Work #")) {
        return reply("DONE");
      }
      return call("start_work", {
        agent: "worker",
        title: "Engineering",
        brief: "Coordinate",
      });
    },
    undefined,
    {
      configure: (config) => {
        required(config.templates.worker).delegates = ["leaf"];
        config.templates.leaf = {
          ...required(config.templates.kaeno),
          name: "leaf",
          instructions: "LEAF-PROFILE",
          delegates: ["kaeno"],
        };
      },
    },
  );
  await conversation.submit("first", "frozen-delegation");
  await conversation.waitReply("frozen-delegation");
  await until(async () => verified);
  expect(pods).not.toHaveBeenCalled();
  const job = required((await conversation.work.listWork(conversation.id))[0]);
  const child = required(
    (
      await conversation.harness.commit(
        (tx) => tx.scanConversations({ ownerTaskId: job.id }, 1),
        ctx,
      )
    ).items[0],
  );
  const state = required(
    await conversation.harness.snapshot(AgentState, child.id, ctx),
  );
  expect(state.template).toBe("worker");
  expect(state.role).toBe("work");
  expect(state.sandbox).toBeUndefined();
  expect(
    required(required(state.blueprint).templates.worker).template.tools,
  ).toEqual(["bash"]);
  expect(
    required(required(state.blueprint).templates.worker).template.delegates,
  ).toEqual(["leaf"]);
});
it("starts a queued valid frozen selection even after current config removes its root", async () => {
  const seen: string[] = [];
  const conversation = await setup((system) => {
    seen.push(system);
    return reply("QUEUED FROZEN RESULT");
  });
  const blueprint = conversation.agents.captureWorkBlueprint("worker");
  const task = historicalWorkTask;
  const id = await conversation.harness.commit(async (tx) => {
    const id = await tx.createTask(
      task,
      {
        title: "queued",
        brief: "queued frozen work",
        blueprint,
        origin: {
          conversationId: conversation.id,
          requestId: "queued",
          epoch: 0,
        },
      },
      {
        ownership: { kind: "conversation" },
        conversationId: conversation.id,
        background: true,
      },
    );
    delete conversation.config.templates.worker;
    required(conversation.config.templates.kaeno).delegates = [];
    return id;
  }, ctx);
  await conversation.harness.waitForTask(id, ctx);
  const record = required(await conversation.harness.getTask(id, ctx));
  expect(record.state.status).toBe("terminal");
  expect(JSON.stringify(record.state)).toContain("QUEUED FROZEN RESULT");
  expect(
    seen.some(
      (system) => system.includes("WORKER") && system.includes("Kaeno WORK"),
    ),
  ).toBe(true);
  const child = required(
    (
      await conversation.harness.commit(
        (tx) => tx.scanConversations({ ownerTaskId: id }, 1),
        ctx,
      )
    ).items[0],
  );
  expect(
    (await conversation.harness.snapshot(AgentState, child.id, ctx))?.template,
  ).toBe("worker");
});
it("creates queued WORK and WORKER after SQLite reopen using saved policy, not later policy code", async () => {
  const conversation = await setup(
    (system, last) => {
      if (system.includes("Kaeno WORK")) {
        return last.role === "user"
          ? call("delegate", {
              agent: "worker",
              task: "Reason about the supplied text",
            })
          : reply("SAVED WORK REPORT");
      }
      if (system.includes("WORKER")) {
        return reply("SAVED WORKER REPORT");
      }
      return reply("ACK");
    },
    undefined,
    {
      configure: (config) => {
        required(config.templates.worker).sandbox = false;
        required(config.templates.worker).tools = [];
      },
    },
  );
  await conversation.close();
  await conversation.open(false); // Store an admitted task before its child exists.
  const blueprint = conversation.agents.captureWorkBlueprint("kaeno");
  const task = historicalWorkTask;
  const id = await conversation.harness.commit(
    (tx) =>
      tx.createTask(
        task,
        {
          title: "Queued",
          brief: "Use saved policy",
          blueprint,
          origin: {
            conversationId: conversation.id,
            requestId: "queued-policy",
            epoch: 0,
          },
        },
        {
          ownership: { kind: "conversation" },
          conversationId: conversation.id,
          background: true,
        },
      ),
    ctx,
  );
  expect(
    (
      await conversation.harness.commit(
        (tx) => tx.scanConversations({ ownerTaskId: id }, 1),
        ctx,
      )
    ).items,
  ).toHaveLength(0);
  await conversation.close();
  required(conversation.config.templates.kaeno).instructions = "LATER POLICY";
  required(conversation.config.templates.kaeno).delegates = [];
  delete conversation.config.templates.worker;
  await conversation.open();
  await conversation.harness.waitForTask(id, ctx);
  expect(
    JSON.stringify(required(await conversation.harness.getTask(id, ctx)).state),
  ).toContain("SAVED WORK REPORT");
  const workChild = required(
    (
      await conversation.harness.commit(
        (tx) => tx.scanConversations({ ownerTaskId: id }, 1),
        ctx,
      )
    ).items[0],
  );
  const rootConfig = required(
    await conversation.harness.snapshot(AgentDoc, workChild.id, ctx),
  );
  expect(rootConfig.instructions).toBe(
    required(blueprint.templates.kaeno).settings.work.instructions,
  );
  expect(rootConfig.tools).toEqual(
    required(blueprint.templates.kaeno).settings.work.tools,
  );
  const delegates = (
    await conversation.harness.commit(
      (tx) =>
        tx.scanTasks({ conversationId: workChild.id, kind: "pi.tool" }, 10),
      ctx,
    )
  ).items;
  const workers = (
    await Promise.all(
      delegates.map((taskValue) =>
        conversation.harness.commit(
          (tx) => tx.scanConversations({ ownerTaskId: taskValue.id }, 1),
          ctx,
        ),
      ),
    )
  ).flatMap((conversation) => conversation.items);
  expect(workers).toHaveLength(1);
  const workerConfig = required(
    await conversation.harness.snapshot(AgentDoc, required(workers[0]).id, ctx),
  );
  expect(workerConfig.instructions).toBe(
    required(blueprint.templates.worker).settings.worker.instructions,
  );
  expect(workerConfig.tools).toEqual([]);
});
it("logs CHAT, background WORK and leaf WORKER without an API/pi observer", async () => {
  const records: Record<string, unknown>[] = [];
  vi.spyOn(console, "log").mockImplementation((line) => {
    if (typeof line === "string" && line.startsWith('{"type":"agent_trace"')) {
      records.push(readObject(JSON.parse(line)));
    }
  });
  const pods = vi.spyOn(k8s, "createPod");
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const conversation = await setup(async (system, last, options) => {
    if (system.includes("Kaeno WORK")) {
      if (last.role === "user") {
        await Promise.race([
          gate,
          delay(60000, undefined, { signal: options.signal }),
        ]);
        return fauxAssistantMessage(
          [
            fauxThinking("WORK REASONING"),
            fauxToolCall(
              "delegate",
              { agent: "worker", task: "Reason only" },
              { id: "leaf" },
            ),
          ],
          { stopReason: "toolUse" },
        );
      }
      return reply("WORK REPORT");
    }
    if (system.includes("WORKER")) {
      return fauxAssistantMessage([
        fauxThinking("WORKER REASONING"),
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
      agent: "kaeno",
      title: "Trace",
      brief: "Background reasoning and delegation",
    });
  });
  required(conversation.config.templates.worker).sandbox = false;
  required(conversation.config.templates.worker).tools = [];
  await conversation.submit("first", "request-trace");
  await conversation.waitReply("request-trace");
  expect(
    records.some(
      (value) =>
        value.role === "chat" &&
        value.event === "text" &&
        value.content === "ACK",
    ),
  ).toBe(true);
  release();
  await until(async () => conversation.sent.includes("DONE"));
  const job = required((await conversation.work.listWork(conversation.id))[0]);
  expect(
    records.some(
      (value) =>
        value.role === "work" &&
        value.workId === job.id &&
        value.event === "thinking" &&
        value.content === "WORK REASONING",
    ),
  ).toBe(true);
  expect(
    records.some(
      (value) =>
        value.role === "worker" &&
        value.workId === job.id &&
        value.event === "thinking" &&
        value.content === "WORKER REASONING",
    ),
  ).toBe(true);
  expect(
    records.some(
      (value) =>
        value.role === "work" &&
        value.event === "tool_start" &&
        value.tool === "delegate",
    ),
  ).toBe(true);
  expect(
    records.some(
      (value) =>
        value.role === "work" &&
        value.event === "tool_end" &&
        value.content === "LEAF RESULT",
    ),
  ).toBe(true);
  expect(pods).not.toHaveBeenCalled();
});
