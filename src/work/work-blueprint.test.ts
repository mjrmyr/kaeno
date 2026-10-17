import type { JsonValue } from "@earendil-works/chord";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  frozenEntry,
  immutableCopy,
  readBlueprint,
  sealBlueprint,
  storageCopy,
  type WorkBlueprint,
} from "./index.ts";
vi.mock("@earendil-works/pi-durable", async () => {
  const { createMockSdk } = await import("../../test/mocks/sdk.ts");
  return createMockSdk();
});
vi.mock("../config/index.ts", () => ({
  PROVIDERS: ["anthropic", "openai"],
}));
function payload(): Omit<WorkBlueprint, "digest"> {
  return {
    schema: 2,
    agent: "worker",
    maxDepth: 2,
    templates: {
      worker: {
        template: {
          name: "worker",
          description: "worker",
          model: { provider: "anthropic", modelId: "saved-model" },
          instructions: "saved profile",
          skills: [],
          delegates: ["worker"],
        },
        skills: [],
      },
    },
    images: { execution: "saved-image" },
    skillCacheClaim: "saved-cache",
  };
}
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function rawBlueprint(): Record<string, JsonValue> {
  const raw: unknown = JSON.parse(JSON.stringify(sealBlueprint(payload())));
  return z.record(z.string(), z.json()).parse(raw);
}
function object(value: unknown): Record<string, JsonValue> {
  return z.record(z.string(), z.json()).parse(value);
}
function setTemplateField(
  snapshot: Record<string, JsonValue>,
  field: string,
  value: JsonValue,
): void {
  const templates = object(snapshot.templates);
  const entry = object(templates.worker);
  entry.template = { ...object(entry.template), [field]: value };
  templates.worker = entry;
  snapshot.templates = templates;
}
function forged(
  snapshot: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const { digest: _digest, ...content } = snapshot;
  return {
    ...content,
    digest: createHash("sha256").update(canonical(content)).digest("hex"),
  };
}
it("seals an alias-free, deeply frozen policy and returns independently mutable storage drafts", () => {
  const original = payload();
  const snapshot = sealBlueprint(original);
  expect(frozenEntry(snapshot, "worker").template.delegates).toEqual([
    "worker",
  ]);
  expect(Object.isFrozen(snapshot.templates.worker.template.delegates)).toBe(
    true,
  );
  expect(Reflect.set(snapshot.images, "execution", "changed")).toBe(false);
  const draft = storageCopy(snapshot);
  draft.images.execution = "changed";
  draft.templates.worker.template.delegates.push("other");
  expect(snapshot.images.execution).toBe("saved-image");
  expect(snapshot.templates.worker.template.delegates).toEqual(["worker"]);
  expect(original.templates.worker.template.delegates).toEqual(["worker"]);
});
it("verifies checksums independently of object insertion order", () => {
  const snapshot = sealBlueprint(payload());
  const reversed = Object.fromEntries(
    Object.entries(storageCopy(snapshot)).reverse(),
  );
  expect(readBlueprint(reversed)).toEqual(snapshot);
});
it.each([
  undefined,
  null,
  {},
  { schema: 0, digest: "x" },
  { schema: 1, digest: "x" },
])("rejects missing or unsupported saved policy envelopes (%j)", (value) => {
  expect(() => readBlueprint(value)).toThrow(/frozen policy/);
});
it("detects policy edits before replay and rejects absent targets", () => {
  const draft = storageCopy(sealBlueprint(payload()));
  draft.templates.worker.template.instructions = "changed";
  expect(() => readBlueprint(draft)).toThrow(/integrity/);
  expect(() => frozenEntry(sealBlueprint(payload()), "missing")).toThrow(
    /Missing frozen template/,
  );
});
it.each<[string, (snapshot: Record<string, JsonValue>) => void]>([
  [
    "missing root",
    (snapshot: Record<string, JsonValue>): void => {
      snapshot.agent = "missing";
    },
  ],
  [
    "missing image",
    (snapshot: Record<string, JsonValue>): void => {
      snapshot.images = {};
    },
  ],
  [
    "empty cache claim",
    (snapshot: Record<string, JsonValue>): void => {
      snapshot.skillCacheClaim = "";
    },
  ],
  [
    "template identity",
    (snapshot) => {
      setTemplateField(snapshot, "name", "other");
    },
  ],
  [
    "unknown provider",
    (snapshot) => {
      setTemplateField(snapshot, "model", {
        provider: "unknown",
        modelId: "model",
      });
    },
  ],
  [
    "invalid thinking level",
    (snapshot) => {
      setTemplateField(snapshot, "thinkingLevel", "invalid");
    },
  ],
  [
    "missing delegate",
    (snapshot) => {
      setTemplateField(snapshot, "delegates", ["missing"]);
    },
  ],
  [
    "invalid depth limit",
    (snapshot) => {
      snapshot.maxDepth = 0;
    },
  ],
])(
  "rejects structurally invalid snapshots even with a valid checksum: %s",
  (_name, mutate) => {
    const snapshot = rawBlueprint();
    // Modify a plain JSON boundary value, not private implementation state.
    mutate(snapshot);
    expect(() => readBlueprint(forged(snapshot))).toThrow(
      /Invalid frozen blueprint/,
    );
  },
);
it("makes immutable copies independent of caller-owned data", () => {
  const original = { values: ["original"] };
  const snapshot = immutableCopy(original);
  original.values.push("changed");
  expect(snapshot.values).toEqual(["original"]);
  expect(Object.isFrozen(snapshot.values)).toBe(true);
});
