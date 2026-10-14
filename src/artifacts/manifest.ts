import { z } from "zod";
import { CAPTURE_ROOTS } from "./blacklist.ts";

const manifestSchema = z.strictObject({
  workId: z.number().int().safe().positive(),
  taskId: z.number().int().safe().positive(),
  conversationId: z.number().int().safe().positive(),
  pod: z.string().min(1),
  template: z.string().min(1),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  roots: z.array(z.enum(CAPTURE_ROOTS)),
  capture: z.strictObject({
    truncated: z.boolean(),
    bytes: z.number().int().nonnegative(),
    skippedByBlacklist: z.number().int().nonnegative(),
    /** Set when the capture stream died mid-run; evidence is partial. */
    error: z.string().optional(),
  }),
  envdLog: z.boolean(),
  podLog: z.boolean(),
});

export interface RunManifest {
  workId: number;
  taskId: number;
  conversationId: number;
  pod: string;
  template: string;
  createdAt: string;
  finishedAt: string | null;
  roots: (typeof CAPTURE_ROOTS)[number][];
  capture: {
    truncated: boolean;
    bytes: number;
    skippedByBlacklist: number;
    error?: string;
  };
  envdLog: boolean;
  podLog: boolean;
}

export function parseManifest(raw: unknown): RunManifest {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid run manifest: ${parsed.error.message}`);
  }
  return parsed.data;
}
