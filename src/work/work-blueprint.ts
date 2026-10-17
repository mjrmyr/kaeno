import { copyJson } from "@earendil-works/chord";
import { createHash } from "node:crypto";
import { z } from "zod";
import { PROVIDERS } from "../config/index.ts";
import type { Template } from "./config.ts";
import type { Stored } from "../durable/index.ts";
import type { SandboxImages, SkillBinding } from "../skills/index.ts";
export type { Stored } from "../durable/index.ts";
export type DeepReadonly<T> = T extends object
  ? {
      readonly [Key in keyof T]: DeepReadonly<T[Key]>;
    }
  : T;
export interface BoundAgent {
  readonly template: DeepReadonly<Template>;
  readonly skills: DeepReadonly<SkillBinding>;
}
/** One request tree's immutable policy: every reachable template, frozen when CHAT starts the root WORK. */
export interface WorkBlueprint {
  readonly schema: 2;
  readonly digest: string;
  readonly agent: string;
  readonly maxDepth: number;
  readonly templates: Readonly<Record<string, BoundAgent>>;
  readonly images: Readonly<SandboxImages>;
  readonly skillCacheClaim: string;
}
const thinkingSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const modelSchema = z.object({
  provider: z.enum(PROVIDERS),
  modelId: z.string().min(1),
});
const skillSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  disableModelInvocation: z.boolean(),
  repositoryCommit: z.string().min(1),
  treeHash: z.string().min(1),
  sandboxRoot: z.string().min(1),
  documents: z
    .record(z.string(), z.string())
    .refine((documents) => Object.hasOwn(documents, "SKILL.md")),
});
const templateSchema = z.object({
  name: z.string(),
  description: z.string(),
  model: modelSchema,
  thinkingLevel: thinkingSchema.optional(),
  instructions: z.string(),
  delegates: z.array(z.string()),
  skills: z.array(z.string()),
});
const entrySchema = z.object({
  template: templateSchema,
  skills: z.array(skillSchema),
});
const blueprintSchema = z
  .object({
    schema: z.literal(2),
    digest: z.string(),
    agent: z.string().min(1),
    maxDepth: z.number().int().min(1),
    templates: z.record(z.string(), entrySchema),
    images: z.object({
      execution: z.string().min(1),
      skillSource: z.string().optional(),
    }),
    skillCacheClaim: z.string().min(1),
  })
  .superRefine((blueprint, ctx) => {
    if (!Object.hasOwn(blueprint.templates, blueprint.agent)) {
      ctx.addIssue({
        code: "custom",
        message: "Missing frozen blueprint root",
        path: ["agent"],
      });
    }
    for (const [name, entry] of Object.entries(blueprint.templates)) {
      if (entry.template.name !== name) {
        ctx.addIssue({
          code: "custom",
          message: "Frozen template identity mismatch",
          path: ["templates", name],
        });
      }
      for (const delegate of entry.template.delegates) {
        if (!Object.hasOwn(blueprint.templates, delegate)) {
          ctx.addIssue({
            code: "custom",
            message: "Missing frozen delegate",
            path: ["templates", name, "template", "delegates"],
          });
        }
      }
    }
  });
export function immutableCopy<T>(value: T): T {
  const copied = structuredClone(value);
  freezeRecursively(copied);
  return copied;
}
function freezeRecursively(value: unknown): void {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeRecursively(child);
    }
    Object.freeze(value);
  }
}
function compareKeys(
  [left]: [string, unknown],
  [right]: [string, unknown],
): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(compareKeys)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function calculateDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function sealBlueprint(
  value: Omit<WorkBlueprint, "digest">,
): WorkBlueprint {
  const snapshot = copyJson(value, { omitUndefinedProperties: true });
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Invalid frozen blueprint root");
  }
  return readBlueprint({ ...snapshot, digest: calculateDigest(snapshot) });
}
/** Boundary: verify stored data before narrowing it. This checksum is not authentication. */
export function readBlueprint(value: unknown): WorkBlueprint {
  const envelope = z
    .object({ schema: z.literal(2), digest: z.string() })
    .passthrough()
    .safeParse(value);
  if (!envelope.success) {
    throw new Error(
      "WORK has no supported frozen policy snapshot; cannot resume safely (cancel and submit a new request)",
    );
  }
  const copied = z
    .record(z.string(), z.unknown())
    .parse(copyJson(envelope.data, { omitUndefinedProperties: true }));
  const { digest, ...content } = copied;
  if (digest !== calculateDigest(content)) {
    throw new Error(
      "Invalid frozen blueprint integrity; cannot resume safely (cancel and submit a new request)",
    );
  }
  const parsed = blueprintSchema.safeParse(copied);
  if (!parsed.success) {
    throw new Error(
      `Invalid frozen blueprint; cannot resume safely: ${parsed.error.message}`,
    );
  }
  return immutableCopy(parsed.data);
}
export function storageCopy(blueprint: WorkBlueprint): Stored<WorkBlueprint>;
export function storageCopy(
  binding: BoundAgent["skills"],
): Stored<BoundAgent["skills"]>;
export function storageCopy(
  value: WorkBlueprint | BoundAgent["skills"],
): Stored<WorkBlueprint> | Stored<BoundAgent["skills"]> {
  if (Array.isArray(value)) {
    return z.array(skillSchema).parse(value);
  }
  return blueprintSchema.parse(value);
}
export function frozenEntry(
  blueprint: WorkBlueprint,
  agent: string,
): BoundAgent {
  if (!Object.hasOwn(blueprint.templates, agent)) {
    throw new Error(`Missing frozen template "${agent}"`);
  }
  return blueprint.templates[agent];
}
