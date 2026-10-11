// Kaeno: an always-on, durable orchestrator agent. One pi-durable Harness on a SQLite file holds every thread,
// sub-agent, tool call and scheduled turn; a restart resumes them. Channels (HTTP API for pi, Telegram, schedules)
// only submit and watch.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createAgents } from "./agents.ts";
import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";
import * as k8s from "./k8s.ts";
import { startScheduler } from "./schedule.ts";
import { pollTelegram, telegramClient, telegramNotifier } from "./telegram.ts";
import { defineTurn, refreshThreads, type ThreadDeps } from "./threads.ts";

// ---- boundary: environment and config, validated once ----
const env = (name: string) => process.env[name]?.trim() || undefined;
const token = env("KAENO_TOKEN") ?? "";
if (token.length < 32) throw new Error("KAENO_TOKEN must be set (≥32 chars)");
const config = await loadConfig(env("KAENO_CONFIG") ?? "/etc/kaeno/config.json");
const needed = new Set(Object.values(config.templates).map(t => t.model.provider));
for (const [provider, key] of [["anthropic", "ANTHROPIC_API_KEY"], ["openai", "OPENAI_API_KEY"]] as const)
  if (needed.has(provider) && !env(key)) throw new Error(`${key} is required by a template using ${provider}`);
const telegramToken = env("TELEGRAM_BOT_TOKEN");
const self = env("POD_NAME") ? await k8s.getPod(env("POD_NAME")!) : undefined;
const image = String(self?.spec?.containers?.[0]?.image ?? env("SANDBOX_IMAGE") ?? "");
if (!image) throw new Error("Cannot determine the sandbox image (own pod spec or SANDBOX_IMAGE)");

// ---- the durable core ----
const models = createModels();
models.setProvider(anthropicProvider()); // reads ANTHROPIC_API_KEY
models.setProvider(openaiProvider());    // reads OPENAI_API_KEY
let harness!: Harness;
const agents = createAgents({ config, image: () => image, harness: () => harness });
const telegram = telegramToken ? telegramClient(telegramToken, env("TELEGRAM_API_BASE")) : undefined;
const Turn = defineTurn(() => telegramNotifier(telegram));
const registry = createRegistry();
registry.install(CodingTools);
registry.install(agents.Kaeno);
registry.install(defineExtension({ name: "kaeno-channels", tasks: [Turn] }));
harness = await Harness.open(await openNodeSqliteStorage(env("KAENO_DB") ?? "/data/kaeno.sqlite"), {
  models, registry, env: agents.env,
  settings: { extensions: [CodingTools, agents.Kaeno], toolExecution: "parallel", retry: { maxRetries: 4 } },
  onReport: error => console.error("harness:", error),
}, BACKGROUND_CONTEXT);

const deps: ThreadDeps = { harness: () => harness, agent: { template: config.agent, change: () => agents.agentChange(config.templates[config.agent]!) } };
await refreshThreads(deps);
harness.resume(); // continue every run, delegation and turn the last process left unfinished

// ---- channels and housekeeping ----
const stopping = new AbortController();
const port = Number(env("PORT") ?? 8080);
const api = createApi({ ...deps, token }).listen(port);
if (telegram) void pollTelegram({ ...deps, client: telegram, allowed: new Set(config.telegram.allowedChatIds), Turn, signal: stopping.signal });
startScheduler({ ...deps, schedules: config.schedules, Turn }, stopping.signal);
const sweep = () => agents.sweep().catch(e => console.error("sweeper:", e));
const sweeper = setInterval(sweep, 5 * 60_000);
setTimeout(sweep, 30_000); // after resumed delegations had a chance to re-adopt their pods

console.log(`kaeno listening on :${port} · agent ${config.agent} (${config.templates[config.agent]!.model.provider}/${config.templates[config.agent]!.model.modelId}) · ` +
  `templates ${Object.keys(config.templates).join(", ")} · telegram ${telegram ? "on" : "off"} · schedules ${config.schedules.length} · sandbox image ${image}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, async () => {
  console.log(`${signal}: closing`);
  agents.shutdown(); stopping.abort(); clearInterval(sweeper); api.close();
  await harness.close(BACKGROUND_CONTEXT); // durable state stays; the next process resumes from it
  process.exit(0);
});
