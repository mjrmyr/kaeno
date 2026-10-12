import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { z } from "zod";
export function conversationId(value: number): ConversationId {
  return z
    .custom<ConversationId>(
      (input) =>
        typeof input === "number" && Number.isSafeInteger(input) && input > 0,
    )
    .parse(value);
}
export function taskId<Result = unknown>(value: number): TaskId<Result> {
  return z
    .custom<TaskId<Result>>(
      (input) =>
        typeof input === "number" && Number.isSafeInteger(input) && input > 0,
    )
    .parse(value);
}
