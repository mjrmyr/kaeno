import { expect, it } from "vitest";
import {
  forgetEntry,
  memoryIndex,
  memoryPrompt,
  readEntries,
  saveEntry,
  updateEntry,
  LIMITS,
  type MemoryState,
} from "./index.ts";

const day = Date.UTC(2026, 9, 26);

it("saves a one-line preference and replays a saved call without change", () => {
  const state: MemoryState = { entries: {} };
  const change = {
    id: "m1",
    kind: "preference" as const,
    text: "  answer\n in German  ",
    savedAt: day,
  };
  saveEntry(state, change);
  saveEntry(state, { ...change, text: "different", savedAt: day + 1 });
  expect(state.entries).toEqual({
    m1: { kind: "preference", text: "answer in German", savedAt: day },
  });
});

it("requires a title for a memory, forbids one for a preference, and keeps memory text layout", () => {
  const state: MemoryState = { entries: {} };
  expect(() =>
    saveEntry(state, { id: "m1", kind: "memory", text: "x", savedAt: day }),
  ).toThrow("needs a title");
  expect(() =>
    saveEntry(state, {
      id: "m1",
      kind: "preference",
      title: "x",
      text: "x",
      savedAt: day,
    }),
  ).toThrow("has no title");
  saveEntry(state, {
    id: "m2",
    kind: "memory",
    title: " Flat \n lease ",
    text: "Landlord: Ms. Weber\nEnds: 2027-03-31",
    savedAt: day,
  });
  expect(state.entries.m2).toEqual({
    kind: "memory",
    title: "Flat lease",
    text: "Landlord: Ms. Weber\nEnds: 2027-03-31",
    savedAt: day,
  });
});

it("replaces atomically, and a replayed replacement does not fail on the removed ID", () => {
  const state: MemoryState = { entries: {} };
  saveEntry(state, {
    id: "m1",
    kind: "memory",
    title: "Home",
    text: "Berlin",
    savedAt: day,
  });
  const change = {
    id: "m2",
    kind: "memory" as const,
    title: "Home",
    text: "Munich",
    savedAt: day,
    replaces: "m1",
  };
  saveEntry(state, change);
  saveEntry(state, change);
  expect(Object.keys(state.entries)).toEqual(["m2"]);
  expect(() =>
    saveEntry(state, {
      id: "m3",
      kind: "preference",
      text: "x",
      savedAt: day,
      replaces: "m9",
    }),
  ).toThrow("No entry m9 to replace");
});

it("bounds each kind separately; replacing still works when full", () => {
  const state: MemoryState = { entries: {} };
  for (let index = 0; index < LIMITS.preference.entries; index++) {
    saveEntry(state, {
      id: `p${index}`,
      kind: "preference",
      text: "rule",
      savedAt: day,
    });
  }
  expect(() =>
    saveEntry(state, {
      id: "extra",
      kind: "preference",
      text: "rule",
      savedAt: day,
    }),
  ).toThrow("Preferences are full");
  saveEntry(state, {
    id: "fact",
    kind: "memory",
    title: "Still room",
    text: "x",
    savedAt: day,
  });
  saveEntry(state, {
    id: "new",
    kind: "preference",
    text: "fresh",
    savedAt: day,
    replaces: "p0",
  });
  expect(() =>
    saveEntry(state, {
      id: "long",
      kind: "preference",
      text: "x".repeat(LIMITS.preference.text + 1),
      savedAt: day,
    }),
  ).toThrow(`at most ${LIMITS.preference.text}`);
});

it("updates in place keeping the kind, and forgets idempotently", () => {
  const state: MemoryState = {
    entries: { m1: { kind: "memory", title: "A", text: "old", savedAt: day } },
  };
  expect(updateEntry(state, "m1", { title: "B", text: "new" }, day + 1)).toBe(
    true,
  );
  expect(state.entries.m1).toEqual({
    kind: "memory",
    title: "B",
    text: "new",
    savedAt: day + 1,
  });
  expect(updateEntry(state, "m9", { text: "x" }, day)).toBe(false);
  expect(updateEntry(state, "__proto__", { text: "x" }, day)).toBe(false);
  expect(forgetEntry(state, "m1")).toBe(true);
  expect(forgetEntry(state, "m1")).toBe(false);
});

it("indexes preferences in full and memories by title only; reading returns the body", () => {
  const state: MemoryState = {
    entries: {
      m9: { kind: "memory", title: "Lease", text: "SECRET BODY", savedAt: day },
      m2: { kind: "preference", text: "answer in German", savedAt: day },
    },
  };
  expect(memoryIndex(state)).toEqual({
    preferences: [{ id: "m2", text: "answer in German", savedAt: day }],
    memories: [{ id: "m9", title: "Lease", savedAt: day }],
  });
  const prompt = memoryPrompt(state);
  expect(prompt).toContain("Preferences:\n- m2: answer in German");
  expect(prompt).toContain("Memories:\n- m9 (2026-10-26): Lease");
  expect(prompt).not.toContain("SECRET BODY");
  expect(readEntries(state, ["m9", "m4"])).toBe(
    "## m9: Lease\nSECRET BODY\n\n## m4\nNot in memory.",
  );
  expect(memoryPrompt(undefined)).toContain(
    "Preferences:\n(none)\n\nMemories:\n(none)",
  );
});
