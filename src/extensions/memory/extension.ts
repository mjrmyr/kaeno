import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
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
  type MemoryState,
} from "./memory.ts";

export const MEMORY_EXTENSION = "kaeno-memory";

/** Session scope: one memory for the owner, independent of threads, resets and WORK. */
export const Memory = defineDoc<MemoryState>({
  kind: "kaeno.memory",
  version: 1,
  scope: "session",
  initial: () => ({ entries: {} }),
});

/**
 * Owner memory for CHAT. Save and forget mutate, so the assistant tool policy admits them only on
 * user turns: a work report cannot plant a memory. Workers are never offered these tools.
 */
export function memoryExtension(): KaenoExtension {
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
    execute: async ({ kind, title, text, replaces }, api, context) => {
      // The tool call is the idempotency key, as for start_work.
      const id = `m${api.taskId}`;
      await api.commit(async (tx) => {
        saveEntry(await tx.doc(Memory), {
          id,
          kind,
          text,
          savedAt: Date.now(),
          ...(title === undefined ? {} : { title }),
          ...(replaces === undefined ? {} : { replaces }),
        });
      }, context);
      return { content: [{ type: "text", text: `Saved ${id}` }] };
    },
  });
  const forget = defineTool({
    name: MEMORY_FORGET,
    description: "Remove one preference or memory by ID.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    replay: "safe",
    execute: async ({ id }, api, context) => {
      const removed = await api.commit(
        async (tx) => forgetEntry(await tx.doc(Memory), id),
        context,
      );
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
    execute: async ({ ids }, api, context) => ({
      content: [
        {
          type: "text",
          text: readEntries(await api.snapshot(Memory, context), ids),
        },
      ],
    }),
  });
  return {
    durable: defineExtension({
      name: MEMORY_EXTENSION,
      tools: [save, forget, read],
      sections: [
        section("memory", async ({ read: reader }, context) =>
          memoryPrompt(await reader.snapshot(Memory, context)),
        ),
      ],
    }),
    readOnlyTools: [MEMORY_READ],
  };
}
