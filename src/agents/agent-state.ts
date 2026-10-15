import {
  defineDoc,
  type ConversationId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { createHash } from "node:crypto";
import type { Stored } from "../durable/index.ts";
import type { SandboxImages } from "../skills/index.ts";
import { storageCopy, type BoundAgent } from "../work/index.ts";
export interface AgentMetadata {
  template?: string;
  role?: "chat" | "work";
  workId?: TaskId;
  skills?: Stored<BoundAgent["skills"]>;
  sandbox?: {
    pod: string;
    token: string;
    images: Stored<SandboxImages>;
    skillCacheClaim: string;
  };
}
export const AgentState = defineDoc<Stored<AgentMetadata>>({
  kind: "kaeno.agent",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});
export interface BindingMetadata {
  role?: AgentMetadata["role"];
  workId?: TaskId;
}
export async function persistAgentBinding(
  tx: Tx,
  id: ConversationId,
  binding: BoundAgent,
  metadata: BindingMetadata,
): Promise<void> {
  const state = await tx.doc(AgentState, id);
  state.template = binding.template.name;
  state.skills = storageCopy(binding.skills);
  if (metadata.role) {
    state.role = metadata.role;
  }
  if (metadata.workId) {
    state.workId = metadata.workId;
  }
}
export function podName(conversationId: ConversationId): string {
  return `kaeno-sb-${createHash("sha256").update(String(conversationId)).digest("hex").slice(0, 12)}`;
}
