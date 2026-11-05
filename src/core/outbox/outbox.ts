import type { Context } from "@earendil-works/chord";
import {
  defineDocFamily,
  defineTask,
  type ConversationId,
  type DocumentReader,
  type Task,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Stored } from "../durable/index.ts";

/** Where a thread's messages go. `replyTo` anchors a reply chain on channels that have one. */
export interface ChannelRoute {
  channel: string;
  address: string;
  replyTo?: string;
}
export interface Notifier {
  send(route: ChannelRoute, text: string, thread: string): Promise<void>;
  typing(route: ChannelRoute): Promise<void>;
}
export interface Reply {
  id: number;
  /** The request it answers: the source's request ID for a direct reply, otherwise its own key. */
  requestId: string;
  text: string;
  at: number;
  ticket?: string;
}
interface OutboxState {
  next: number;
  replies: Reply[];
  receipts: Record<string, "dispatching" | "delivered" | "failed">;
}
export const Outbox = defineDocFamily<Stored<OutboxState>, null>({
  kind: "kaeno.outbox",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ next: 1, replies: [], receipts: {} }),
});
export interface DeliveryInput {
  thread: string;
  requestId: string;
  text: string;
  route: ChannelRoute | null;
  ticket: string | null;
}
interface DeliveryState {
  phase: "send";
  attempts?: number;
}
export type DeliveryTask = Task<
  Stored<DeliveryInput>,
  DeliveryState,
  null,
  object
>;
export interface ReplyPage {
  replies: Reply[];
  next: number;
  truncated: boolean;
}

/** Admit a send in the caller's commit. A replayed request ID finds its delivery. */
export async function admitDelivery(
  tx: Tx,
  Delivery: DeliveryTask,
  owner: ConversationId,
  input: DeliveryInput,
): Promise<TaskId | undefined> {
  const outbox = await tx.doc(Outbox, input.thread, null);
  if (outbox.receipts[input.requestId] !== undefined) {
    return undefined;
  }
  outbox.receipts[input.requestId] = "dispatching";
  const keys = Object.keys(outbox.receipts);
  for (const key of keys.slice(0, Math.max(0, keys.length - 1024))) {
    if (outbox.receipts[key] !== "dispatching") {
      delete outbox.receipts[key];
    }
  }
  return tx.createTask(Delivery, input, {
    ownership: { kind: "conversation" },
    conversationId: owner,
    background: true,
  });
}

export async function readReplies(
  reader: DocumentReader,
  thread: string,
  after: number,
  context: Context,
): Promise<ReplyPage> {
  const outbox = await reader.snapshot(Outbox, thread, context);
  const replies = outbox?.replies ?? [];
  const [first] = replies;
  return {
    replies: replies.filter((reply) => reply.id > after),
    next: (outbox?.next ?? 1) - 1,
    truncated: first !== undefined && after < first.id - 1,
  };
}

export function defineDelivery(notifier: () => Notifier): DeliveryTask {
  return defineTask<Stored<DeliveryInput>, DeliveryState, null>({
    name: "kaeno.delivery",
    version: 1,
    initial: () => ({ phase: "send" }),
    phases: {
      send: async (task, runtime, context) => {
        const { thread, requestId, text, route, ticket } = task.input;
        let failed = false;
        if (route) {
          try {
            await notifier().send(route, text, thread);
          } catch (error) {
            const attempts = (task.state.checkpoint.attempts ?? 0) + 1;
            runtime.report(error);
            if (attempts < 6) {
              await runtime.sleep(
                runtime.now() + Math.min(30000, 1000 * 2 ** attempts),
                context,
              );
              await runtime.commit(
                () => ({
                  status: "running",
                  checkpoint: { phase: "send", attempts },
                }),
                context,
              );
              return;
            }
            failed = true;
          }
        }
        await runtime.commit(async (tx) => {
          const outbox = await tx.doc(Outbox, thread, null);
          outbox.receipts[requestId] = failed ? "failed" : "delivered";
          if (!outbox.replies.some((reply) => reply.requestId === requestId)) {
            outbox.replies.push({
              id: outbox.next++,
              requestId,
              text,
              at: runtime.now(),
              ...(ticket === null ? {} : { ticket }),
            });
            if (outbox.replies.length > 500) {
              outbox.replies.splice(0, outbox.replies.length - 500);
            }
          }
          return {
            status: "terminal",
            outcome: { status: "completed", result: null },
          };
        }, context);
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const outbox = await tx.doc(Outbox, task.input.thread, null);
        if (outbox.receipts[task.input.requestId] === "dispatching") {
          outbox.receipts[task.input.requestId] = "failed";
        }
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });
}
