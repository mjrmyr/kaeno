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
  saveEntry,
  MAX_TEXT,
  MEMORY_FORGET,
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
 * Owner memory for CHAT. Both tools mutate, so the assistant tool policy admits them only on
 * user turns: a work report cannot plant a memory. Workers are never offered them.
 */
export function memoryExtension(): KaenoExtension {
  const save = defineTool({
    name: MEMORY_SAVE,
    description:
      "Save one stable fact or preference about the owner to long-term memory, visible in every thread.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
      replaces: Type.Optional(
        Type.String({ description: "ID of an outdated memory this corrects" }),
      ),
    }),
    replay: "safe",
    execute: async ({ text, replaces }, api, context) => {
      // The tool call is the idempotency key, as for start_work.
      const id = `m${api.taskId}`;
      await api.commit(async (tx) => {
        saveEntry(await tx.doc(Memory), {
          id,
          text,
          savedAt: Date.now(),
          ...(replaces === undefined ? {} : { replaces }),
        });
      }, context);
      return { content: [{ type: "text", text: `Saved ${id}` }] };
    },
  });
  const forget = defineTool({
    name: MEMORY_FORGET,
    description: "Remove one memory by ID.",
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
  return {
    durable: defineExtension({
      name: MEMORY_EXTENSION,
      tools: [save, forget],
      sections: [
        section("memory", async ({ read }, context) =>
          memoryPrompt(await read.snapshot(Memory, context)),
        ),
      ],
    }),
  };
}
