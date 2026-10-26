import { expect, it } from "vitest";
import {
  forgetEntry,
  memoryPrompt,
  saveEntry,
  MAX_ENTRIES,
  MAX_TEXT,
  type MemoryState,
} from "./index.ts";

const day = Date.UTC(2026, 9, 26);

it("saves normalized single-line text and replays a saved call without change", () => {
  const state: MemoryState = { entries: {} };
  saveEntry(state, { id: "m1", text: "  prefers\n German  ", savedAt: day });
  saveEntry(state, { id: "m1", text: "different", savedAt: day + 1 });
  expect(state.entries).toEqual({
    m1: { text: "prefers German", savedAt: day },
  });
});

it("replaces atomically, and a replayed replacement does not fail on the removed ID", () => {
  const state: MemoryState = { entries: {} };
  saveEntry(state, { id: "m1", text: "lives in Berlin", savedAt: day });
  const change = {
    id: "m2",
    text: "lives in Munich",
    savedAt: day,
    replaces: "m1",
  };
  saveEntry(state, change);
  saveEntry(state, change);
  expect(Object.keys(state.entries)).toEqual(["m2"]);
  expect(() =>
    saveEntry(state, { id: "m3", text: "x", savedAt: day, replaces: "m9" }),
  ).toThrow("No memory m9 to replace");
});

it("rejects empty, oversized and over-capacity saves; replacing still works when full", () => {
  const state: MemoryState = { entries: {} };
  expect(() =>
    saveEntry(state, { id: "m0", text: " \n", savedAt: day }),
  ).toThrow("needs text");
  expect(() =>
    saveEntry(state, {
      id: "m0",
      text: "x".repeat(MAX_TEXT + 1),
      savedAt: day,
    }),
  ).toThrow(`at most ${MAX_TEXT}`);
  for (let index = 0; index < MAX_ENTRIES; index++) {
    saveEntry(state, { id: `f${index}`, text: "fact", savedAt: day });
  }
  expect(() =>
    saveEntry(state, { id: "extra", text: "fact", savedAt: day }),
  ).toThrow("Memory is full");
  saveEntry(state, { id: "new", text: "fresh", savedAt: day, replaces: "f0" });
  expect(Object.keys(state.entries)).toHaveLength(MAX_ENTRIES);
});

it("forgets idempotently", () => {
  const state: MemoryState = { entries: { m1: { text: "x", savedAt: day } } };
  expect(forgetEntry(state, "m1")).toBe(true);
  expect(forgetEntry(state, "m1")).toBe(false);
});

it("renders entries oldest first with IDs and dates, and guidance when empty", () => {
  expect(memoryPrompt(undefined)).toContain("Nothing saved yet.");
  const prompt = memoryPrompt({
    entries: {
      m9: { text: "newer", savedAt: day + 86_400_000 },
      m2: { text: "older", savedAt: day },
    },
  });
  expect(prompt).toContain(
    `Saved (2/${MAX_ENTRIES}):\n- m2 (2026-10-26): older\n- m9 (2026-10-27): newer`,
  );
  expect(prompt).toContain("Workers cannot see this memory");
});
