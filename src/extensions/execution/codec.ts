import type { Context } from "@earendil-works/chord";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { z } from "zod";
export interface WireCallback {
  invoke(args: unknown[]): unknown;
}
export interface Handle {
  id: string;
  kind: "textLineReader" | "binaryReader" | "dirReader" | "fileWatcher";
  mode?: "native" | "polling";
}
export interface DecodeHooks {
  callback?: (id: number) => WireCallback;
  context?: Context;
  handle?: (handle: Handle) => unknown;
}
const handleSchema = z.object({
  id: z.string(),
  kind: z.enum(["textLineReader", "binaryReader", "dirReader", "fileWatcher"]),
  mode: z.enum(["native", "polling"]).optional(),
});
const fileErrorSchema = z.object({
  code: z.enum([
    "aborted",
    "not_found",
    "permission_denied",
    "not_directory",
    "is_directory",
    "invalid",
    "not_supported",
    "unknown",
  ]),
  message: z.string(),
  path: z.string().nullable().optional(),
});
const executionErrorSchema = z.object({
  code: z.enum([
    "aborted",
    "timeout",
    "shell_unavailable",
    "spawn_error",
    "callback_error",
    "unknown",
  ]),
  message: z.string(),
  spillPath: z.string().nullable().optional(),
});
export function encode(
  value: unknown,
  onFunction?: (callback: WireCallback) => number,
): unknown {
  if (value === undefined) {
    return { $u: 1 };
  }
  if (value instanceof Uint8Array) {
    return {
      $b: Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      ).toString("base64"),
    };
  }
  if (value instanceof FileError) {
    return {
      $fe: {
        code: value.code,
        message: value.message,
        path: value.path ?? null,
      },
    };
  }
  if (value instanceof ExecutionError) {
    return {
      $ee: {
        code: value.code,
        message: value.message,
        spillPath: value.spillPath ?? null,
      },
    };
  }
  if (value instanceof Error) {
    return { $err: value.message };
  }
  if (
    value &&
    typeof value === "object" &&
    "abortSignal" in value &&
    "value" in value &&
    typeof value.value === "function"
  ) {
    return { $ctx: 1 };
  }
  if (typeof value === "function") {
    if (!onFunction) {
      throw new Error("Cannot send a function");
    }
    return {
      $cb: onFunction({
        invoke: (args) => Reflect.apply(value, undefined, args),
      }),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => encode(item, onFunction));
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        Object.defineProperty(output, key, {
          value: encode(item, onFunction),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return output;
  }
  return value;
}
export function decode(value: unknown, hooks: DecodeHooks = {}): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => decode(item, hooks));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if ("$u" in value) {
    return undefined;
  }
  if ("$b" in value) {
    return new Uint8Array(Buffer.from(z.string().parse(value.$b), "base64"));
  }
  if ("$fe" in value) {
    const error = fileErrorSchema.parse(value.$fe);
    return new FileError(error.code, error.message, error.path ?? undefined);
  }
  if ("$ee" in value) {
    const details = executionErrorSchema.parse(value.$ee);
    const error = new ExecutionError(details.code, details.message);
    if (details.spillPath) {
      error.spillPath = details.spillPath;
    }
    return error;
  }
  if ("$err" in value) {
    return new Error(z.string().parse(value.$err));
  }
  if ("$ctx" in value) {
    return hooks.context;
  }
  if ("$cb" in value) {
    if (!hooks.callback) {
      throw new Error("Unexpected callback");
    }
    const callback = hooks.callback(
      z.number().int().nonnegative().parse(value.$cb),
    );
    return (...args: unknown[]): unknown => callback.invoke(args);
  }
  if ("$h" in value) {
    if (!hooks.handle) {
      throw new Error("Unexpected handle");
    }
    return hooks.handle(handleSchema.parse(value.$h));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(output, key, {
      value: decode(item, hooks),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}
