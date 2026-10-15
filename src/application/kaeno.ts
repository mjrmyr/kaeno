import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import {
  createRegistry,
  defineExtension,
  Harness,
  watchEvents,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  Agent,
  AgentFactory,
  AgentTraceFileSink,
  AgentTraceLogger,
} from "../agents/index.ts";
import { ApiServer } from "../api/index.ts";
import { ArtifactStore } from "../artifacts/index.ts";
import {
  PROVIDER_KEYS,
  eligibleWorkTemplates,
  loadConfig,
} from "../config/index.ts";
import { HarnessReference } from "../durable/index.ts";
import { RemoteExecutionEnv } from "../execution/index.ts";
import {
  KubernetesClient,
  SandboxCapacity,
  SandboxManager,
} from "../sandboxes/index.ts";
import { parseSandboxImages, prepareSkills } from "../skills/index.ts";
import {
  TelegramClient,
  TelegramNotifier,
  TelegramPoller,
} from "../telegram/index.ts";
import { ThreadDirectory } from "../threads/index.ts";
import { defineControl, defineTurn, TurnCoordinator } from "../turns/index.ts";
import { Work } from "../work/index.ts";
// Task definitions are constructed before Harness.open; their injected providers are only called during execution.
class StartupDependency<T> {
  private value: T | undefined;
  initialize(value: T): void {
    this.value = value;
  }
  getValue = (): T => {
    if (this.value === undefined) {
      throw new Error(
        "Application dependency requested before startup wiring completed",
      );
    }
    return this.value;
  };
}
function readEnvironment(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}
export async function startApplication(): Promise<void> {
  const token = readEnvironment("KAENO_TOKEN") ?? "";
  if (token.length < 32) {
    throw new Error("KAENO_TOKEN must be set (≥32 chars)");
  }
  const config = await loadConfig(
    readEnvironment("KAENO_CONFIG") ?? "/etc/kaeno/config.json",
  );
  // Providers are optional: a missing key never blocks boot, it only makes the
  // templates using that provider fail per-request at use time.
  const providers = new Set(
    Object.values(config.templates).map((template) => template.model.provider),
  );
  for (const provider of providers) {
    if (readEnvironment(PROVIDER_KEYS[provider]) === undefined) {
      console.warn(
        `kaeno: ${PROVIDER_KEYS[provider]} is not set; templates using ${provider} will fail at request time`,
      );
    }
  }
  const namespace = (
    await readFile(
      "/var/run/secrets/kubernetes.io/serviceaccount/namespace",
      "utf8",
    ).catch((error: unknown) => {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
      return "kaeno";
    })
  ).trim();
  const kubernetes = new KubernetesClient(
    namespace,
    fetch,
    () =>
      readFile(
        readEnvironment("KUBERNETES_TOKEN_FILE") ??
          "/var/run/secrets/kubernetes.io/serviceaccount/token",
        "utf8",
      ),
    readEnvironment("KUBERNETES_API"),
  );
  const podName = readEnvironment("POD_NAME");
  const self = podName ? await kubernetes.getPod(podName) : undefined;
  let executionImage: unknown = readEnvironment("SANDBOX_IMAGE");
  if (executionImage === undefined) {
    const raw: unknown = JSON.parse(
      await readFile(
        readEnvironment("KAENO_BUILD_INFO") ?? "/app/build-info.json",
        "utf8",
      ),
    );
    executionImage = z
      .object({ sandboxImage: z.string() })
      .parse(raw).sandboxImage;
  }
  const images = parseSandboxImages({ execution: executionImage });
  const skillCacheClaim =
    readEnvironment("KAENO_SKILL_CACHE_CLAIM") ??
    self?.spec?.volumes?.find((volume) => volume.name === "skill-cache")
      ?.persistentVolumeClaim?.claimName ??
    "kaeno-skills";
  const skills = await prepareSkills({
    repositories: config.skillRepositories,
    selections: Object.fromEntries(
      Object.values(config.templates).map((template) => [
        template.name,
        template.skills,
      ]),
    ),
    cacheRoot: readEnvironment("KAENO_SKILL_CACHE") ?? "/var/lib/kaeno/skills",
  });
  const models = createModels();
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());
  models.setProvider(openrouterProvider());
  const harnessReference = new HarnessReference();
  const agentReference = new StartupDependency<Agent>();
  const workReference = new StartupDependency<Work>();
  const telegramToken = readEnvironment("TELEGRAM_BOT_TOKEN");
  const telegram = telegramToken
    ? new TelegramClient(
        telegramToken,
        fetch,
        readEnvironment("TELEGRAM_API_BASE"),
      )
    : undefined;
  const notifier = new TelegramNotifier(telegram);
  const turnTask = defineTurn(() => notifier);
  const controlTask = defineControl(harnessReference.getHarness, (id, workId) =>
    workReference.getValue().cancelWork(id, workId),
  );
  const turns = new TurnCoordinator(
    harnessReference.getHarness,
    turnTask,
    controlTask,
  );
  // Artifacts are optional: unset KAENO_ARTIFACTS disables evidence collection.
  const artifactsRoot = readEnvironment("KAENO_ARTIFACTS");
  const artifacts =
    artifactsRoot === undefined ? undefined : new ArtifactStore(artifactsRoot);
  const work = new Work(
    harnessReference.getHarness,
    turns,
    { listWorkTemplates: () => eligibleWorkTemplates(config) },
    agentReference.getValue,
    artifacts,
  );
  workReference.initialize(work);
  const factory = new AgentFactory(config, skills, work);
  const capacity = new SandboxCapacity(
    harnessReference.getHarness,
    kubernetes,
    config.sandboxResources,
  );
  const environmentFactory = {
    createEnvironment: (
      pod: string,
      token: string,
      cwd: string,
    ): ExecutionEnv =>
      new RemoteExecutionEnv(
        `http://${pod}.kaeno-sandbox.${namespace}.svc.cluster.local:7070`,
        token,
        `pod:${pod}`,
        cwd,
        fetch,
      ),
    createCaptureEnvironment: (
      pod: string,
      token: string,
      cwd: string,
    ): RemoteExecutionEnv =>
      new RemoteExecutionEnv(
        `http://${pod}.kaeno-sandbox.${namespace}.svc.cluster.local:7070`,
        token,
        `capture:${pod}`,
        cwd,
        fetch,
      ),
  };
  const sandboxes = new SandboxManager(
    harnessReference.getHarness,
    kubernetes,
    capacity,
    environmentFactory,
    artifacts,
  );
  const logSecrets = Object.entries(process.env)
    .filter(([name]) => /TOKEN|API_KEY|PASSWORD|SECRET|PRIVATE_KEY/i.test(name))
    .flatMap(([, value]) => (value ? [value] : []));
  const logger = new AgentTraceLogger(
    (line) => console.log(line),
    logSecrets,
    artifacts === undefined ? undefined : new AgentTraceFileSink(artifacts),
  );
  const agent = new Agent(
    factory,
    harnessReference.getHarness,
    sandboxes,
    images,
    skillCacheClaim,
    logger,
  );
  agentReference.initialize(agent);
  const threads = new ThreadDirectory(harnessReference.getHarness, agent);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(agent.extension);
  registry.install(work.extension);
  registry.install(
    defineExtension({
      name: "kaeno-channels",
      tasks: [turns.turnTask, turns.controlTask],
    }),
  );
  const harness = await Harness.open(
    await openNodeSqliteStorage(
      readEnvironment("KAENO_DB") ?? "/data/kaeno.sqlite",
    ),
    {
      models,
      registry,
      env: agent.getExecutionEnvironment,
      settings: {
        extensions: [CodingTools, agent.extension],
        toolExecution: "parallel",
        followUpMode: "one-at-a-time",
        retry: { maxRetries: 4 },
      },
      onReport: (error) => console.error("harness:", error),
    },
    BACKGROUND_CONTEXT,
  );
  harnessReference.setHarness(harness);
  await threads.refreshIdleConversations();
  harness.resume();
  const stopping = new AbortController();
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(readEnvironment("PORT") ?? 8080);
  const api = new ApiServer(
    harnessReference.getHarness,
    threads,
    turns,
    work,
    { watchConversation: (id, ctx) => watchEvents(harness, id, ctx) },
    token,
  ).server.listen(port);
  if (telegram) {
    const poller = new TelegramPoller(
      harnessReference.getHarness,
      threads,
      turns,
      telegram,
      new Set(config.telegram.allowedChatIds),
      work,
    );
    void poller
      .pollUpdates(stopping.signal)
      .catch((error) => console.error("telegram:", error));
  }
  const sweep = (): void => {
    void agent
      .sweepOrphanedSandboxes()
      .catch((error) => console.error("sweeper:", error));
  };
  // Best effort: a missing or misconfigured quota fails each WORK with the same message.
  const fit = await capacity
    .fitSandboxes()
    .then((value) => value.summary)
    .catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
  const sweeper = setInterval(sweep, 5 * 60000);
  const initialSweep = setTimeout(sweep, 30000);
  console.log(
    `kaeno listening on :${port} · agent ${config.agent} · max depth ${config.maxDepth} · sandboxes ${fit} · templates ${Object.keys(config.templates).join(", ")} · sandbox image ${images.execution}`,
  );
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => {
      stopping.abort();
      clearInterval(sweeper);
      clearTimeout(initialSweep);
      api.close();
      await harness.close(BACKGROUND_CONTEXT);
      process.exit(0);
    });
  }
}
