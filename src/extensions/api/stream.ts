import type { ServerResponse } from "node:http";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Kaeno } from "../../core/application/index.ts";
import type { StreamEvent } from "./protocol.ts";

export interface ThreadStreamRequest {
  thread: ConversationId;
  repliesAfter: number;
  watch: readonly ConversationId[];
}

export function streamThread(
  _core: Kaeno,
  _request: ThreadStreamRequest,
  _signal: AbortSignal,
): AsyncIterable<StreamEvent> {
  throw new Error("not implemented");
}

export function writeEventStream(
  _res: ServerResponse,
  _events: AsyncIterable<StreamEvent>,
): Promise<void> {
  throw new Error("not implemented");
}
