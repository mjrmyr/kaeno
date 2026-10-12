// Persisted work is a replay boundary. Policy is data here, never recalculated from live configuration.
import { createHash } from "node:crypto";
import { copyJson } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { CODING_TOOLS, type Template } from "./config.ts";
import type { SandboxImages, SkillBinding } from "./skills.ts";

export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type Stored<T> = T extends object ? { -readonly [K in keyof T]: Stored<T[K]> } : T;
/** The SDK's JSON storage types require mutable arrays. Only persistence adapters use this copy. */
export function storageCopy<T>(value: T): Stored<T> {
  return copyJson(value, { omitUndefinedProperties: true }) as Stored<T>;
}
export type BoundAgent = DeepReadonly<{ template: Template; skills: SkillBinding }>;
export type FrozenRole = "work" | "worker" | "legacy";
/** All fields are required: omitted SDK change fields would retain inherited capabilities. */
export type AgentSettings = DeepReadonly<{
  model: Template["model"]; thinkingLevel: ModelThinkingLevel | null;
  extensions: string[]; tools: string[]; instructions: string; cwd: string | null;
}>;
export type WorkBlueprint = DeepReadonly<{
  schema: 1; digest: string; agent: string;
  templates: Record<string, { template: Template; skills: SkillBinding; settings: Record<FrozenRole, AgentSettings> }>;
  images: SandboxImages; skillCacheClaim: string;
}>;

/** Copy before freezing: neither live config nor transaction drafts should be frozen as a side effect. */
export function immutableCopy<T>(value: T): DeepReadonly<T> {
  const copied = copyJson(value, { omitUndefinedProperties: true });
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copied);
  return copied as DeepReadonly<T>;
}

// Stable across JSON round trips and storage implementations that reorder object keys.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(blueprint: Omit<WorkBlueprint, "digest">): string {
  return createHash("sha256").update(canonical(blueprint)).digest("hex");
}
export function sealBlueprint(value: Omit<WorkBlueprint, "digest">): WorkBlueprint {
  const snapshot = immutableCopy(value);
  return immutableCopy({ ...snapshot, digest: digest(snapshot) });
}

/** Checksums detect accidental edits/corruption, not an attacker with write access to the database. */
export function readBlueprint(blueprint: WorkBlueprint): WorkBlueprint {
  if (!blueprint || blueprint.schema !== 1)
    throw new Error("WORK has no supported frozen policy snapshot; cannot resume safely (cancel and submit a new request)");
  const snapshot = immutableCopy(blueprint);
  const { digest: expected, ...content } = snapshot;
  if (typeof expected !== "string" || expected !== digest(content))
    throw new Error("Invalid frozen blueprint integrity; cannot resume safely (cancel and submit a new request)");
  return snapshot;
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === "string");
const thinking = (value: unknown) => value === null || ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value as string);
/** Selected persisted entries cross the replay boundary; never consult current config/catalog. */
export function frozenEntry(blueprint: WorkBlueprint, agent: string) {
  const snapshot = readBlueprint(blueprint);
  const entry = snapshot.templates && Object.hasOwn(snapshot.templates, agent) ? snapshot.templates[agent] : undefined;
  if (!entry) throw new Error(`Missing frozen delegate template "${agent}"`);
  const t = entry.template;
  if (!t || t.name !== agent || typeof t.description !== "string" ||
      typeof t.model?.provider !== "string" || !t.model.provider || typeof t.model.modelId !== "string" || !t.model.modelId ||
      typeof t.instructions !== "string" || typeof t.sandbox !== "boolean" ||
      (t.thinkingLevel !== undefined && (t.thinkingLevel === null || !thinking(t.thinkingLevel))) ||
      !strings(t.tools) || t.tools.some(n => !CODING_TOOLS.includes(n)) || (t.tools.length > 0 && !t.sandbox) ||
      !strings(t.delegates) || !strings(t.skills) || !Array.isArray(entry.skills) ||
      entry.skills.some(s => !s || typeof s.id !== "string" || !s.id || typeof s.description !== "string" ||
        typeof s.disableModelInvocation !== "boolean" || typeof s.repositoryCommit !== "string" || !s.repositoryCommit ||
        typeof s.treeHash !== "string" || !s.treeHash || typeof s.sandboxRoot !== "string" || !s.sandboxRoot ||
        !s.documents || typeof s.documents !== "object" || Array.isArray(s.documents) ||
        typeof s.documents["SKILL.md"] !== "string" || Object.values(s.documents).some(text => typeof text !== "string")))
    throw new Error(`Invalid frozen agent template "${agent}"; cannot resume safely (cancel and submit a new request)`);
  for (const role of ["work", "worker", "legacy"] as const) {
    const settings = entry.settings?.[role];
    if (!settings || settings.model?.provider !== t.model.provider || settings.model.modelId !== t.model.modelId ||
        !thinking(settings.thinkingLevel) || !strings(settings.extensions) || !strings(settings.tools) ||
        typeof settings.instructions !== "string" || (settings.cwd !== null && typeof settings.cwd !== "string"))
      throw new Error(`Invalid frozen ${role} policy for "${agent}"; cannot resume safely`);
  }
  return entry;
}

export function workRoot(blueprint: WorkBlueprint) {
  if (typeof blueprint?.agent !== "string" || !blueprint.agent ||
      typeof blueprint.images?.execution !== "string" || !blueprint.images.execution ||
      typeof blueprint.skillCacheClaim !== "string" || !blueprint.skillCacheClaim)
    throw new Error("WORK has no valid frozen blueprint root; cannot resume safely (cancel and submit a new request)");
  return frozenEntry(blueprint, blueprint.agent);
}
