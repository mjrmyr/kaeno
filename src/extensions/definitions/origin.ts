import { defineExtension } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { KaenoExtension } from "../../core/application/index.ts";

const contentHash = z.string().regex(/^[a-f0-9]{64}$/);
export const definitionOriginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("repository"),
    // Historical saved bindings predate named readers; new snapshots always include it.
    provider: z.string().min(1).optional(),
    repository: z.string().min(1),
    ref: z.string().min(1),
    commit: z.string().regex(/^[a-f0-9]{40,64}$/),
    path: z.string(),
    contentHash,
  }),
  z.object({
    kind: z.literal("directory"),
    source: z.string().min(1),
    path: z.string(),
    contentHash,
  }),
]);
export type DefinitionOrigin = z.infer<typeof definitionOriginSchema>;
const OWNER = "kaeno-definition-origins";
const valueSchema = z.object({
  agent: z.string().min(1),
  origin: definitionOriginSchema,
});

/** Audit data only: saved work never consults a live source or current commit. */
export function definitionOriginsExtension(): KaenoExtension {
  return {
    durable: defineExtension({ name: OWNER }),
    validateBinding(binding) {
      if (binding.version !== 1) {
        throw new Error("Definitions: unsupported origin binding");
      }
      valueSchema.parse(binding.value);
    },
  };
}
