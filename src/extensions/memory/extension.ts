import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import type { KaenoExtension } from "../../core/application/index.ts";
import {
  forgetEntry,
  memoryPrompt,
  readEntries,
  saveEntry,
  LIMITS,
  MEMORY_FORGET,
  MEMORY_READ,
  MEMORY_SAVE,
} from "./memory.ts";
import type { MemoryStore } from "./store.ts";

export const MEMORY_EXTENSION = "kaeno-memory";

/**
 * Owner memory for CHAT, kept in Kaeno's store rather than durable history so forgetting deletes.
 * Save and forget mutate, so the assistant tool policy admits them only on user turns: a work
 * report cannot plant a memory. The host never makes these tools available to workers.
 */
export function memoryExtension(store: MemoryStore): KaenoExtension {
  const save = defineTool({
    name: MEMORY_SAVE,
    description:
      "Save a preference (always applies, shown in full in every thread) or a memory (a fact, listed by title and read on demand).",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("preference"), Type.Literal("memory")]),
      title: Type.Optional(
        Type.String({
          maxLength: LIMITS.memory.title,
          description: "Required for a memory, omitted for a preference",
        }),
      ),
      text: Type.String({ minLength: 1, maxLength: LIMITS.memory.text }),
      replaces: Type.Optional(
        Type.String({ description: "ID of an outdated entry this corrects" }),
      ),
    }),
    replay: "safe",
    execute: async ({ kind, title, text, replaces }, api) => {
      // The tool call is the idempotency key, as for start_work.
      const id = `m${api.taskId}`;
      store.mutate((state) =>
        saveEntry(state, {
          id,
          kind,
          text,
          savedAt: Date.now(),
          ...(title === undefined ? {} : { title }),
          ...(replaces === undefined ? {} : { replaces }),
        }),
      );
      return { content: [{ type: "text", text: `Saved ${id}` }] };
    },
  });
  const forget = defineTool({
    name: MEMORY_FORGET,
    description: "Remove one preference or memory by ID.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    replay: "safe",
    execute: async ({ id }) => {
      const removed = store.mutate((state) => forgetEntry(state, id));
      return {
        content: [
          {
            type: "text",
            text: removed ? `Forgot ${id}` : `${id} is not in memory`,
          },
        ],
      };
    },
  });
  const read = defineTool({
    name: MEMORY_READ,
    description:
      "Read the full text of memories listed by title in your index.",
    parameters: Type.Object({
      ids: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 20,
      }),
    }),
    replay: "safe",
    execute: async ({ ids }) => ({
      content: [{ type: "text", text: readEntries(store.read(), ids) }],
    }),
  });
  return {
    durable: defineExtension({
      name: MEMORY_EXTENSION,
      tools: [save, forget, read],
      sections: [section("memory", () => memoryPrompt(store.read()))],
    }),
    readOnlyTools: [MEMORY_READ],
  };
}
