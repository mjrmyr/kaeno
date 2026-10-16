import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import {
  configure,
  createRegistry,
  defineExtension,
  Harness,
  watchEvents,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { z } from "zod";
import { ApiServer } from "../api/index.ts";
import { assistantToolPolicy } from "../authority/index.ts";
import { PROVIDER_KEYS, loadConfig } from "../config/index.ts";
import {
  HarnessReference,
  assertRecoveryCompatible,
} from "../durable/index.ts";
import {
  TelegramClient,
  TelegramNotifier,
  TelegramPoller,
} from "../telegram/index.ts";
import { ThreadDirectory } from "../threads/index.ts";
import { defineControl, defineTurn, TurnCoordinator } from "../turns/index.ts";
import { prepareWork } from "./work.ts";
import { minimalChatAgent } from "./minimal.ts";
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
  const models = createModels();
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());
  models.setProvider(openrouterProvider());
  const harnessReference = new HarnessReference();
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
  const controlTask = defineControl(
    harnessReference.getHarness,
    (id, workId) =>
      workSupport?.work.cancelWork(id, workId) ?? Promise.resolve(),
  );
  const turns = new TurnCoordinator(
    harnessReference.getHarness,
    turnTask,
    controlTask,
  );
  const workSupport =
    config.work === false
      ? undefined
      : await prepareWork(
          config,
          harnessReference.getHarness,
          turns,
          readEnvironment,
        );
  const work = workSupport?.work;
  const agent = workSupport?.agent ?? minimalChatAgent(config);
  const toolPolicy = assistantToolPolicy(
    harnessReference.getHarness,
    workSupport
      ? [
          ...workSupport.work.orchestrationTools,
          ...(workSupport.agent.extension.tools ?? []),
        ]
      : [],
    ["list_work", "inspect_work", "read_skill"],
  );
  const threads = new ThreadDirectory(harnessReference.getHarness, {
    async configureChatConversation(tx, id): Promise<void> {
      await agent.configureChatConversation(tx, id);
      await configure(tx, id, {
        extensions: workSupport
          ? [
              workSupport.agent.extension,
              workSupport.work.extension,
              toolPolicy,
            ]
          : [toolPolicy],
      });
    },
  });
  const registry = createRegistry();
  registry.install(toolPolicy);
  if (workSupport) {
    registry.install(CodingTools);
    registry.install(workSupport.agent.extension);
    registry.install(workSupport.work.extension);
  }
  const settings = {
    extensions: workSupport ? [CodingTools, workSupport.agent.extension] : [],
    toolExecution: "parallel",
    followUpMode: "one-at-a-time",
    retry: { maxRetries: 4 },
  } satisfies HarnessSettings;
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
      ...(workSupport
        ? { env: workSupport.agent.getExecutionEnvironment }
        : {}),
      settings,
      onReport: (error) => console.error("harness:", error),
    },
    BACKGROUND_CONTEXT,
  );
  harnessReference.setHarness(harness);
  const stopping = new AbortController();
  let polling: Promise<void> | undefined;
  const sweeps = new Set<Promise<void>>();
  let sweeper: ReturnType<typeof setInterval> | undefined;
  let initialSweep: ReturnType<typeof setTimeout> | undefined;
  let api: ReturnType<ApiServer["server"]["listen"]> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      stopping.abort();
      clearInterval(sweeper);
      clearTimeout(initialSweep);
      if (api) {
        const closed = new Promise<void>((resolve) =>
          api?.close(() => resolve()),
        );
        api.closeAllConnections();
        await closed;
      }
      await polling;
      await Promise.all(sweeps);
      await harness.close(BACKGROUND_CONTEXT);
    })();
    return closing;
  };
  try {
    await assertRecoveryCompatible(
      harness,
      registry,
      BACKGROUND_CONTEXT,
      settings,
    );
    await threads.refreshIdleConversations();
    const port = z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(readEnvironment("PORT") ?? 8080);
    api = new ApiServer(
      harnessReference.getHarness,
      threads,
      turns,
      work,
      { watchConversation: (id, ctx) => watchEvents(harness, id, ctx) },
      token,
    ).server;
    await new Promise<void>((resolve, reject) => {
      const server = api;
      if (!server) {
        reject(new Error("HTTP server was not constructed"));
        return;
      }
      server.once("error", reject);
      server.listen(port, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    harness.resume();
    if (telegram) {
      const poller = new TelegramPoller(
        harnessReference.getHarness,
        threads,
        turns,
        telegram,
        new Set(config.telegram.allowedChatIds),
        work,
      );
      polling = poller
        .pollUpdates(stopping.signal)
        .catch((error) => console.error("telegram:", error));
    }
    const sweep = (): void => {
      if (!workSupport) {
        return;
      }
      const pending = workSupport.agent
        .sweepOrphanedSandboxes()
        .catch((error) => console.error("sweeper:", error));
      sweeps.add(pending);
      void pending.finally(() => sweeps.delete(pending));
    };
    // Best effort: a missing or misconfigured quota fails each WORK with the same message.
    const fit = await workSupport?.capacity
      .fitSandboxes()
      .then((value) => value.summary)
      .catch((error: unknown) =>
        error instanceof Error ? error.message : String(error),
      );
    sweeper = workSupport ? setInterval(sweep, 5 * 60000) : undefined;
    initialSweep = workSupport ? setTimeout(sweep, 30000) : undefined;
    console.log(
      `kaeno listening on :${port} · agent ${config.agent} · max depth ${config.maxDepth} · sandboxes ${fit} · templates ${Object.keys(config.templates).join(", ")} · sandbox image ${workSupport?.images.execution ?? "disabled"}`,
    );
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        void close().then(
          () => process.exit(0),
          (error) => {
            console.error("shutdown:", error);
            process.exit(1);
          },
        );
      });
    }
  } catch (error) {
    await close().catch((cleanupError) =>
      console.error("startup cleanup:", cleanupError),
    );
    throw error;
  }
}
