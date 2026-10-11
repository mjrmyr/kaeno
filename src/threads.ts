// Threads: one durable kaeno conversation per channel key ("pi:<session>", "telegram:<chat>", "schedule:<name>"),
// and the Turn task that submits a message to a thread and delivers the answer, surviving restarts.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry, configure, defineDoc, defineTask, type AgentChange, type ConversationId, type EntryId, type Harness, type SubmissionDraft,
} from "@earendil-works/pi-durable";
import { AgentState, textOf } from "./agents.ts";

export const Threads = defineDoc<{ threads: Record<string, { conversationId: ConversationId; createdAt: number }> }>({
  kind: "kaeno.threads", version: 1, scope: "session", initial: () => ({ threads: {} }),
});

export type ThreadDeps = { harness: () => Harness; agent: { template: string; change: () => AgentChange } };

/** The conversation for a channel key, created on first use in one commit (so concurrent first messages agree). */
export async function thread({ harness, agent }: ThreadDeps, key: string): Promise<ConversationId> {
  return harness().commit(async tx => {
    const doc = await tx.doc(Threads);
    const found = doc.threads[key];
    if (found) return found.conversationId;
    const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, created.id, agent.change());
    (await tx.doc(AgentState, created.id)).template = agent.template;
    doc.threads[key] = { conversationId: created.id, createdAt: Date.now() };
    return created.id;
  }, BACKGROUND_CONTEXT);
}

/** Re-apply the current template to every thread, so config changes (model, instructions, tools) take effect. */
export async function refreshThreads(deps: ThreadDeps) {
  const doc = await deps.harness().snapshot(Threads, BACKGROUND_CONTEXT);
  for (const { conversationId } of Object.values(doc?.threads ?? {})) {
    await (await deps.harness().conversation(conversationId, BACKGROUND_CONTEXT))?.configure(deps.agent.change(), BACKGROUND_CONTEXT);
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
