import {
  ExecutionError,
  FileError,
  type Result,
} from "@earendil-works/pi-durable/env";
import { z } from "zod";
const fileResultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.instanceof(FileError) }),
]);
const executionResultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.instanceof(ExecutionError) }),
]);
export const fileInfoSchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "directory", "symlink"]),
  size: z.number(),
  mtimeMs: z.number(),
});
export const lineScanSchema = z.object({
  newlines: z.number(),
  start: z.number(),
  end: z.number(),
  firstLineEnd: z.number(),
  lastLineStart: z.number(),
  selectedBytes: z.number(),
  firstLineBytes: z.number(),
});
export const textLineSchema = z
  .object({ text: z.string(), terminated: z.boolean() })
  .optional();
export const directoryPageSchema = z.object({
  entries: z.array(fileInfoSchema),
  done: z.boolean(),
});
export const shellResultSchema = z.object({
  exitCode: z.number(),
  spillPath: z.string().optional(),
});
export function parseFileResult<T>(
  value: unknown,
  parseValue: (value: unknown) => T,
): Result<T, FileError> {
  const result = fileResultSchema.parse(value);
  if (!result.ok) {
    return result;
  }
  return { ok: true, value: parseValue(result.value) };
}
export function parseExecutionResult<T>(
  value: unknown,
  parseValue: (value: unknown) => T,
): Result<T, ExecutionError> {
  const result = executionResultSchema.parse(value);
  if (!result.ok) {
    return result;
  }
  return { ok: true, value: parseValue(result.value) };
}
