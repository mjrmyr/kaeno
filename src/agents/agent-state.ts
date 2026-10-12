import type { Usage } from "@earendil-works/pi-ai";
import {
  defineDoc,
  type ConversationId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { createHash } from "node:crypto";
import type { Stored } from "../durable/index.ts";
import type { SandboxImages } from "../skills/index.ts";
import {
  storageCopy,
  type BoundAgent,
  type WorkBlueprint,
} from "../work/index.ts";
export interface AgentMetadata {
  template?: string;
  role?: "chat" | "work" | "worker";
  workId?: TaskId;
  blueprint?: Stored<WorkBlueprint>;
  skills?: Stored<BoundAgent["skills"]>;
  sandbox?: {
    pod: string;
    token: string;
    images?: Stored<SandboxImages>;
    skillCacheClaim?: string;
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
  blueprint?: WorkBlueprint;
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
  if (metadata.blueprint) {
    state.blueprint = storageCopy(metadata.blueprint);
  }
}
export interface TextMessage {
  readonly content?:
    | string
    | readonly {
        readonly type: string;
        readonly text?: string;
      }[];
}
export function textOf(message: TextMessage | undefined): string {
  if (typeof message?.content === "string") {
    return message.content.trim();
  }
  return (message?.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
    .join("")
    .trim();
}
export function sumUsage(models: Record<string, Usage>): Usage {
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const model of Object.values(models)) {
    usage.input += model.input;
    usage.output += model.output;
    usage.cacheRead += model.cacheRead;
    usage.cacheWrite += model.cacheWrite;
    usage.totalTokens += model.totalTokens;
    usage.cost.input += model.cost.input;
    usage.cost.output += model.cost.output;
    usage.cost.cacheRead += model.cost.cacheRead;
    usage.cost.cacheWrite += model.cost.cacheWrite;
    usage.cost.total += model.cost.total;
  }
  return usage;
}
export function podName(conversationId: ConversationId): string {
  return `kaeno-sb-${createHash("sha256").update(String(conversationId)).digest("hex").slice(0, 12)}`;
}
