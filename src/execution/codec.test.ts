import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { expect, it, vi } from "vitest";
import { decode, encode } from "./index.ts";
vi.mock("@earendil-works/pi-durable/env", () => {
  class FileError extends Error {
    readonly code: string;
    readonly path: string | undefined;
    constructor(code: string, message: string, path?: string) {
      super(message);
      this.code = code;
      this.path = path;
    }
  }
  class ExecutionError extends Error {
    readonly code: string;
    spillPath: string | undefined;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return { FileError, ExecutionError };
});
it("round-trips nested values, binary bytes, and positional undefined", () => {
  const value = {
    items: [undefined, "text", new Uint8Array([0, 255])],
    nested: { enabled: false },
  };
  expect(decode(encode(value))).toEqual(value);
});
it("preserves typed errors without sending stack traces", () => {
  const value = new FileError("not_found", "missing", "/file");
  expect(decode(encode(value))).toEqual(value);
  expect(JSON.stringify(encode(value))).not.toContain("stack");
  const execution = new ExecutionError("timeout", "timed out");
  execution.spillPath = "/spill";
  expect(decode(encode(execution))).toEqual(execution);
});
it("keeps prototype-named data as data instead of mutating prototypes", () => {
  const value: unknown = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":"data"}',
  );
  const decoded = decode(encode(value));
  expect(decoded).toEqual(value);
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
});
it("turns contexts into transport markers and resolves them at the receiving boundary", () => {
  expect(
    decode(encode(BACKGROUND_CONTEXT), { context: BACKGROUND_CONTEXT }),
  ).toBe(BACKGROUND_CONTEXT);
});
it.each([
  { $b: 42 },
  { $h: { id: "handle", kind: "unknown" } },
  { $cb: -1 },
  { $fe: { code: "unknown-code" } },
])("rejects malformed wire tags (%j)", (value) => {
  expect(() => decode(value)).toThrow();
});
