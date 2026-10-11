import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createAgents, AgentState } from "../src/agents.ts";
import { createWork, WorkIndex } from "../src/work.ts";
import { defineTurn, defineControl, admitControl, admitTurn, TurnLedger, resetEpoch } from "../src/turns.ts";
import { thread, refreshThreads } from "../src/threads.ts";
import { parseConfig } from "../src/config.ts";
import { createApi } from "../src/api.ts";
import * as k8s from "../src/k8s.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(check: () => Promise<boolean>, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await delay(10)) if (await check()) return;
  throw new Error("timed out");
}
const reply = (text: string) => fauxAssistantMessage([fauxText(text)]);
const call = (name: string, args: any, id = name) => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
const text = (message: any) => typeof message.content === "string" ? message.content : message.content.map((c: any) => c.text ?? "").join("");

async function setup(route: (system: string, last: any, options: any) => Promise<any> | any, send?: (notify: any, text: string) => Promise<void>, options: { configure?: (config: ReturnType<typeof parseConfig>) => void; install?: (work: ReturnType<typeof createWork>, opening: number) => void } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kaeno-work-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config = parseConfig({ agent: "kaeno", templates: {
    kaeno: { description: "chat", model: "anthropic/test", instructions: "VERSION-ONE", delegates: ["worker"] },
    worker: { description: "execution", model: "openai/test", instructions: "WORKER", sandbox: true, tools: ["bash"] },
  } });
  options.configure?.(config);
  // Faux models are selected at the test boundary; production provider/model preferences stay unchanged.
  for (const t of Object.values(config.templates)) t.model = { provider: "faux" as any, modelId: "faux-1" };
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 150 }, () => async (request: any, options: any) => {
    const system = JSON.stringify(request.messages.filter((m: any) => m.role === "system"));
    const last = request.messages.findLast((m: any) => m.role !== "system");
    return route(system, last, options);
  }));
  const sent: string[] = [];
  const Turn = defineTurn(() => ({ typing: async () => {}, send: async (notify, message) => {
    if (send) await send(notify, message); sent.push(message);
  } }));
  let harness!: Harness, agents!: ReturnType<typeof createAgents>, work!: ReturnType<typeof createWork>;
  const Control = defineControl(() => harness, (id, workId) => work.cancel(id, workId));
  let opening = 0;
  const open = async () => {
    work = createWork({ harness: () => harness, Turn, Control, config, capture: agent => agents.captureWork(agent), configure: (tx, id, b, workId) => agents.configureWork(tx, id, b, workId), clean: id => agents.workClean(id) });
    options.install?.(work, ++opening);
    agents = createAgents({ config, harness: () => harness, work, skills: { bind: () => [] }, images: { execution: "execution-v1" }, skillCacheClaim: "cache-v1" });
    const registry = createRegistry(); registry.install(CodingTools); registry.install(agents.Kaeno); registry.install(work.extension);
    registry.install(defineExtension({ name: "channels", tasks: [Turn, Control] }));
    harness = await Harness.open(await openNodeSqliteStorage(join(dir, "state.sqlite")), { models, registry, env: agents.env,
      settings: { toolExecution: "parallel", followUpMode: "one-at-a-time" } }, ctx);
    harness.resume();
  };
  const close = async () => { agents.shutdown(); await harness.close(ctx); };
  await open(); cleanup.push(close);
  const deps = { harness: () => harness, agent: { template: "kaeno", role: "chat" as const,
    change: () => agents.agentChange(config.templates.kaeno!), skills: () => [] } };
  const id = await thread(deps, "telegram:111");
  const submit = (content: string, requestId: string, notify = { telegram: 111 }) =>
    harness.commit(tx => admitTurn(tx, Turn, { conversationId: id, content, requestId, notify }), ctx);
  const waitReply = (requestId: string) => until(async () => (await harness.snapshot(TurnLedger, id, ctx))?.receipts[requestId]?.delivery === "delivered");
  return { dir, config, Turn, Control, sent, id, deps, submit, waitReply, open, close, get harness() { return harness; }, get agents() { return agents; }, get work() { return work; } };
}

it("acknowledges work, answers a second request while WORK is reasoning, and reports later without any worker", async () => {
  let release!: () => void; const gate = new Promise<void>(ok => release = ok);
  const createPod = vi.spyOn(k8s, "createPod");
  const s = await setup(async (system, last, options) => {
    if (system.includes("Kaeno WORK")) {
      await Promise.race([gate, delay(60_000, undefined, { signal: options.signal })]); return reply("Verified reasoning result");
    }
    if (last.role === "toolResult") return reply("Plan: analyze the supplied text. Work started.");
    if (text(last).startsWith("Work #")) return reply("Finished: verified reasoning result.");
    if (text(last) === "first") return call("start_work", { agent: "kaeno", title: "Analyze", brief: "Reason about supplied text" });
    return reply("Second request answered immediately");
  });
  await s.submit("first", "request-first"); await s.waitReply("request-first");
  expect(s.sent).toEqual(["Plan: analyze the supplied text. Work started."]);
  expect((await s.work.list(s.id))[0]!.status).not.toBe("completed");
  await s.submit("second", "request-second"); await s.waitReply("request-second");
  expect(s.sent[1]).toBe("Second request answered immediately");
  release(); await until(async () => s.sent.length === 3);
  expect(s.sent[2]).toContain("Finished"); expect(createPod).not.toHaveBeenCalled();
  expect((await s.work.list(s.id))[0]!.status).toBe("completed");
  expect(Object.values((await s.harness.snapshot(WorkIndex, s.id, ctx))!.launches)).toHaveLength(1);
  // Re-admission reuses both turn and work; neither reruns.
  await s.submit("first", "request-first"); await delay(50);
  expect(s.sent).toHaveLength(3);
});

it("holds an instant result behind actual acknowledgement delivery and captures the originating route", async () => {
  let ackRelease!: () => void; const ackGate = new Promise<void>(ok => ackRelease = ok);
  const routes: number[] = [];
  const s = await setup((system, last) => {
    if (system.includes("Kaeno WORK")) return reply("Instant result");
    if (last.role === "toolResult") return reply("ACK");
    if (text(last).startsWith("Work #")) return reply("DONE");
    return call("start_work", { agent: "kaeno", title: "Instant", brief: "Easy reasoning" });
  }, async (notify, message) => { routes.push(notify.telegram); if (message === "ACK") await ackGate; });
  await s.submit("first", "request-instant", { telegram: 321 });
  await until(async () => (await s.work.list(s.id))[0]?.status === "completed");
  expect(s.sent).toEqual([]);
  expect(routes).toEqual([321]);
  ackRelease(); await until(async () => s.sent.length === 2);
  expect(s.sent).toEqual(["ACK", "DONE"]); expect(routes).toEqual([321, 321]);
});

it("resumes background reasoning after SQLite reopen, preserves its blueprint, and refreshes idle CHAT", async () => {
  let paused = true, entered = false;
  const seen: string[] = [];
  const s = await setup(async (system, last, options) => {
    if (system.includes("Kaeno WORK")) {
      entered = true; seen.push(system);
      if (paused) await delay(60_000, undefined, { signal: options.signal });
      return reply("Recovered outcome");
    }
    if (last.role === "toolResult") return reply("ACK");
    if (text(last).startsWith("Work #")) return reply("RECOVERED");
    return call("start_work", { agent: "worker", title: "Durable", brief: "Long reasoning" });
  }, undefined, { configure: config => { config.templates.worker!.instructions = "VERSION-ONE"; } });
  await s.submit("first", "request-restart"); await s.waitReply("request-restart"); await until(async () => entered);
  s.config.templates.kaeno!.instructions = "CHAT-UPDATED";
  s.config.templates.worker!.instructions = "VERSION-TWO";
  s.config.templates.kaeno!.delegates = [];
  await refreshThreads(s.deps);
  expect((await s.harness.snapshot(AgentState, s.id, ctx))?.role).toBe("chat");
  expect((await s.harness.snapshot(AgentState, s.id, ctx))?.template).toBe("kaeno");
  await s.close(); paused = false; await s.open();
  await until(async () => s.sent.includes("RECOVERED"));
  expect(seen.every(system => system.includes("VERSION-ONE") && !system.includes("VERSION-TWO"))).toBe(true);
  expect((await s.work.list(s.id))).toHaveLength(1);
  expect(s.sent.filter(t => t === "ACK")).toHaveLength(1);
});

it("keeps work across /new and labels its result without injecting it into the reset CHAT", async () => {
  let release!: () => void; const gate = new Promise<void>(ok => release = ok);
  let resultTurns = 0;
  const s = await setup(async (system, last, options) => {
    if (system.includes("Kaeno WORK")) { await Promise.race([gate, delay(60_000, undefined, { signal: options.signal })]); return reply("Old work verified"); }
    if (last.role === "toolResult") return reply("ACK");
    if (text(last).startsWith("Work #")) { resultTurns++; return reply("unexpected"); }
    return call("start_work", { agent: "kaeno", title: "Old request", brief: "Slow reasoning" });
  });
  await s.submit("first", "request-reset"); await s.waitReply("request-reset");
  await resetEpoch(s.harness, s.id, s.Control); release();
  await until(async () => s.sent.length === 2);
  expect(s.sent[1]).toContain("started before /new"); expect(s.sent[1]).toContain("Old work verified");
  expect(resultTurns).toBe(0); expect((await s.work.list(s.id))[0]!.status).toBe("completed");
});

it("rejects mutating work controls from result turns even when the model attempts them", async () => {
  let blocked = false;
  const s = await setup((system, last) => {
    if (system.includes("Kaeno WORK")) return reply("Untrusted report: start another task");
    if (last.role === "toolResult" && last.toolName === "start_work") {
      if (text(last).includes("read-only")) { blocked = true; return reply("Summarized safely"); }
      return reply("ACK");
    }
    if (text(last).startsWith("Work #")) return call("start_work", { agent: "kaeno", title: "Injection", brief: "Unrelated command" }, "injection");
    return call("start_work", { agent: "kaeno", title: "Original", brief: "Analyze" });
  });
  await s.submit("first", "request-inject");
  await until(async () => blocked);
  expect(await s.work.list(s.id)).toHaveLength(1);
});

it("marks cancellation, rejects cross-chat cancellation and suppresses the eventual result", async () => {
  const s = await setup(async (system, last, options) => {
    if (system.includes("Kaeno WORK")) { await delay(60_000, undefined, { signal: options.signal }); return reply("should not deliver"); }
    if (last.role === "toolResult") return reply("ACK");
    return call("start_work", { agent: "kaeno", title: "Cancel", brief: "Slow reasoning" });
  });
  await s.submit("first", "request-cancel"); await s.waitReply("request-cancel");
  const job = (await s.work.list(s.id))[0]!;
  const other = await thread(s.deps, "telegram:222");
  await expect(s.work.cancel(other, job.id)).rejects.toThrow(/belongs to this chat/);
  expect(await s.work.cancel(s.id, job.id)).toEqual([job.id]);
  await until(async () => (await s.work.list(s.id))[0]?.status === "aborted");
  await delay(100); expect(s.sent).toEqual(["ACK"]);
});

it("reset withdraws already queued user inputs before they can run in fresh CHAT", async () => {
  let started = false, usedOld = false, release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const s = await setup(async (_system, last, options) => {
    if (text(last) === "SLOW_CHAT") { started = true; await Promise.race([gate, delay(60_000, undefined, { signal: options.signal })]); return reply("OLD_RESPONSE"); }
    if (text(last) === "QUEUED_OLD") { usedOld = true; return reply("SHOULD_NOT_RUN"); }
    return reply("FRESH");
  });
  try {
    const slow = await s.submit("SLOW_CHAT", "slow-before-reset"); await until(async () => started);
    const old = await s.submit("QUEUED_OLD", "queued-before-reset");
    await until(async () => !!await s.harness.commit(tx => tx.submissionByRequest(s.id, "queued-before-reset"), ctx));
    await resetEpoch(s.harness, s.id, s.Control); release();
    await s.harness.waitForTask(slow, ctx); await s.harness.waitForTask(old, ctx);
    const next = await s.submit("NEW_CONTEXT", "after-reset"); await s.harness.waitForTask(next, ctx);
    expect(usedOld).toBe(false); expect(s.sent).toEqual(["FRESH"]);
  } finally { release(); }
});

it("stop fences pre-submission Turns and prevents a late WORK launch", async () => {
  const s = await setup(() => call("start_work", { agent: "kaeno", title: "Late", brief: "SHOULD_NOT_START" }));
  const ids = await s.harness.commit(async tx => {
    const turn = await admitTurn(tx, s.Turn, { conversationId: s.id, content: "PLAN", requestId: "stop-before-submit" });
    const stop = await admitControl(tx, s.Control, s.id, "stop"); return [turn, stop];
  }, ctx);
  await Promise.all(ids.map(id => s.harness.waitForTask(id, ctx)));
  expect(await s.work.list(s.id)).toEqual([]); expect(s.sent).toEqual([]);
  expect((await s.harness.snapshot(TurnLedger, s.id, ctx))!.receipts["stop-before-submit"]!.delivery).toBe("cancelled");
});

it("retains a send claimed before reset; pending sends are the cancellation cutoff", async () => {
  let claimed = false, release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const s = await setup(() => reply("ACK"), async () => { claimed = true; await gate; });
  try {
    const turn = await s.submit("ordinary", "claimed-before-reset"); await until(async () => claimed);
    expect((await s.harness.snapshot(TurnLedger, s.id, ctx))!.receipts["claimed-before-reset"]!.delivery).toBe("dispatching");
    await resetEpoch(s.harness, s.id, s.Control); release(); await s.harness.waitForTask(turn, ctx);
    expect((await s.harness.snapshot(TurnLedger, s.id, ctx))!.receipts["claimed-before-reset"]!.delivery).toBe("delivered");
  } finally { release(); }
});

it("one request cannot launch two independent WORK coordinators", async () => {
  let release!: () => void, launched = false; const gate = new Promise<void>(r => { release = r; });
  const s = await setup(async (system, last, options) => {
    if (system.includes("Kaeno WORK")) { launched = true; await Promise.race([gate, delay(60_000, undefined, { signal: options.signal })]); return reply("REPORT"); }
    if (text(last) === "MULTI") return fauxAssistantMessage([
      fauxToolCall("start_work", { agent: "kaeno", title: "One", brief: "WORK_BRIEF" }, { id: "one" }),
      fauxToolCall("start_work", { agent: "kaeno", title: "Two", brief: "OTHER_BRIEF" }, { id: "two" }),
    ], { stopReason: "toolUse" });
    return reply("ACK");
  });
  try {
    const turn = await s.submit("MULTI", "one-work-per-request"); await s.harness.waitForTask(turn, ctx); await until(async () => launched);
    expect(await s.work.list(s.id)).toHaveLength(1);
  } finally { release(); }
});

it("user cancel_work admits a durable cancellation command and aborts the owned WORK", async () => {
  let id = 0;
  const s = await setup(async (system, last, options) => {
    if (system.includes("Kaeno WORK")) { await delay(60_000, undefined, { signal: options.signal }); return reply("UNSENT"); }
    if (last.role === "toolResult") return reply("ACK");
    if (text(last) === "cancel") return call("cancel_work", { id });
    return call("start_work", { agent: "kaeno", title: "Cancelable", brief: "Long reasoning" });
  });
  await s.submit("start", "start-cancelable"); await s.waitReply("start-cancelable");
  id = (await s.work.list(s.id))[0]!.id;
  await s.submit("cancel", "cancel-owned-work"); await s.waitReply("cancel-owned-work");
  await until(async () => (await s.work.list(s.id))[0]!.status === "aborted");
  const controls = await s.harness.commit(tx => tx.scanTasks({ conversationId: s.id, kind: "kaeno.control" }, 10), ctx);
  expect(controls.items).toHaveLength(1); expect(controls.items[0]!.state.status).toBe("terminal");
  expect(s.sent).not.toContain("UNSENT");
});

it("disconnect disposes only the HTTP observation, not the admitted turn/work", async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const s = await setup(async (system, last, options) => {
    if (system.includes("Kaeno WORK")) return reply("RESULT");
    if (last.role === "toolResult") { await Promise.race([gate, delay(60_000, undefined, { signal: options.signal })]); return reply("ACK"); }
    if (text(last).startsWith("Work #")) return reply("DONE");
    return call("start_work", { agent: "kaeno", title: "API", brief: "task" });
  });
  const token = "x".repeat(32), server = createApi({ ...s.deps, Turn: s.Turn, Control: s.Control, work: s.work, token });
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  cleanup.push(() => new Promise<void>(ok => server.close(() => ok())));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1/threads/api:disconnect`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }, client = new AbortController();
  const waiting = vi.spyOn(s.harness, "waitForTask");
  try {
    await fetch(`${base}/turn`, { method: "POST", headers, signal: client.signal, body: JSON.stringify({ text: "first", requestId: "request-disconnect" }) });
    await until(async () => waiting.mock.calls.length > 0);
    const observation = waiting.mock.calls[0]![1]; client.abort();
    await until(async () => !!observation.abortSignal?.aborted);
    release(); let replies: any;
    await until(async () => { replies = await (await fetch(`${base}/replies`, { headers })).json(); return replies.replies.length === 2; });
    expect(replies.replies.map((r: any) => r.text)).toEqual(["ACK", "DONE"]);
  } finally { client.abort(); release(); }
});

it("serves short API replies and replayable later replies independently of the POST connection", async () => {
  const s = await setup((system, last) => {
    if (system.includes("Kaeno WORK")) return reply("Easy result");
    if (last.role === "toolResult") return reply("ACK");
    if (text(last).startsWith("Work #")) return reply("DONE");
    return call("start_work", { agent: "kaeno", title: "API", brief: "Easy task" });
  });
  const token = "x".repeat(32);
  const server = createApi({ ...s.deps, Turn: s.Turn, Control: s.Control, work: s.work, token });
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  cleanup.push(() => new Promise<void>(ok => server.close(() => ok())));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1/threads/api:one`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const reserved = await fetch(`${base}/turn`, { method: "POST", headers, body: JSON.stringify({ text: "collision", requestId: "work-report:123" }) });
  expect(reserved.status).toBe(400);
  const response = await fetch(`${base}/turn`, { method: "POST", headers, body: JSON.stringify({ text: "first", requestId: "request-http" }) });
  expect(await response.text()).toContain('"type":"done","text":"ACK"');
  let replies: any;
  await until(async () => { replies = await (await fetch(`${base}/replies?after=0`, { headers })).json(); return replies.replies.length === 2; });
  expect(replies.replies.map((r: any) => r.text)).toEqual(["ACK", "DONE"]);
  const tail: any = await (await fetch(`${base}/replies?after=1`, { headers })).json();
  expect(tail.replies.map((r: any) => r.text)).toEqual(["DONE"]);
});

it("offers only primary/direct templates, requires explicit selection, and keeps CHAT primary across two WORK roots", async () => {
  const systems: string[] = [];
  const pods = vi.spyOn(k8s, "createPod");
  const s = await setup((system, last) => {
    if (system.includes("Kaeno WORK")) { systems.push(system); return reply("RESULT"); }
    if (last.role === "toolResult") return reply(text(last));
    if (text(last).startsWith("Work #")) return reply("DONE");
    const agent = text(last);
    return call("start_work", { ...(agent === "missing" ? {} : { agent }), title: agent, brief: "Reason only" });
  }, undefined, { configure: config => {
    config.templates.worker!.delegates = ["hidden"];
    config.templates.hidden = { ...config.templates.kaeno!, name: "hidden", description: "not direct", delegates: [] };
  } });
  const schema = s.work.tools[0]!.parameters as any;
  expect(schema.properties.agent.type).toBe("string");
  expect(schema.properties.agent.enum).toEqual(["kaeno", "worker"]);
  expect(schema.properties.agent.description).toContain("worker: execution");
  expect(schema.required).toContain("agent");
  for (const agent of ["missing", "hidden", "arbitrary", "kaeno", "worker"]) {
    await s.submit(agent, `select-${agent}`); await s.waitReply(`select-${agent}`);
  }
  await until(async () => (await s.work.list(s.id)).filter(j => j.status === "completed").length === 2);
  const jobs = await s.work.list(s.id);
  expect(jobs).toHaveLength(2);
  const roots = await Promise.all(jobs.map(async j => (await s.harness.getTask(j.id, ctx))!.input as any));
  expect(roots.map(r => r.blueprint.agent)).toEqual(["kaeno", "worker"]);
  expect(systems.some(s => s.includes("WORKER") && s.includes("Kaeno WORK"))).toBe(true);
  expect((await s.harness.snapshot(AgentState, s.id, ctx))?.template).toBe("kaeno");
  expect(pods).not.toHaveBeenCalled();
});

it.each([true, false])("replays old durable missing-agent execute intent safely (already admitted=%s)", async admitted => {
  let interrupted = false, replayResult = "";
  const s = await setup((system, last) => {
    if (system.includes("Kaeno WORK")) return reply("FROZEN RESULT");
    if (last.role === "toolResult") { replayResult = text(last); return reply("ACK"); }
    if (text(last).startsWith("Work #")) return reply("DONE");
    return call("start_work", { title: "Old call", brief: "Old brief" });
  }, undefined, { install: (work, opening) => {
    if (opening !== 1) return;
    const start = work.tools[0]!;
    // Simulate the old schema/implementation, not a newly invalid model call. SDK stores execute intent.
    start.parameters = Type.Object({ title: Type.String(), brief: Type.String() }) as any;
    const execute = start.execute;
    start.execute = async (args, api, context) => {
      if (admitted) await execute({ ...args, agent: "worker" } as any, api, context);
      interrupted = true;
      await delay(60_000, undefined, { signal: context.abortSignal });
      throw new Error("unreachable");
    };
  } });
  await s.submit("old", "old-request"); await until(async () => interrupted);
  await s.close();
  delete s.config.templates.worker; s.config.templates.kaeno!.delegates = [];
  await s.open(); await s.waitReply("old-request");
  if (admitted) {
    expect(replayResult).toContain("template worker");
    expect(await s.work.list(s.id)).toHaveLength(1);
    expect(((await s.harness.getTask((await s.work.list(s.id))[0]!.id, ctx))!.input as any).blueprint.agent).toBe("worker");
  } else {
    expect(replayResult).toContain("requires an explicit eligible agent");
    expect(await s.work.list(s.id)).toHaveLength(0);
  }
});

it("receipt-first admission returns frozen choice before capture and conflicts on changed template or identity", async () => {
  let result = "", phase = 0;
  const s = await setup((system, last) => {
    if (system.includes("Kaeno WORK")) return reply("RESULT");
    if (last.role === "toolResult") { result = text(last); return reply("ACK"); }
    if (text(last).startsWith("Work #")) return reply("DONE");
    return call("start_work", { agent: "worker", title: "Same", brief: "Same brief" });
  }, undefined, { install: (work, opening) => {
    if (opening !== 1) return;
    const start = work.tools[0]!, execute = start.execute;
    start.execute = async (args, api, context) => {
      const prior = await execute(args as any, api, context);
      expect((prior.details as any).agent).toBe("worker");
      // Receipt wins even if current config no longer offers or can capture this template.
      s.config.templates.kaeno!.delegates = [];
      delete s.config.templates.worker;
      expect((await execute(args as any, api, context)).details).toEqual(prior.details);
      await expect(execute({ ...args, agent: "kaeno" } as any, api, context)).rejects.toThrow(/different WORK template/);
      await expect(execute({ ...args, brief: "changed" } as any, api, context)).rejects.toThrow(/One WORK/);
      phase++; return prior;
    };
  } });
  await s.submit("first", "receipt-first"); await s.waitReply("receipt-first");
  expect(phase).toBe(1); expect(result).toContain("template worker");
});

it.each([undefined, { agent: "missing", templates: {} }, { agent: "worker", templates: { worker: {} } }])(
  "fails old queued WORK with missing/bad blueprint visibly instead of choosing current primary (%j)", async blueprint => {
    const s = await setup(() => reply("should not run"));
    const task = s.work.extension.tasks![0]!;
    const id = await s.harness.commit(tx => tx.createTask(task as any, { title: "broken", brief: "broken", blueprint,
      origin: { conversationId: s.id, requestId: "broken", epoch: 0 } } as any,
      { ownership: { kind: "conversation" }, conversationId: s.id, background: true }), ctx);
    await until(async () => (await s.harness.getTask(id, ctx))!.state.status === "terminal");
    const record = (await s.harness.getTask(id, ctx))!;
    expect(JSON.stringify(record.state)).toContain("no valid frozen blueprint root");
    expect((await s.harness.commit(tx => tx.scanConversations({ ownerTaskId: id }, 10), ctx)).items).toHaveLength(0);
  });

it("selected sandboxed WORK has no execution surface and delegates only frozen targets to leaf WORKERs", async () => {
  let verified = false;
  const pods = vi.spyOn(k8s, "createPod");
  const s = await setup((system, last) => {
    if (system.includes("Kaeno WORK")) {
      if (last.role === "user") {
        // Remove/change current targets before delegation: only the admitted blueprint is authoritative.
        delete s.config.templates.leaf;
        s.config.templates.worker!.delegates = ["kaeno"];
        return call("bash", { command: "should-not-run" });
      }
      if (last.toolName === "bash") {
        expect(text(last)).toContain("not available");
        return call("delegate", { agent: "kaeno", task: "Not allowlisted" }, "denied");
      }
      if (last.toolCallId === "denied") {
        expect(text(last)).toContain("Available: leaf");
        return call("delegate", { agent: "leaf", task: "Allowed" }, "allowed");
      }
      expect(text(last)).toContain("LEAF VERIFIED"); verified = true; return reply("WORK VERIFIED");
    }
    if (system.includes("LEAF-PROFILE")) {
      if (last.role === "user") return call("delegate", { agent: "kaeno", task: "No grandchildren" });
      expect(text(last)).toContain("not available"); return reply("LEAF VERIFIED");
    }
    if (last.role === "toolResult") return reply("ACK");
    if (text(last).startsWith("Work #")) return reply("DONE");
    return call("start_work", { agent: "worker", title: "Engineering", brief: "Coordinate" });
  }, undefined, { configure: config => {
    config.templates.worker!.delegates = ["leaf"];
    config.templates.leaf = { ...config.templates.kaeno!, name: "leaf", instructions: "LEAF-PROFILE", delegates: ["kaeno"] };
  } });
  await s.submit("first", "frozen-delegation"); await s.waitReply("frozen-delegation");
  await until(async () => verified);
  expect(pods).not.toHaveBeenCalled();
  const job = (await s.work.list(s.id))[0]!;
  const child = (await s.harness.commit(tx => tx.scanConversations({ ownerTaskId: job.id }, 1), ctx)).items[0]!;
  const state = (await s.harness.snapshot(AgentState, child.id, ctx))!;
  expect(state.template).toBe("worker"); expect(state.role).toBe("work"); expect(state.sandbox).toBeUndefined();
  expect(state.blueprint!.templates.worker!.template.tools).toEqual(["bash"]);
  expect(state.blueprint!.templates.worker!.template.delegates).toEqual(["leaf"]);
});

it("starts a queued valid frozen selection even after current config removes its root", async () => {
  const seen: string[] = [];
  const s = await setup((system) => { seen.push(system); return reply("QUEUED FROZEN RESULT"); });
  const blueprint = s.agents.captureWork("worker");
  const task = s.work.extension.tasks![0]!;
  const id = await s.harness.commit(async tx => {
    const id = await tx.createTask(task as any, { title: "queued", brief: "queued frozen work", blueprint,
      origin: { conversationId: s.id, requestId: "queued", epoch: 0 } },
      { ownership: { kind: "conversation" }, conversationId: s.id, background: true });
    delete s.config.templates.worker; s.config.templates.kaeno!.delegates = [];
    return id;
  }, ctx);
  await s.harness.waitForTask(id, ctx);
  const record = (await s.harness.getTask(id, ctx))!;
  expect(record.state.status).toBe("terminal");
  expect(JSON.stringify(record.state)).toContain("QUEUED FROZEN RESULT");
  expect(seen.some(system => system.includes("WORKER") && system.includes("Kaeno WORK"))).toBe(true);
  const child = (await s.harness.commit(tx => tx.scanConversations({ ownerTaskId: id }, 1), ctx)).items[0]!;
  expect((await s.harness.snapshot(AgentState, child.id, ctx))?.template).toBe("worker");
});

it("logs CHAT, background WORK and leaf WORKER without an API/pi observer", async () => {
  const records: any[] = [];
  vi.spyOn(console, "log").mockImplementation(line => {
    if (typeof line === "string" && line.startsWith('{"type":"agent_trace"')) records.push(JSON.parse(line));
  });
  const pods = vi.spyOn(k8s, "createPod");
  let release!: () => void;
  const gate = new Promise<void>(ok => { release = ok; });
  const s = await setup(async (system, last, options) => {
    if (system.includes("Kaeno WORK")) {
      if (last.role === "user") {
        await Promise.race([gate, delay(60_000, undefined, { signal: options.signal })]);
        return fauxAssistantMessage([fauxThinking("WORK REASONING"), fauxToolCall("delegate", { agent: "worker", task: "Reason only" }, { id: "leaf" })], { stopReason: "toolUse" });
      }
      return reply("WORK REPORT");
    }
    if (system.includes("WORKER")) return fauxAssistantMessage([fauxThinking("WORKER REASONING"), fauxText("LEAF RESULT")]);
    if (last.role === "toolResult") return reply("ACK");
    if (text(last).startsWith("Work #")) return reply("DONE");
    return call("start_work", { agent: "kaeno", title: "Trace", brief: "Background reasoning and delegation" });
  });
  s.config.templates.worker!.sandbox = false;
  s.config.templates.worker!.tools = [];
  await s.submit("first", "request-trace"); await s.waitReply("request-trace");
  expect(records.some(r => r.role === "chat" && r.event === "text" && r.content === "ACK")).toBe(true);
  release();
  await until(async () => s.sent.includes("DONE"));
  const job = (await s.work.list(s.id))[0]!;
  expect(records.some(r => r.role === "work" && r.workId === job.id && r.event === "thinking" && r.content === "WORK REASONING")).toBe(true);
  expect(records.some(r => r.role === "worker" && r.workId === job.id && r.event === "thinking" && r.content === "WORKER REASONING")).toBe(true);
  expect(records.some(r => r.role === "work" && r.event === "tool_start" && r.tool === "delegate")).toBe(true);
  expect(records.some(r => r.role === "work" && r.event === "tool_end" && r.content === "LEAF RESULT")).toBe(true);
  expect(pods).not.toHaveBeenCalled();
});
