// Kaeno: an always-on, durable orchestrator agent. One pi-durable Harness on a SQLite file holds every thread,
// sub-agent, tool call and turn; a restart resumes them. Channels (HTTP API for pi, Telegram)
// only submit and watch.
import { readFile } from "node:fs/promises";
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
import { pollTelegram, telegramClient, telegramNotifier } from "./telegram.ts";
import { defineTurn, refreshThreads, type ThreadDeps } from "./threads.ts";
import { defineControl } from "./turns.ts";
import { createWork } from "./work.ts";
import { parseSandboxImages } from "./skills.ts";
import { prepareSkills } from "./skill-repositories.ts";

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
const executionImage = env("SANDBOX_IMAGE") ?? JSON.parse(await readFile(env("KAENO_BUILD_INFO") ?? "/app/build-info.json", "utf8")).sandboxImage;
const images = parseSandboxImages({ execution: executionImage });
const skillCacheClaim = env("KAENO_SKILL_CACHE_CLAIM") ?? self?.spec?.volumes?.find((v: any) => v.name === "skill-cache")?.persistentVolumeClaim?.claimName ?? "kaeno-skills";
console.log("skills: resolving runtime configuration before resuming agents");
const skills = await prepareSkills({
  repositories: config.skillRepositories,
  selections: Object.fromEntries(Object.values(config.templates).map(t => [t.name, t.skills])),
  cacheRoot: env("KAENO_SKILL_CACHE") ?? "/var/lib/kaeno/skills",
});

// ---- the durable core ----
const models = createModels();
models.setProvider(anthropicProvider()); // reads ANTHROPIC_API_KEY
models.setProvider(openaiProvider());    // reads OPENAI_API_KEY
let harness!: Harness;
let agents!: ReturnType<typeof createAgents>;
const telegram = telegramToken ? telegramClient(telegramToken, env("TELEGRAM_API_BASE")) : undefined;
const Turn = defineTurn(() => telegramNotifier(telegram));
const Control = defineControl(() => harness, (id, workId) => work.cancel(id, workId));
const work: ReturnType<typeof createWork> = createWork({ harness: () => harness, Turn, Control,
  capture: () => agents.captureWork(), configure: (tx, id, blueprint, workId) => agents.configureWork(tx, id, blueprint, workId), clean: id => agents.workClean(id) });
agents = createAgents({ config, images, skillCacheClaim, skills, harness: () => harness, work });
const registry = createRegistry();
registry.install(CodingTools);
registry.install(agents.Kaeno);
registry.install(work.extension);
registry.install(defineExtension({ name: "kaeno-channels", tasks: [Turn, Control] }));
harness = await Harness.open(await openNodeSqliteStorage(env("KAENO_DB") ?? "/data/kaeno.sqlite"), {
  models, registry, env: agents.env,
  settings: { extensions: [CodingTools, agents.Kaeno], toolExecution: "parallel", followUpMode: "one-at-a-time", retry: { maxRetries: 4 } },
  onReport: error => console.error("harness:", error),
}, BACKGROUND_CONTEXT);

const deps: ThreadDeps = { harness: () => harness, agent: {
  template: config.agent, role: "chat", change: () => agents.agentChange(config.templates[config.agent]!),
  skills: () => agents.bindSkills(config.templates[config.agent]!),
} };
await refreshThreads(deps);
harness.resume(); // continue every run, delegation and turn the last process left unfinished

// ---- channels and housekeeping ----
const stopping = new AbortController();
const port = Number(env("PORT") ?? 8080);
const api = createApi({ ...deps, token, Turn, Control, work }).listen(port);
if (telegram) void pollTelegram({ ...deps, client: telegram, allowed: new Set(config.telegram.allowedChatIds), Turn, Control, work, signal: stopping.signal });
const sweep = () => agents.sweep().catch(e => console.error("sweeper:", e));
const sweeper = setInterval(sweep, 5 * 60_000);
setTimeout(sweep, 30_000); // after resumed delegations had a chance to re-adopt their pods

console.log(`kaeno listening on :${port} · agent ${config.agent} (${config.templates[config.agent]!.model.provider}/${config.templates[config.agent]!.model.modelId}) · ` +
  `templates ${Object.keys(config.templates).join(", ")} · telegram ${telegram ? "on" : "off"} · sandbox image ${images.execution}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, async () => {
  console.log(`${signal}: closing`);
  agents.shutdown(); stopping.abort(); clearInterval(sweeper); api.close();
  await harness.close(BACKGROUND_CONTEXT); // durable state stays; the next process resumes from it
  process.exit(0);
});
