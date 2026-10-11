import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { matches, parseCron, zoned } from "../src/cron.ts";

const base = {
  agent: "kaeno",
  templates: {
    kaeno: { description: "d", model: "anthropic/claude-sonnet-5-5", instructions: "i", delegates: ["worker"] },
    worker: { description: "d", model: "openai/gpt-5.4-mini", instructions: "i", sandbox: true, tools: ["bash", "read"] },
  },
};

describe("config", () => {
  it("parses templates with per-template models", () => {
    const c = parseConfig(base);
    expect(c.templates.worker!.model).toEqual({ provider: "openai", modelId: "gpt-5.4-mini" });
    expect(c.templates.kaeno!.sandbox).toBe(false);
  });
  it("rejects unknown providers, unknown delegates, and coding tools outside a sandbox", () => {
    expect(() => parseConfig({ ...base, templates: { ...base.templates, kaeno: { ...base.templates.kaeno, model: "faux/x" } } })).toThrow(/model/);
    expect(() => parseConfig({ ...base, templates: { ...base.templates, kaeno: { ...base.templates.kaeno, delegates: ["nope"] } } })).toThrow(/unknown template nope/);
    expect(() => parseConfig({ ...base, templates: { ...base.templates, kaeno: { ...base.templates.kaeno, tools: ["bash"] } } })).toThrow(/sandbox/);
  });
  it("validates schedules at load time", () => {
    expect(() => parseConfig({ ...base, schedules: [{ name: "x", cron: "61 * * * *", prompt: "p" }] })).toThrow(/out of range/);
    expect(() => parseConfig({ ...base, schedules: [{ name: "x", cron: "* * * * *", prompt: "p", timezone: "Mars/Base" }] })).toThrow();
  });
});

describe("cron", () => {
  const at = (iso: string, tz = "Europe/Berlin") => zoned(new Date(iso), tz);
  it("matches in the schedule's time zone", () => {
    expect(matches(parseCron("0 7 * * *"), at("2026-10-12T05:00:00Z"))).toBe(true);  // 07:00 CEST
    expect(matches(parseCron("0 7 * * *"), at("2026-10-12T07:00:00Z"))).toBe(false);
  });
  it("supports lists, ranges, steps and weekday 7 = Sunday", () => {
    const c = parseCron("*/15 9-17 * * 1-5");
    expect(matches(c, at("2026-10-12T07:30:00Z"))).toBe(true);  // Mon 09:30
    expect(matches(c, at("2026-10-11T07:30:00Z"))).toBe(false); // Sun
    expect(matches(parseCron("0 12 * * 7"), at("2026-10-11T10:00:00Z"))).toBe(true);
  });
  it("ORs day-of-month and day-of-week when both are restricted", () => {
    const c = parseCron("0 8 1 * 1");
    expect(matches(c, at("2026-10-12T06:00:00Z"))).toBe(true); // a Monday
    expect(matches(c, at("2026-10-01T06:00:00Z"))).toBe(true); // the 1st
  });
});
