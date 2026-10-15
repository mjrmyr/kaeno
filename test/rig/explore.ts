// Exploratory self-test: `node test/rig/explore.ts` (requires a provider key).
//
// Boots the full kaeno stack exactly like the rig (in-memory sandbox cluster with
// REAL envd servers, real Work/Agents machinery, real artifact store, real API
// server) and then behaves as BOTH:
//   - a real user: multi-turn conversations over the HTTP API (chat, delegate,
//     follow-ups, cross-thread probes, cancellation)
//   - a quality engineer: timing every step, probing error paths, and collecting
//     physical evidence (artifacts, traces, console logs) for a report.
//
// Writes session.json + full console log into the evidence root.

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineExtension,
  Harness,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import { defineControl, defineTurn } from "../../src/turns/index.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AgentFactory } from "../../src/agents/index.ts";
import { ArtifactStore } from "../../src/artifacts/index.ts";
import {
  PROVIDER_KEYS,
  parseConfig,
  type Config,
} from "../../src/config/index.ts";
import { prepareSkills, type SkillCatalog } from "../../src/skills/index.ts";
import {
  createAgents,
  createApi,
  createThreadFixture,
  createWork,
  thread,
  type ThreadFixture,
} from "../integration/composition.ts";
import { serverPort } from "../integration/values.ts";
import { createRigCluster } from "./cluster.ts";

const DIR = "/tmp/kaeno-explore";
const ACK_TIMEOUT_MS = 120_000;
const WORK_TIMEOUT_MS = 240_000;
const POLL_MS = 400;

// ---------------------------------------------------------------------------
// Console tee: every console line is buffered for the QA pass; agent_trace JSON
// is suppressed on stdout for readability but kept in the buffer.
// ---------------------------------------------------------------------------
const consoleLines: { at: string; level: string; text: string }[] = [];
const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);
function tee(level: string, args: unknown[]): void {
  const text = args
    .map((item) =>
      typeof item === "string" ? item : (JSON.stringify(item) ?? String(item)),
    )
    .join(" ");
  consoleLines.push({ at: new Date().toISOString(), level, text });
  if (!text.startsWith('{"type":"agent_trace"')) {
    (level === "error" ? originalError : originalLog)(`[kaeno] ${text}`);
  }
}
console.log = (...args: unknown[]) => tee("log", args);
console.error = (...args: unknown[]) => tee("error", args);
console.warn = (...args: unknown[]) => tee("warn", args);

// ---------------------------------------------------------------------------
// Local secrets (same rule as the rig: real environment always wins).
// ---------------------------------------------------------------------------
async function loadRigEnv(): Promise<void> {
  const file = join(import.meta.dirname, "../../.rig.env");
  const raw = await readFile(file, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (raw === null) {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      throw new Error(`.rig.env: expected KEY=VALUE, got: ${trimmed}`);
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (process.env[key] === undefined && value.length > 0) {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Stack boot (mirrors test/rig/scenario.ts, with user-facing instructions).
// ---------------------------------------------------------------------------
interface Stack {
  harness: Harness;
  work: ReturnType<typeof createWork>;
  cluster: ReturnType<typeof createRigCluster>;
  api: ReturnType<typeof createApi>;
  port: number;
  token: string;
  deps: ThreadFixture;
  skillsNote: string;
}

function harnessRef(harness: Harness | undefined): Harness {
  if (harness === undefined) {
    throw new Error("harness not booted");
  }
  return harness;
}

function pickProvider(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY !== undefined) {
    return "anthropic";
  }
  if (process.env.OPENAI_API_KEY !== undefined) {
    return "openai";
  }
  if (process.env.OPENROUTER_API_KEY !== undefined) {
    return "openrouter";
  }
  return undefined;
}

/** Sonnet-grade defaults: exploration judges agent behavior, so weak models skew findings. */
function pickModel(provider: string): string {
  const override = process.env.KAENO_EXPLORE_MODEL;
  if (override !== undefined) {
    return override;
  }
  if (provider === "openai") {
    return "openai/gpt-5.4";
  }
  if (provider === "openrouter") {
    return "openrouter/anthropic/claude-sonnet-5.5";
  }
  return "anthropic/claude-sonnet-5-5";
}

async function bootStack(dir: string): Promise<Stack> {
  const provider = pickProvider();
  if (provider === undefined) {
    throw new Error(
      `explore: set ${PROVIDER_KEYS.anthropic}, ${PROVIDER_KEYS.openai} or ${PROVIDER_KEYS.openrouter}`,
    );
  }
  const model = pickModel(provider);
  originalLog(`explore: provider ${provider}, model ${model}`);

  let skillsNote = "skills: none (repository unavailable)";
  let skillSelectors: string[] | undefined;
  let catalog: SkillCatalog = { bindSkills: () => [] };
  try {
    catalog = await prepareSkills({
      repositories: [{ id: "mjrmyr/myriad" }],
      selections: {
        kaeno: ["mjrmyr/myriad:*"],
        worker: ["mjrmyr/myriad:*"],
      },
      cacheRoot: join(dir, "skills"),
    });
    skillSelectors = ["mjrmyr/myriad:*"];
    skillsNote = "skills: mjrmyr/myriad:* bound";
  } catch (error) {
    skillsNote = `skills: unavailable (${String(error).slice(0, 160)})`;
  }

  const rawConfig: Record<string, unknown> = {
    agent: "kaeno",
    sandboxCapacity: 1,
    ...(skillSelectors === undefined
      ? {}
      : { skillRepositories: ["mjrmyr/myriad"] }),
    templates: {
      kaeno: {
        description: "Kaeno assistant",
        model,
        instructions:
          "You are kaeno, a fast, friendly, always-on assistant. Answer simple questions and small talk directly and concisely. " +
          "When the user asks you to create, read, or modify files in your workspace, delegate to the worker template with start_work — " +
          "give the worker precise, self-contained instructions — then report the result to the user in one or two sentences. " +
          "Acknowledge what you are doing before delegating. Never invent file contents you have not seen. " +
          "If you cannot access information the user refers to, say so plainly and ask.",
        delegates: ["worker"],
        ...(skillSelectors === undefined ? {} : { skills: skillSelectors }),
      },
      worker: {
        description: "Kaeno worker",
        model,
        instructions:
          "You complete file tasks exactly as instructed. Use the write and read tools with workspace-relative paths. " +
          "When asked to verify, read the file back and confirm the exact content. " +
          "Finish with DONE: <what you did> or FAILED: <why>.",
        ...(skillSelectors === undefined ? {} : { skills: skillSelectors }),
      },
    },
  };
  const config: Config = parseConfig(rawConfig);
  originalLog(`explore: ${skillsNote}`);

  const models = createModels();
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());
  models.setProvider(openrouterProvider());

  const Turn = defineTurn(() => ({
    typing: async () => {},
    send: async (_notify, message) => {
      originalLog(`[notify] ${message}`);
    },
  }));
  let harness: Harness | undefined;
  const workRef: { current: ReturnType<typeof createWork> | undefined } = {
    current: undefined,
  };
  const Control = defineControl(
    () => harnessRef(harness),
    (id, workId) => {
      const work = workRef.current;
      if (work === undefined) {
        throw new Error("work not booted");
      }
      return work.cancelWork(id, workId);
    },
  );
  const cluster = createRigCluster(join(dir, "sandbox"));
  const store = new ArtifactStore(join(dir, "artifacts"));
  const work = createWork({
    harness: () => harnessRef(harness),
    Turn,
    Control,
    config,
    agents: () => {
      if (agents === undefined) {
        throw new Error("agents not booted");
      }
      return agents;
    },
    artifacts: store,
  });
  workRef.current = work;
  const factory = new AgentFactory(
    config,
    catalog,
    work,
    join(dir, "sandbox", "workspace"),
  );
  let agents: ReturnType<typeof createAgents> | undefined;
  agents = createAgents({
    harness: () => harnessRef(harness),
    factory,
    images: { execution: "execution-v1" },
    skillCacheClaim: "explore-cache",
    client: cluster.client,
    sandboxUrl: (pod: string) => {
      const podRecord = cluster.pod(pod);
      if (podRecord === undefined) {
        throw new Error(`unknown pod ${pod}`);
      }
      return podRecord.url;
    },
    artifacts: store,
    sandboxCapacity: config.sandboxCapacity,
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
  harness.resume();

  const deps = createThreadFixture(() => harness, {
    role: "chat",
    configure: (tx: Tx, id: ConversationId) =>
      factory.configureAgent(tx, id, { role: "chat" }, agents.extension),
  });
  const token = "explore".padEnd(32, "-");
  const api = createApi({
    harness: () => harnessRef(harness),
    threads: deps.threads,
    token,
    Turn,
    Control,
    work,
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));

  return {
    harness: harness,
    work: work,
    cluster: cluster,
    api: api,
    port: serverPort(api),
    token: token,
    deps: deps,
    skillsNote: skillsNote,
  };
}

// ---------------------------------------------------------------------------
// HTTP client (zod-parsed, like a real API consumer).
// ---------------------------------------------------------------------------
const replySchema = z.object({
  id: z.number(),
  requestId: z.string(),
  text: z.string(),
  source: z.unknown(),
  epoch: z.number(),
});
const pageSchema = z.object({
  replies: z.array(replySchema),
  next: z.number(),
  truncated: z.boolean(),
});
const workViewSchema = z.object({
  id: z.number(),
  title: z.string(),
  agent: z.string(),
  status: z.string(),
  artifacts: z
    .object({
      present: z.boolean(),
      truncated: z.boolean(),
      bytes: z.number(),
    })
    .optional(),
});
const listingSchema = z.object({
  manifest: z.unknown(),
  files: z.array(z.string()),
});

interface TurnResult {
  ok: boolean;
  status: number;
  firstFrameMs: number | undefined;
  frames: string[];
  done: string;
  ms: number;
}

class Api {
  private readonly base: string;
  private readonly token: string;
  constructor(port: number, token: string) {
    this.base = `http://127.0.0.1:${port}`;
    this.token = token;
  }
  headers(token: string = this.token): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
  }
  async health(): Promise<number> {
    const response = await fetch(`${this.base}/healthz`);
    return response.status;
  }
  async postTurnRaw(
    key: string,
    body: Record<string, unknown>,
    token: string = this.token,
  ): Promise<{ status: number; json: unknown }> {
    const response = await fetch(`${this.base}/v1/threads/${key}/turn`, {
      method: "POST",
      headers: this.headers(token),
      body: JSON.stringify(body),
    });
    const json: unknown = await response.json().catch(() => null);
    return { status: response.status, json };
  }
  /** Streams the NDJSON turn; resolves on the done/error frame or timeout. */
  async turn(
    key: string,
    text: string,
    requestId: string,
  ): Promise<TurnResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ACK_TIMEOUT_MS);
    const started = Date.now();
    let firstFrameMs: number | undefined;
    const frames: string[] = [];
    const finish = (ok: boolean, status: number, done: string): TurnResult => ({
      ok: ok,
      status: status,
      firstFrameMs: firstFrameMs,
      frames: frames,
      done: done,
      ms: Date.now() - started,
    });
    try {
      const response = await fetch(`${this.base}/v1/threads/${key}/turn`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ text, requestId }),
        signal: controller.signal,
      });
      if (response.status !== 200 || response.body === null) {
        const body: unknown = await response.json().catch(() => null);
        return finish(false, response.status, JSON.stringify(body));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (line.length === 0) {
            continue;
          }
          if (firstFrameMs === undefined) {
            firstFrameMs = Date.now() - started;
          }
          const parsed = z
            .object({
              type: z.string(),
              text: z.string().optional(),
              message: z.string().optional(),
            })
            .safeParse(JSON.parse(line));
          if (!parsed.success) {
            continue;
          }
          frames.push(parsed.data.type);
          if (parsed.data.type === "done" || parsed.data.type === "error") {
            return finish(
              parsed.data.type === "done",
              200,
              parsed.data.text ?? parsed.data.message ?? "(no content)",
            );
          }
        }
      }
      return finish(false, 200, "stream ended without a final frame");
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return finish(
        false,
        aborted ? 599 : 500,
        aborted ? "client timeout" : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  async replies(
    key: string,
    after: number,
  ): Promise<z.infer<typeof pageSchema>> {
    const response = await fetch(
      `${this.base}/v1/threads/${key}/replies?after=${after}`,
      { headers: this.headers() },
    );
    return pageSchema.parse(await response.json());
  }
  async work(key: string): Promise<z.infer<typeof workViewSchema>[]> {
    const response = await fetch(`${this.base}/v1/threads/${key}/work`, {
      headers: this.headers(),
    });
    return z.array(workViewSchema).parse(await response.json());
  }
  async abort(key: string): Promise<number> {
    const response = await fetch(`${this.base}/v1/threads/${key}/abort`, {
      method: "POST",
      headers: this.headers(),
      body: "{}",
    });
    return response.status;
  }
  async artifacts(
    key: string,
    workId: number,
  ): Promise<{ status: number; files?: string[] }> {
    const response = await fetch(
      `${this.base}/v1/threads/${key}/work/${workId}/artifacts`,
      { headers: this.headers() },
    );
    if (response.status !== 200) {
      return { status: response.status };
    }
    const listing = listingSchema.parse(await response.json());
    return { status: 200, files: listing.files };
  }
  async artifactFile(
    key: string,
    workId: number,
    file: string,
  ): Promise<{ status: number; text?: string }> {
    const encoded = file
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const response = await fetch(
      `${this.base}/v1/threads/${key}/work/${workId}/artifacts/${encoded}`,
      { headers: this.headers() },
    );
    if (response.status !== 200) {
      return { status: response.status };
    }
    return { status: 200, text: await response.text() };
  }
}

// ---------------------------------------------------------------------------
// Session driver
// ---------------------------------------------------------------------------
interface StepRecord {
  id: string;
  thread: string;
  request: string;
  turnOk: boolean;
  turnMs: number;
  firstFrameMs: number | undefined;
  reply: string;
  workId: number | undefined;
  workStatus: string | undefined;
  workMs: number | undefined;
  report: string | undefined;
  reportMs: number | undefined;
  extra: string;
}

async function poll<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`poll timed out after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function runStep(
  api: Api,
  cursors: Map<string, number>,
  step: { id: string; thread: string; text: string; delegate: boolean },
): Promise<StepRecord> {
  // Work ids are ascending; remember the newest one so polling can detect the
  // work created by THIS turn instead of grabbing a stale entry from the list.
  const before = await api.work(step.thread);
  const baseline = before.reduce((max, view) => Math.max(max, view.id), 0);
  originalLog(`explore: [${step.id}] → "${step.text.slice(0, 70)}…"`);
  const record: StepRecord = {
    id: step.id,
    thread: step.thread,
    request: step.text,
    turnOk: false,
    turnMs: 0,
    firstFrameMs: undefined,
    reply: "",
    workId: undefined,
    workStatus: undefined,
    workMs: undefined,
    report: undefined,
    reportMs: undefined,
    extra: "",
  };
  const requestId = `explore-${step.id}`;
  const turn = await api.turn(step.thread, step.text, requestId);
  record.turnOk = turn.ok;
  record.turnMs = turn.ms;
  record.firstFrameMs = turn.firstFrameMs;
  record.reply = turn.done;
  if (!turn.ok) {
    originalLog(`explore: [${step.id}] turn FAILED: ${turn.done}`);
    return record;
  }
  originalLog(
    `explore: [${step.id}] ← (${turn.ms}ms, first frame ${turn.firstFrameMs}ms) "${turn.done.slice(0, 110)}"`,
  );
  if (!step.delegate) {
    return record;
  }
  // start_work commits before the turn returns; no new entry means the model
  // chose not to delegate, not that we should wait four minutes for a worker.
  if (!(await api.work(step.thread)).some((view) => view.id > baseline)) {
    record.extra = "no work was created — the model did not delegate";
    originalLog(`explore: [${step.id}] ${record.extra}`);
    return record;
  }
  const started = Date.now();
  const terminal = await poll(async () => {
    const list = await api.work(step.thread);
    const mine = list.find((view) => view.id > baseline);
    if (mine === undefined) {
      return undefined;
    }
    const live = ["running", "queued"].includes(mine.status);
    return live ? undefined : mine;
  }, WORK_TIMEOUT_MS).catch(() => undefined);
  if (terminal === undefined) {
    // Distinguish "the model never delegated" from "delegation stalled": a work
    // entry above the baseline never appeared.
    const appeared = (await api.work(step.thread)).some(
      (view) => view.id > baseline,
    );
    record.extra = appeared
      ? "work never reached a terminal state"
      : "no work was created — the model did not delegate";
    originalLog(`explore: [${step.id}] ${record.extra}`);
    return record;
  }
  record.workId = terminal.id;
  record.workStatus = terminal.status;
  record.workMs = Date.now() - started;
  originalLog(
    `explore: [${step.id}] work ${terminal.id} → ${terminal.status} (${record.workMs}ms after ack)`,
  );
  if (terminal.status === "awaiting-reply") {
    record.extra = "worker is waiting for a user response, not a final report";
    return record;
  }
  // Reports are keyed per work (`work-report:<id>:final`); matching any
  // work-report would attribute a late report of an earlier work to this step.
  const after = cursors.get(step.thread) ?? 0;
  const reportDeadline = Date.now() + 90_000;
  for (;;) {
    const page = await api.replies(step.thread, after);
    const report = page.replies.find(
      (reply) => reply.requestId === `work-report:${terminal.id}:final`,
    );
    if (report !== undefined) {
      record.report = report.text;
      record.reportMs = Date.now() - started;
      cursors.set(
        step.thread,
        Math.max(cursors.get(step.thread) ?? 0, report.id),
      );
      originalLog(
        `explore: [${step.id}] report (${record.reportMs}ms): "${report.text.slice(0, 110)}"`,
      );
      break;
    }
    if (Date.now() > reportDeadline) {
      record.extra = `${record.extra} no final work-report reply within 90s`;
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
  return record;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  await loadRigEnv();
  await rm(DIR, { recursive: true, force: true });
  const stack = await bootStack(DIR);
  const api = new Api(stack.port, stack.token);
  await thread(stack.deps, "main");
  const session: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    provider: pickProvider(),
    skills: stack.skillsNote,
  };
  const cursors = new Map<string, number>();
  const save = async (): Promise<void> => {
    await writeFile(
      join(DIR, "session.json"),
      JSON.stringify(session, null, 2),
    );
    await writeFile(
      join(DIR, "console.jsonl"),
      consoleLines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
  };

  // -- error probes (no LLM cost) -----------------------------------------
  const probes: Record<string, unknown> = {};
  probes.healthz = await api.health();
  const wrongToken = await fetch(
    `http://127.0.0.1:${stack.port}/v1/threads/probe/turn`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer bad".padEnd(32, "-"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "hi", requestId: "probe-badtoken" }),
    },
  );
  probes.wrongToken = wrongToken.status;
  const shortRequest = await api.postTurnRaw("probe", {
    text: "hi",
    requestId: "short",
  });
  probes.shortRequestId = shortRequest.status;
  const blankText = await api.postTurnRaw("probe", {
    text: "   ",
    requestId: "probe-blank",
  });
  probes.blankText = blankText.status;
  const unknownRoute = await fetch(`http://127.0.0.1:${stack.port}/v1/nope`, {
    headers: api.headers(),
  });
  probes.unknownRoute = unknownRoute.status;
  probes.foreignWorkArtifacts = (await api.artifacts("probe", 9999)).status;
  session.probes = probes;
  originalLog(`explore: probes ${JSON.stringify(probes)}`);
  await save();

  // -- user session --------------------------------------------------------
  const steps: StepRecord[] = [];
  const push = async (
    id: string,
    threadKey: string,
    text: string,
    delegate: boolean,
  ): Promise<void> => {
    const record = await runStep(api, cursors, {
      id: id,
      thread: threadKey,
      text: text,
      delegate: delegate,
    });
    steps.push(record);
    session.steps = steps;
    await save();
  };

  await push("s1-greeting", "main", "Hi! What can you help me with?", false);
  await push(
    "s2-delegate-ideas",
    "main",
    "Please create a file notes/ideas.md in your workspace with three weekend project ideas for someone who likes electronics. One short line per idea.",
    true,
  );
  await push(
    "s3-memory",
    "main",
    "What were the three ideas you came up with? List them briefly.",
    false,
  );
  await push("s4-math", "main", "What is 17 * 23?", false);
  await push(
    "s5-delegate-verify",
    "main",
    "Create hello.txt containing exactly KAENO-EXPLORE (no trailing newline), then read it back and confirm the exact content to me.",
    true,
  );
  // Worker workspaces are ephemeral. Exercise create/append/read in one
  // delegation; editing a previous worker's files requires future persistence.
  await push(
    "s5b-delegate-append",
    "main",
    "In a single worker task: create notes/append.md containing exactly first\\n, append second\\n, then read it back and report the exact contents. Use one worker for all three operations, in that order.",
    true,
  );
  await push(
    "s6-cross-thread",
    "second",
    "Have we created any files in this conversation? If not, say so. Do not start work or assume access to another conversation's files.",
    false,
  );
  session.steps = steps;

  // -- abort probe ----------------------------------------------------------
  originalLog("explore: [s7-abort] delegating a long task, aborting mid-run");
  const abortBaseline = (await api.work("main")).reduce(
    (latest, view) => Math.max(latest, view.id),
    0,
  );
  const turnPromise = api
    .turn(
      "main",
      "Create a file counts.txt with the numbers 1 to 300, one per line. Take care to get every number right.",
      "explore-s7-abort",
    )
    .catch((error: unknown) => ({
      ok: false,
      status: 500,
      firstFrameMs: undefined,
      frames: [],
      done: `client error: ${String(error)}`,
      ms: 0,
    }));
  await poll(async () => {
    const list = await api.work("main");
    return list.find(
      (entry) => entry.id > abortBaseline && entry.status === "running",
    );
  }, 60_000).catch(() => undefined);
  const abortStatus = await api.abort("main");
  const s7 = await turnPromise;
  await new Promise<void>((resolve) => setTimeout(resolve, 8_000));
  const afterAbortWork = await api.work("main");
  const afterAbortReplies = await api.replies("main", cursors.get("main") ?? 0);
  session.abort = {
    abortStatus: abortStatus,
    turnOk: s7.ok,
    turnDone: s7.done,
    workAfter: afterAbortWork,
    newReplies: afterAbortReplies.replies.map((reply) => ({
      requestId: reply.requestId,
      text: reply.text.slice(0, 200),
    })),
  };
  // Include the aborted run in the artifact QA pass.
  const abortedWork = afterAbortWork
    .filter((view) => view.id > abortBaseline)
    .at(-1);
  if (abortedWork !== undefined) {
    steps.push({
      id: "s7-abort",
      thread: "main",
      request: "Create a file counts.txt with the numbers 1 to 300…",
      turnOk: s7.ok,
      turnMs: s7.ms,
      firstFrameMs: s7.firstFrameMs,
      reply: s7.done,
      workId: abortedWork.id,
      workStatus: abortedWork.status,
      workMs: undefined,
      report: undefined,
      reportMs: undefined,
      extra: `abort status ${abortStatus}`,
    });
  }
  originalLog(`explore: abort probe ${JSON.stringify(session.abort)}`);

  // -- QA pass: work views, artifacts, traces --------------------------------
  const workViews: Record<string, unknown> = {};
  for (const threadKey of ["main", "second"]) {
    workViews[threadKey] = await api.work(threadKey);
  }
  session.workViews = workViews;

  const artifactSnapshots: Record<string, unknown> = {};
  const seenWork = new Set<number>();
  for (const record of steps) {
    if (record.workId === undefined || seenWork.has(record.workId)) {
      continue;
    }
    seenWork.add(record.workId);
    const listing = await api.artifacts(record.thread, record.workId);
    const manifestFile = await api.artifactFile(
      record.thread,
      record.workId,
      "manifest.json",
    );
    const traceFile = await api.artifactFile(
      record.thread,
      record.workId,
      "trace.log",
    );
    const traceEvents: Record<string, number> = {};
    const traceErrors: string[] = [];
    if (traceFile.text !== undefined) {
      for (const line of traceFile.text.split("\n")) {
        if (line.length === 0) {
          continue;
        }
        const parsed = z
          .object({ event: z.string(), isError: z.boolean().optional() })
          .safeParse(JSON.parse(line));
        if (!parsed.success) {
          continue;
        }
        traceEvents[parsed.data.event] =
          (traceEvents[parsed.data.event] ?? 0) + 1;
        if (parsed.data.isError === true) {
          traceErrors.push(line.slice(0, 400));
        }
      }
    }
    artifactSnapshots[record.id] = {
      workId: record.workId,
      listingStatus: listing.status,
      files: listing.files,
      manifest: manifestFile.text ?? `http ${manifestFile.status}`,
      traceEvents: traceEvents,
      traceErrors: traceErrors,
    };
  }
  session.artifacts = artifactSnapshots;

  const consoleIssues = consoleLines.filter(
    (line) =>
      line.level !== "log" ||
      (/error|failed|exception|warn/i.test(line.text) &&
        !line.text.startsWith('{"type":"agent_trace"')),
  );
  session.consoleIssues = consoleIssues.slice(0, 100);
  session.consoleLineCount = consoleLines.length;
  session.finishedAt = new Date().toISOString();

  await writeFile(join(DIR, "session.json"), JSON.stringify(session, null, 2));
  // Full console including CHAT agent traces (only WORK traces reach artifacts).
  await writeFile(
    join(DIR, "console.jsonl"),
    consoleLines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  originalLog(`explore: session written to ${DIR}/session.json`);

  stack.api.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    stack.api.close((error) => {
      if (error !== undefined) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  await stack.harness.close(ctx);
  await stack.cluster.stop();
  originalLog("explore: stack stopped");
}

await main().catch(async (error: unknown) => {
  originalError(`explore: fatal: ${String(error)}`);
  await writeFile(
    join(DIR, "session.json"),
    JSON.stringify({ fatal: String(error), console: consoleLines }, null, 2),
  ).catch(() => undefined);
  process.exit(1);
});
