import type {
  StreamEvent,
  WireReply,
  WorkNode,
} from "../../src/extensions/api/protocol.ts";
import type { ConversationState } from "./conversation.ts";

export interface ThreadState {
  key: string;
  conversation?: number;
  replies: readonly WireReply[];
  after: number;
  work: readonly WorkNode[];
  conversations: Readonly<Record<number, ConversationState>>;
  connection: "connecting" | "live" | "retrying";
}

export function emptyThread(key: string): ThreadState {
  return {
    key,
    replies: [],
    after: 0,
    work: [],
    conversations: {},
    connection: "connecting",
  };
}

export function reduceThread(
  _state: ThreadState,
  _event: StreamEvent,
): ThreadState {
  throw new Error("not implemented");
}

export function findWork(
  _tree: readonly WorkNode[],
  _id: number,
): WorkNode | undefined {
  throw new Error("not implemented");
}
