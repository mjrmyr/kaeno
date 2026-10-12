// Threads: one durable kaeno conversation per channel key ("pi:<session>", "telegram:<chat>"),
// and the Turn task that submits a message to a thread and delivers the answer, surviving restarts.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry, defineDoc, InboxDoc, LiveDoc,
  type ConversationId, type EntryId, type Harness, type Tx,
} from "@earendil-works/pi-durable";
import { AgentState, textOf } from "./agents.ts";
import type { BoundAgent } from "./agent-factory.ts";
export { defineTurn, admitTurn, TurnLedger, resetEpoch } from "./turns.ts";
export type { Notify, Notifier } from "./turns.ts";

export const Threads = defineDoc<{ threads: Record<string, { conversationId: ConversationId; createdAt: number }> }>({
  kind: "kaeno.threads", version: 1, scope: "session", initial: () => ({ threads: {} }),
});

export type ThreadDeps = { harness: () => Harness; agent: { role?: "chat"; configure: (tx: Tx, id: ConversationId) => Promise<BoundAgent> } };

/** One owner for thread configuration. Busy/queued durable work keeps its old template and skill snapshot. */
async function configureThread(tx: Tx, conversationId: ConversationId, agent: ThreadDeps["agent"], created = false) {
  if (!created) {
    if ((await tx.doc(LiveDoc, conversationId)).run || (await tx.doc(InboxDoc, conversationId)).items.length) return;
    for (const status of ["pending", "running", "waiting", "completing"] as const) {
      const page = await tx.scanTasks({ conversationId, status }, 1000);
      if (page.items.some(t => !t.background || t.kind === "kaeno.turn")) return;
    }
  }
  const bound = await agent.configure(tx, conversationId);
  const state = await tx.doc(AgentState, conversationId);
  state.template = bound.template.name;
  if (agent.role) state.role = agent.role;
  state.skills = bound.skills;
}

/** The conversation for a channel key, created on first use in one commit (so concurrent first messages agree). */
export async function thread({ harness, agent }: ThreadDeps, key: string): Promise<ConversationId> {
  return harness().commit(async tx => {
    const doc = await tx.doc(Threads);
    const found = doc.threads[key];
    if (found) {
      await configureThread(tx, found.conversationId, agent);
      return found.conversationId;
    }
    const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configureThread(tx, created.id, agent, true);
    doc.threads[key] = { conversationId: created.id, createdAt: Date.now() };
    return created.id;
  }, BACKGROUND_CONTEXT);
}

/** Re-apply current templates only to idle threads; active ones refresh on a later idle admission. */
export async function refreshThreads(deps: ThreadDeps) {
  const doc = await deps.harness().snapshot(Threads, BACKGROUND_CONTEXT);
  for (const { conversationId } of Object.values(doc?.threads ?? {})) {
    await deps.harness().commit(tx => configureThread(tx, conversationId, deps.agent), BACKGROUND_CONTEXT);
  }
}

export async function answerText(harness: Harness, answer: EntryId) {
  const entry = await harness.commit(tx => tx.entry(AssistantEntry, answer), BACKGROUND_CONTEXT);
  return textOf(entry?.model?.[0]);
}
