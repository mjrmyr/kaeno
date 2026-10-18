import type { Context } from "@earendil-works/chord";
import type {
  Conversation,
  ConversationHandle,
  ConversationId,
  Harness,
  TaskId,
} from "@earendil-works/pi-durable";
import { z } from "zod";
// Nominal SDK identifiers have no runtime constructor. Validate their wire representation here.
const taskIdSchema = z.custom<TaskId>(
  (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
);
const conversationIdSchema = z.custom<ConversationId>(
  (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
);
export function parseTaskId(value: unknown): TaskId {
  return taskIdSchema.parse(value);
}
export function parseConversationId(value: unknown): ConversationId {
  return conversationIdSchema.parse(value);
}
/** Convert interfaces to the JSON object representation required by the SDK, without casts. */
export type Stored<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends object
    ? {
        -readonly [Key in keyof T]: Stored<T[Key]>;
      }
    : T;
export class HarnessReference {
  private harness: Harness | undefined;
  setHarness(harness: Harness): void {
    if (this.harness) {
      throw new Error("Harness has already been initialized");
    }
    this.harness = harness;
  }
  getHarness = (): Harness => {
    if (!this.harness) {
      throw new Error("Harness is not open yet");
    }
    return this.harness;
  };
}
export interface ConversationReader {
  conversation(
    id: ConversationId,
    ctx: Context,
  ): Promise<ConversationHandle | undefined>;
}
export function requireConversation(
  reader: Pick<Harness, "conversation">,
  id: ConversationId,
  ctx: Context,
): Promise<Conversation>;
export function requireConversation(
  reader: ConversationReader,
  id: ConversationId,
  ctx: Context,
): Promise<ConversationHandle>;
export async function requireConversation(
  reader: ConversationReader,
  id: ConversationId,
  ctx: Context,
): Promise<ConversationHandle> {
  const conversation = await reader.conversation(id, ctx);
  if (!conversation) {
    throw new Error(`Conversation ${id} is missing`);
  }
  return conversation;
}
