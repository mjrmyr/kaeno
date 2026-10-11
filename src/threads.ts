// Threads: one durable kaeno conversation per channel key ("pi:<session>", "telegram:<chat>", "schedule:<name>"),
// and the Turn task that submits a message to a thread and delivers the answer, surviving restarts.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry, configure, defineDoc, defineTask, InboxDoc, LiveDoc,
  type AgentChange, type ConversationId, type EntryId, type Harness, type SubmissionDraft, type Tx,
} from "@earendil-works/pi-durable";
import { AgentState, textOf } from "./agents.ts";
import type { SkillBinding } from "./skills.ts";

export const Threads = defineDoc<{ threads: Record<string, { conversationId: ConversationId; createdAt: number }> }>({
  kind: "kaeno.threads", version: 1, scope: "session", initial: () => ({ threads: {} }),
});

export type ThreadDeps = { harness: () => Harness; agent: { template: string; change: () => AgentChange; skills?: () => SkillBinding } };

/** One owner for thread configuration. Busy/queued durable work keeps its old template and skill snapshot. */
async function configureThread(tx: Tx, conversationId: ConversationId, agent: ThreadDeps["agent"], created = false) {
  if (!created) {
    if ((await tx.doc(LiveDoc, conversationId)).run || (await tx.doc(InboxDoc, conversationId)).items.length) return;
    for (const status of ["pending", "running", "waiting"] as const)
      if ((await tx.scanTasks({ conversationId, status }, 1)).items.length) return;
  }
  await configure(tx, conversationId, agent.change());
  const state = await tx.doc(AgentState, conversationId);
  state.template = agent.template;
  state.skills = agent.skills?.() ?? [];
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

export type Notify = { telegram?: number };
export type Notifier = { send(notify: Notify, text: string): Promise<void>; typing(notify: Notify): Promise<void> };

type TurnInput = { conversationId: ConversationId; content: string; requestId: string; notify?: Notify };
type TurnState = { phase: "run" } | { phase: "notify"; text: string };

/** A message to a thread whose answer is delivered somewhere (Telegram). Durable: a restart resumes it, and the
 * request ID makes the resumed submit find the same submission. */
export function defineTurn(notifier: () => Notifier) {
  return defineTask<TurnInput, TurnState, null>({
    name: "kaeno.turn",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        const { conversationId, content, requestId, notify } = task.input;
        const conversation = (await runtime.conversation(conversationId, context))!;
        const draft: SubmissionDraft = { type: "input", content, requestId, whenBusy: "followUp" };
        const submission = await conversation.submit(draft as any, context);
        const typing = notify ? setInterval(() => void notifier().typing(notify).catch(() => {}), 4500) : undefined;
        if (notify) void notifier().typing(notify).catch(() => {});
        let settled;
        try { settled = await submission.wait(context); } finally { clearInterval(typing); }
        await runtime.commit(async tx => {
          const text = settled.status === "done" && settled.type === "input"
            ? textOf((await tx.entry(AssistantEntry, settled.answer))?.model?.[0]) || "(empty answer)"
            : settled.reason === "aborted" ? "⏹ Stopped." : `⚠️ Kaeno could not answer: ${settled.reason}`;
          return { status: "running", checkpoint: { phase: "notify", text } };
        }, context);
      },
      notify: async (task, runtime, context) => {
        if (task.input.notify) await notifier().send(task.input.notify, task.state.checkpoint.text);
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
}
