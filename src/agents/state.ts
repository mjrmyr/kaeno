import {
  defineDoc,
  type ConversationId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { storageCopy, type BoundAgent } from "../work/index.ts";
import type { SandboxIdentity } from "../sandbox/index.ts";
import type { Stored } from "../work/index.ts";

export interface AgentStateValue {
  template?: string;
  role?: "work";
  workId?: TaskId;
  skills?: Stored<BoundAgent["skills"]>;
  sandbox?: Stored<SandboxIdentity>;
}

export const AgentState = defineDoc<Stored<AgentStateValue>>({
  kind: "kaeno.agent",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

export async function persistAgentBinding(
  tx: Tx,
  id: ConversationId,
  binding: BoundAgent,
  workId: TaskId,
): Promise<void> {
  const state = await tx.doc(AgentState, id);
  state.template = binding.template.name;
  state.skills = storageCopy(binding.skills);
  state.role = "work";
  state.workId = workId;
}
