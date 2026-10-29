import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  EntryRecord,
  JsonObject,
} from "@earendil-works/pi-durable";

export interface ToolRun {
  id: string;
  name: string;
  args: JsonObject;
  output: string;
  done: boolean;
}

export interface ConversationState {
  entries: readonly EntryRecord[];
  partial?: AssistantMessage;
  tools: Readonly<Record<string, ToolRun>>;
  running: boolean;
}

export const emptyConversation: ConversationState = {
  entries: [],
  tools: {},
  running: false,
};

export function applyAgentEvent(
  _state: ConversationState,
  _event: AgentEvent,
): ConversationState {
  throw new Error("not implemented");
}
