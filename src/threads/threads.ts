import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  InboxDoc,
  LiveDoc,
  type ConversationId,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Stored } from "../durable/index.ts";
interface ThreadState {
  threads: Record<
    string,
    {
      conversationId: ConversationId;
      createdAt: number;
    }
  >;
}
export interface ThreadRuntime extends Pick<Harness, "commit" | "snapshot"> {}
export const Threads = defineDoc<Stored<ThreadState>>({
  kind: "kaeno.threads",
  version: 1,
  scope: "session",
  initial: () => ({ threads: {} }),
});
/** Threads owns this contract. Agent supplies configuration and persists its own metadata. */
export interface ChatAgent {
  configureChatConversation(tx: Tx, id: ConversationId): Promise<void>;
}
export interface ThreadInfo {
  key: string;
  conversationId: ConversationId;
  createdAt: number;
}
export class ThreadDirectory {
  private readonly harness: () => ThreadRuntime;
  private readonly agent: ChatAgent;
  constructor(harness: () => ThreadRuntime, agent: ChatAgent) {
    this.harness = harness;
    this.agent = agent;
  }
  private async configureIdleConversation(
    tx: Tx,
    id: ConversationId,
    created = false,
  ): Promise<void> {
    if (!created) {
      if (
        (await tx.doc(LiveDoc, id)).run ||
        (await tx.doc(InboxDoc, id)).items.length > 0
      ) {
        return;
      }
      for (const status of [
        "pending",
        "running",
        "waiting",
        "completing",
      ] as const) {
        const page = await tx.scanTasks({ conversationId: id, status }, 1000);
        if (
          page.items.some(
            (task) => !task.background || task.kind === "kaeno.turn",
          )
        ) {
          return;
        }
      }
    }
    await this.agent.configureChatConversation(tx, id);
  }
  getOrCreateConversation(key: string): Promise<ConversationId> {
    return this.harness().commit(async (tx) => {
      const state = await tx.doc(Threads);
      const existing = state.threads[key];
      if (existing) {
        await this.configureIdleConversation(tx, existing.conversationId);
        return existing.conversationId;
      }
      const created = await tx.createConversation({
        ownership: { kind: "ownerless" },
      });
      await this.configureIdleConversation(tx, created.id, true);
      state.threads[key] = {
        conversationId: created.id,
        createdAt: Date.now(),
      };
      return created.id;
    }, BACKGROUND_CONTEXT);
  }
  async listConversations(): Promise<ThreadInfo[]> {
    const state = await this.harness().snapshot(Threads, BACKGROUND_CONTEXT);
    return Object.entries(state?.threads ?? {}).map(([key, entry]) => ({
      key,
      ...entry,
    }));
  }
  async refreshIdleConversations(): Promise<void> {
    const state = await this.harness().snapshot(Threads, BACKGROUND_CONTEXT);
    for (const { conversationId } of Object.values(state?.threads ?? {})) {
      await this.harness().commit(
        (tx) => this.configureIdleConversation(tx, conversationId),
        BACKGROUND_CONTEXT,
      );
    }
  }
}
