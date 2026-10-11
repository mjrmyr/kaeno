// Kaeno's configuration (a ConfigMap) is validated once here; everything else trusts the typed result.
import { readFile } from "node:fs/promises";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { parseCron } from "./schedule.ts";

export const PROVIDERS = ["anthropic", "openai"] as const;
export const CODING_TOOLS = ["read", "write", "edit", "bash"] as const;
const THINKING: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export type Provider = (typeof PROVIDERS)[number];
export type CodingTool = (typeof CODING_TOOLS)[number];

/** An agent template: what a conversation created from it runs with. */
export type Template = {
  name: string;
  description: string;
  model: { provider: Provider; modelId: string };
  thinkingLevel?: ModelThinkingLevel;
  instructions: string;
  /** Tools run in a dedicated sandbox pod (own filesystem, internet, GitHub SSH). */
  sandbox: boolean;
  tools: CodingTool[];
  /** Templates this agent may delegate to with the `delegate` tool. */
  delegates: string[];
};

export type Schedule = { name: string; cron: string; timezone: string; prompt: string; thread: string; notify?: { telegram: number } };

export type Config = {
  /** Template that user-facing threads (pi, Telegram, schedules) run with. */
  agent: string;
  templates: Record<string, Template>;
  telegram: { allowedChatIds: number[] };
  schedules: Schedule[];
};

const fail = (message: string): never => { throw new Error(`Invalid kaeno config: ${message}`); };
const str = (v: unknown, at: string) => (typeof v === "string" && v.trim() ? v : fail(`${at} must be a non-empty string`));

export function parseConfig(raw: unknown): Config {
  const c = raw as any;
  if (!c || typeof c !== "object") fail("not an object");
  const templates: Record<string, Template> = {};
  for (const [name, t] of Object.entries<any>(c.templates ?? {})) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) fail(`template name ${name}`);
    const [provider, ...rest] = str(t.model, `${name}.model`).split("/");
    if (!PROVIDERS.includes(provider as Provider) || !rest.length) fail(`${name}.model must be one of ${PROVIDERS.join(", ")}/<model-id>`);
    if (t.thinkingLevel !== undefined && !THINKING.includes(t.thinkingLevel)) fail(`${name}.thinkingLevel`);
    const tools = (t.tools ?? []) as unknown[];
    if (!Array.isArray(tools) || tools.some(x => !CODING_TOOLS.includes(x as CodingTool))) fail(`${name}.tools must be a subset of ${CODING_TOOLS}`);
    const sandbox = t.sandbox === true;
    if (tools.length && !sandbox) fail(`${name}: coding tools require sandbox: true (they run in the sandbox pod)`);
    templates[name] = {
      name, description: str(t.description, `${name}.description`),
      model: { provider: provider as Provider, modelId: rest.join("/") },
      thinkingLevel: t.thinkingLevel, instructions: str(t.instructions, `${name}.instructions`),
      sandbox, tools: tools as CodingTool[], delegates: Array.isArray(t.delegates) ? t.delegates.map(String) : [],
    };
  }
  for (const t of Object.values(templates)) for (const d of t.delegates) if (!templates[d]) fail(`${t.name}.delegates: unknown template ${d}`);
  const agent = str(c.agent, "agent");
  if (!templates[agent]) fail(`agent: unknown template ${agent}`);
  const allowedChatIds = (c.telegram?.allowedChatIds ?? []).map(Number);
  if (allowedChatIds.some((n: number) => !Number.isSafeInteger(n))) fail("telegram.allowedChatIds must be integers");
  const schedules = (c.schedules ?? []).map((s: any, i: number): Schedule => {
    try { parseCron(str(s.cron, `schedules[${i}].cron`)); new Intl.DateTimeFormat("en-US", { timeZone: s.timezone ?? "Europe/Berlin" }); }
    catch (error) { fail(`schedules[${i}]: ${error instanceof Error ? error.message : error}`); }
    return {
    name: /^[a-z0-9-]{1,40}$/.test(s.name) ? s.name : fail(`schedules[${i}].name`),
    cron: str(s.cron, `schedules[${i}].cron`), timezone: s.timezone ?? "Europe/Berlin",
    prompt: str(s.prompt, `schedules[${i}].prompt`), thread: s.thread ?? `schedule:${s.name}`,
    notify: s.notify?.telegram !== undefined ? { telegram: Number(s.notify.telegram) } : undefined,
  };});
  return { agent, templates, telegram: { allowedChatIds }, schedules };
}

export const loadConfig = async (path: string) => parseConfig(JSON.parse(await readFile(path, "utf8")));
