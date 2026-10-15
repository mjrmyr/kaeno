// Self-test rig entry point: `npm run rig`.
//
// Boots the full kaeno stack as local processes — in-memory sandbox cluster with
// REAL envd servers on localhost, real Work/Agents machinery, real artifact store,
// real ApiServer — drives one real delegation, and verifies the physical evidence
// the run left behind. Same primitive in production and in the rig, exactly as
// docs/artifacts.md prescribes.
//
// LLM: real API calls when a provider key is set (budget: one delegation on
// cheap models — override with KAENO_RIG_CHAT_MODEL / KAENO_RIG_WORK_MODEL).
// Keys come from the environment; a local gitignored .rig.env (KEY=VALUE lines)
// is loaded only into unset variables. Without any key the rig runs the
// scripted faux provider, which still exercises every non-LLM part for free.
// Force it with --faux.
//
// The temp root (sqlite, artifacts, sandbox workspace) is kept after the run so
// the evidence can be inspected; remove it yourself or pass --clean.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  Harness,
  type JsonObject,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { admitTurn, defineControl, defineTurn } from "../../src/turns/index.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentFactory } from "../../src/agents/index.ts";
import { ArtifactStore } from "../../src/artifacts/index.ts";
import { parseConfig } from "../../src/config/index.ts";
import { parseTaskId } from "../../src/durable/index.ts";
import { WorkScope } from "../../src/work/index.ts";
import {
  createAgents,
  createApi,
  createThreadFixture,
  createWork,
  thread,
} from "../integration/composition.ts";
import {
  messageText,
  required,
  SANDBOX_RESOURCES,
  serverPort,
} from "../integration/values.ts";
import { artifactChecks, createRigChecks, httpChecks } from "./assertions.ts";
import { createRigCluster } from "./cluster.ts";

const FAUX_TURNS = 150;

/**
 * Load local secrets from a gitignored .rig.env next to the scenario into
 * UNSET environment variables only — real environment always wins, and the
 * file's values never appear in output or captured evidence.
 */
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
const FAUX_TIMEOUT_MS = 30_000;
const REAL_TIMEOUT_MS = 180_000;

async function until(check: () => Promise<boolean>, ms: number): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await delay(10)) {
    if (await check()) {
      return;
    }
  }
  throw new Error(`rig timed out after ${ms}ms`);
}

const reply = (text: string): AssistantMessage =>
  fauxAssistantMessage([fauxText(text)]);
const call = (name: string, args: JsonObject, id: string): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(name, args, { id })], {
    stopReason: "toolUse",
  });
const text = (message: TranscriptContext["messages"][number]): string =>
  messageText(message);
// Only WORK is offered message_parent (a tool name, not prompt prose).
const isWork = (system: string) => system.includes("message_parent");

function scriptedRoute(
  system: string,
  last: TranscriptContext["messages"][number],
): AssistantMessage {
  if (isWork(system)) {
    if (last.role === "toolResult") {
      return reply("DONE: created hello.txt with content kaeno-rig");
    }
    return call(
      "write",
      { path: "hello.txt", content: "kaeno-rig" },
      "write-hello",
    );
  }
  if (last.role === "toolResult") {
    return reply("Delegated to the worker; awaiting its report.");
  }
  if (text(last).includes("RIG_TASK")) {
    return call(
      "start_work",
      {
        agent: "worker",
        title: "Rig run",
        brief:
          "Create hello.txt in the workspace containing exactly: kaeno-rig",
      },
      "start-rig-work",
    );
  }
  return reply("Acknowledged.");
}

async function bootRig(
  dir: string,
  real: boolean,
  provider: string,
): Promise<{
  harness: Harness;
  work: ReturnType<typeof createWork>;
  factory: AgentFactory;
  cluster: ReturnType<typeof createRigCluster>;
  store: ArtifactStore;
  Turn: ReturnType<typeof defineTurn>;
  Control: ReturnType<typeof defineControl>;
  sent: string[];
  agents: ReturnType<typeof createAgents>;
}> {
  const model = real ? rigModel(provider) : "anthropic/faux-1";
  const config = parseConfig({
    agent: "kaeno",
    sandboxResources: SANDBOX_RESOURCES,
    templates: {
      kaeno: {
        description: "Rig orchestrator",
        model,
        instructions:
          "You are the rig orchestrator. Delegate every user task to the worker template with start_work, then report the worker's result verbatim.",
        delegates: ["worker"],
      },
      worker: {
        description: "Rig worker",
        model,
        instructions:
          "You create files exactly as instructed with the write tool, using paths relative to the workspace. Then reply with DONE and the exact path you wrote.",
      },
    },
  });

  const models = createModels();
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());
  models.setProvider(openrouterProvider());
  if (!real) {
    const faux = fauxProvider({ provider: "anthropic" });
    models.setProvider(faux.provider);
    faux.setResponses(
      Array.from(
        { length: FAUX_TURNS },
        () =>
          async (
            request: TranscriptContext,
            _options: SimpleStreamOptions | undefined,
          ): Promise<AssistantMessage> => {
            const system = JSON.stringify(
              request.messages.filter((message) => message.role === "system"),
            );
            const last = request.messages.findLast(
              (message) => message.role !== "system",
            );
            return scriptedRoute(system, required(last));
          },
      ),
    );
  }

  const sent: string[] = [];
  const Turn = defineTurn(() => ({
    typing: async () => {},
    send: async (_notify, message) => {
      sent.push(message);
    },
  }));
  let harness: Harness | undefined;
  const Control = defineControl(
    () => required(harness),
    (id, workId) => required(work).cancelWork(id, workId),
  );
  let agents: ReturnType<typeof createAgents> | undefined;
  // Same wiring order as the integration fixture: work → factory → agents → harness.
  const cluster = createRigCluster(join(dir, "sandbox"));
  const store = new ArtifactStore(join(dir, "artifacts"));
  const work = createWork({
    harness: () => required(harness),
    Turn,
    Control,
    config,
    agents: () => required(agents),
    artifacts: store,
  });
  const factory = new AgentFactory(
    config,
    { bindSkills: () => [] },
    work,
    join(dir, "sandbox", "workspace"),
  );
  agents = createAgents({
    harness: () => required(harness),
    factory,
    images: { execution: "execution-v1" },
    skillCacheClaim: "rig-cache",
    client: cluster.client,
    sandboxUrl: (pod: string) => required(cluster.pod(pod)).url,
    artifacts: store,
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
  return {
    harness,
    work,
    factory,
    cluster,
    store,
    Turn,
    Control,
    sent,
    agents,
  };
}

/** First configured provider wins; all provider keys are optional. */
function rigProvider(): string | undefined {
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

function rigModel(provider: string): string {
  if (provider === "openai") {
    return "openai/gpt-5.4";
  }
  if (provider === "openrouter") {
    return "openrouter/anthropic/claude-sonnet-5.5";
  }
  return "anthropic/claude-sonnet-5-5";
}

async function runScenario(): Promise<number> {
  const clean = process.argv.includes("--clean");
  const forced = process.argv.includes("--faux");
  const provider = rigProvider();
  const real = !forced && provider !== undefined;
  console.log(
    real
      ? `rig: real LLM pass via ${provider} (Sonnet-grade models, one delegation)`
      : "rig: scripted LLM pass — set ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY for the real pass; --faux silences this note",
  );

  const dir = await mkdtemp(join(tmpdir(), "kaeno-rig-"));
  console.log(`rig: evidence root ${dir}`);
  const rig = await bootRig(
    dir,
    real,
    process.env.KAENO_RIG_CHAT_MODEL?.split("/")[0] ?? provider ?? "anthropic",
  );
  const { work, cluster, store, sent, agents } = rig;

  const deps = createThreadFixture(() => rig.harness, {
    role: "chat",
    configure: (tx: Tx, id: ConversationId) =>
      rig.factory.configureAgent(tx, id, { role: "chat" }, agents.extension),
  });
  const apiToken = "rig".padEnd(32, "-");
  const api = createApi({
    harness: () => rig.harness,
    threads: deps.threads,
    token: apiToken,
    Turn: rig.Turn,
    Control: rig.Control,
    work,
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));

  let scopes = 0;
  const scopeConversation = async (workId: number): Promise<string> => {
    const key = `rig:scoped-${scopes++}`;
    const id = await thread(deps, key);
    await rig.harness.commit(async (tx: Tx) => {
      const scope = await tx.doc(WorkScope, id);
      scope.depth = 1;
      scope.workId = parseTaskId(workId);
    }, ctx);
    return key;
  };

  const chatKey = "rig:chat";
  const chatId = await thread(deps, chatKey);
  const turn = await rig.harness.commit(
    (tx: Tx) =>
      admitTurn(tx, rig.Turn, {
        conversationId: chatId,
        content:
          "RIG_TASK: delegate to the worker: create hello.txt in the workspace containing exactly kaeno-rig, then report the result.",
        requestId: "rig-run",
        notify: { telegram: 111 },
      }),
    ctx,
  );

  const timeout = real ? REAL_TIMEOUT_MS : FAUX_TIMEOUT_MS;
  try {
    await until(async () => {
      const jobs = await work.listWork(chatId);
      const job = jobs[0];
      return job !== undefined && job.status === "completed";
    }, timeout);
  } catch (error) {
    console.error(`rig: delegation did not complete: ${String(error)}`);
    console.error(`  replies so far: ${JSON.stringify(sent)}`);
    console.error(
      `  pods: ${JSON.stringify(
        (await cluster.client.listSandboxPods()).map(
          (pod) => pod.metadata.name,
        ),
      )}`,
    );
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await rig.harness.close(ctx);
    await cluster.stop();
    return 1;
  }
  const jobs = await work.listWork(chatId);
  const workId = required(jobs[0]).id;
  const runDirectory = join(
    dir,
    "artifacts",
    `work-${workId}`,
    `task-${workId}`,
  );
  const identity = { workId, taskId: workId };

  const checks = createRigChecks();
  artifactChecks(checks, { store, identity, runDirectory });
  httpChecks(checks, {
    port: serverPort(api),
    token: apiToken,
    chatKey,
    workId,
    runDirectory,
    scopeConversation,
    keys: [
      process.env.ANTHROPIC_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.OPENROUTER_API_KEY,
    ].filter((key) => key !== undefined),
  });

  await rig.harness.waitForTask(turn, ctx);
  const ok = await checks.finish("rig: ground-truth checks");
  console.log(`rig: evidence kept at ${dir} (pass --clean to remove)`);
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await rig.harness.close(ctx);
  await cluster.stop();
  if (clean) {
    await rm(dir, { recursive: true, force: true });
  }
  return ok ? 0 : 1;
}

await loadRigEnv();
process.exit(await runScenario());
