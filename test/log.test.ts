import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log, writeJsonLog } from "../src/log.ts";

type Context = Parameters<typeof log>[3];
const malformed = (value: unknown) => value as Context;

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });
const record = () => {
  expect(console.error).toHaveBeenCalledTimes(1);
  const args = vi.mocked(console.error).mock.calls[0]!;
  expect(args).toHaveLength(1);
  expect(typeof args[0]).toBe("string");
  expect(args[0]).not.toMatch(/[\r\n]/);
  return JSON.parse(args[0]);
};

describe("structured logging", () => {
  it.each(["info", "warn", "error"] as const)("emits %s as one JSON string on stderr only", level => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const before = Date.now();
    log(level, "kaeno", "app.started", { count: 2, enabled: true, absent: null, fixture: "safe\nfixture" });
    const output = record();
    expect(output).toEqual({ type: "app_log", time: expect.any(String), level, component: "kaeno", event: "app.started",
      context: { count: 2, enabled: true, absent: null, fixture: "safe\nfixture" } });
    expect(new Date(output.time).toISOString()).toBe(output.time);
    expect(Date.parse(output.time)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(output.time)).toBeLessThanOrEqual(Date.now());
    expect(stdout).not.toHaveBeenCalled();
  });

  it("filters debug before touching context or error", () => {
    const trap = vi.fn(() => { throw new Error("unsafe fixture"); });
    const context = new Proxy({}, { ownKeys: trap, getPrototypeOf: trap, get: trap });
    log("debug", "kaeno", "fixture.debug", malformed(context), context);
    expect(console.error).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
  });

  it("omits absent or empty optional fields", () => {
    log("info", "kaeno", "fixture.empty", {});
    expect(Object.keys(record()).sort()).toEqual(["component", "event", "level", "time", "type"]);
  });

  it.each([Error, TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError])(
    "normalizes %s without emitting error text or custom properties", Type => {
      const error = new Type("unsafe fixture message\nsecond line");
      Object.assign(error, { name: "unsafe name", code: "unsafe code", cause: { text: "unsafe cause" }, token: "unsafe token" });
      log("error", "harness", "harness.error", {}, error);
      const output = record();
      expect(output.error).toEqual({ kind: Type.name });
      expect(JSON.stringify(output)).not.toContain("unsafe");
    },
  );

  it("normalizes AggregateError without serializing its members", () => {
    log("error", "harness", "harness.error", {}, new AggregateError(["unsafe fixture"], "unsafe fixture"));
    expect(record().error).toEqual({ kind: "AggregateError" });
  });

  it("does not read error properties or call toJSON", () => {
    class CustomError extends Error {}
    const error = new CustomError();
    const read = vi.fn(() => { throw new Error("unsafe fixture"); });
    for (const key of ["name", "message", "stack", "code", "cause", "toJSON"])
      Object.defineProperty(error, key, { get: read });
    log("error", "harness", "harness.error", {}, error);
    expect(record().error).toEqual({ kind: "Error" });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([null, "unsafe thrown string", 42, false, { name: "TypeError", message: "unsafe fixture" }])(
    "classifies non-Error throws as unknown (%j)", error => {
      log("error", "harness", "harness.error", {}, error);
      expect(record().error).toEqual({ kind: "unknown" });
    },
  );

  it("handles a revoked proxy error", () => {
    const proxy = Proxy.revocable({}, {}); proxy.revoke();
    expect(() => log("error", "harness", "harness.error", {}, proxy.proxy)).not.toThrow();
    expect(record().error).toEqual({ kind: "unknown" });
  });

  it("keeps reserved keys nested, including __proto__", () => {
    const context = JSON.parse('{"type":"fixture","time":"fixture","level":"fixture","component":"fixture","event":"fixture","context":"fixture","error":"fixture","__proto__":"fixture"}');
    log("info", "kaeno", "fixture.reserved", context);
    const output = record();
    expect(output.type).toBe("app_log");
    expect(output.time).not.toBe("fixture");
    expect(output.level).toBe("info");
    expect(output.component).toBe("kaeno");
    expect(output.event).toBe("fixture.reserved");
    expect(output.error).toBeUndefined();
    expect(output.context).toEqual(context);
  });

  it("projects only own enumerable finite scalar data properties, without getters or toJSON", () => {
    const toJSON = vi.fn(() => "unsafe fixture");
    const getter = vi.fn(() => "unsafe fixture");
    const context = Object.assign(Object.create({ inherited: "unsafe fixture" }), {
      count: 3, object: { toJSON }, array: ["unsafe fixture"], toJSON, big: 1n,
      symbol: Symbol("unsafe fixture"), missing: undefined, nan: NaN, infinity: Infinity,
    });
    Object.defineProperty(context, "hidden", { value: "unsafe fixture" });
    Object.defineProperty(context, "accessor", { enumerable: true, get: getter });
    log("info", "kaeno", "fixture.projection", context);
    expect(record().context).toEqual({ count: 3 });
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it.each([null, undefined, "unsafe fixture", 42, ["unsafe fixture"]])("ignores malformed context (%j)", context => {
    expect(() => log("warn", "kaeno", "fixture.context", malformed(context))).not.toThrow();
    expect(record().context).toBeUndefined();
  });

  it("ignores revoked proxy context while retaining the event and normalized error", () => {
    const proxy = Proxy.revocable({}, {}); proxy.revoke();
    log("error", "kaeno", "fixture.context", malformed(proxy.proxy), new Error("unsafe fixture"));
    const output = record();
    expect(output.context).toBeUndefined();
    expect(output.error).toEqual({ kind: "Error" });
  });

  it("does not propagate synchronous output failure", () => {
    vi.mocked(console.error).mockImplementation(() => { throw new Error("fixture output failure"); });
    expect(() => log("info", "kaeno", "fixture.output", { count: 1 })).not.toThrow();
  });
});

describe("shared JSON-line emission", () => {
  it("serializes an arbitrary caller-owned record once to the explicit writer", () => {
    const write = vi.fn();
    const input = Object.freeze({ type: "fixture", content: "first\nsecond", nested: { count: 2 } });
    writeJsonLog(input, write);
    expect(write).toHaveBeenCalledExactlyOnceWith(JSON.stringify(input));
    expect(write.mock.calls[0]![0]).not.toMatch(/[\r\n]/);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(["circular", "bigint", "toJSON"])("swallows %s serialization failure without invoking the writer", kind => {
    const input: Record<string, unknown> = kind === "bigint" ? { value: 1n } :
      kind === "toJSON" ? { toJSON() { throw new Error("fixture serialization failure"); } } : {};
    if (kind === "circular") input.self = input;
    const write = vi.fn();
    expect(() => writeJsonLog(input, write)).not.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it("swallows writer failure without retrying or falling back to another stream", () => {
    const write = vi.fn(() => { throw new Error("fixture output failure"); });
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => writeJsonLog({ event: "fixture" }, write)).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });
});
