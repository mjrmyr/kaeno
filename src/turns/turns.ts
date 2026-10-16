// Turn admission, provenance, causal delivery and replayable replies. All channels use this owner.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  defineDoc,
  defineTask,
  LiveDoc,
  type ConversationId,
  type DocumentReader,
  type EntryRecord,
  type Harness,
  type SettledSubmissionRecord,
  type Task,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { requireConversation, type Stored } from "../durable/index.ts";
export interface Notify {
  telegram?: number;
}
export interface Notifier {
  send(notify: Notify, text: string): Promise<void>;
  typing(notify: Notify): Promise<void>;
}
export type Source =
  | {
      kind: "user";
    }
  | {
      kind: "work-result";
      workId: TaskId;
      requestId: string;
      epoch: number;
    };
export interface Origin {
  conversationId: ConversationId;
  requestId: string;
  epoch: number;
  notify: Notify;
}
export interface Reply {
  id: number;
  requestId: string;
  text: string;
  source: Source;
  epoch: number;
}
interface Receipt {
  taskId?: TaskId;
  epoch: number;
  notify: Notify;
  source: Source;
  delivery: "pending" | "dispatching" | "delivered" | "failed" | "cancelled";
  text?: string;
}
interface TurnLedgerState {
  epoch: number;
  control?: TaskId;
  submitting?: TaskId;
  receipts: Record<string, Receipt>;
  suppressed: number[];
  next: number;
  replies: Reply[];
}
export const TurnLedger = defineDoc<Stored<TurnLedgerState>>({
  kind: "kaeno.turn-ledger",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    epoch: 0,
    receipts: {},
    suppressed: [],
    next: 1,
    replies: [],
  }),
});
interface TurnInput {
  conversationId: ConversationId;
  content: string;
  requestId: string;
  notify?: Notify;
  epoch?: number;
  source?: Source;
  report?: string;
}
type TurnState =
  | {
      phase: "run";
    }
  | {
      phase: "notify";
      text: string;
      attempts?: number;
    };
export type TurnTask = Task<Stored<TurnInput>, TurnState, null, object>;
function textOf(entry: EntryRecord | undefined): string {
  const content = entry?.model?.[0]?.content ?? [];
  if (typeof content === "string") {
    return content.trim();
  }
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}
async function settledReplyText(
  tx: Pick<Tx, "entry">,
  settled: SettledSubmissionRecord,
): Promise<string> {
  if (settled.status === "done" && settled.type === "input") {
    return (
      textOf(await tx.entry(AssistantEntry, settled.answer)) || "(empty answer)"
    );
  }
  if (settled.reason === "aborted") {
    return "⏹ Stopped.";
  }
  return `⚠️ Kaeno could not answer: ${settled.reason}`;
}
async function readTurnLedger(
  reader: DocumentReader,
  id: ConversationId,
  ctx: Context,
): Promise<Readonly<Stored<TurnLedgerState>>> {
  const ledger = await reader.snapshot(TurnLedger, id, ctx);
  if (!ledger) {
    throw new Error(`Turn ledger for conversation ${id} is missing`);
  }
  return ledger;
}
/** Admits a task and its immutable route/source before any model can invoke a tool. */
export async function admitTurn(
  tx: Tx,
  Turn: TurnTask,
  input: Omit<TurnInput, "epoch">,
): Promise<TaskId> {
  const ledger = await tx.doc(TurnLedger, input.conversationId);
  if (ledger.control && input.source?.kind !== "work-result") {
    throw new Error("Chat control in progress; retry after it completes");
  }
  const existing = ledger.receipts[input.requestId];
  if (existing?.taskId) {
    const record = await tx.task(existing.taskId);
    const prior = record
      ? z
          .object({
            content: z.string(),
            source: z.object({ kind: z.string() }).optional(),
          })
          .parse(record.input)
      : undefined;
    if (
      prior &&
      (prior.content !== input.content ||
        (prior.source?.kind ?? "user") !== (input.source?.kind ?? "user"))
    ) {
      throw new Error(
        "Request ID already admitted with different content/provenance",
      );
    }
    return existing.taskId;
  }
  if (
    input.source?.kind !== "work-result" &&
    Object.values(ledger.receipts).filter((value) =>
      ["pending", "dispatching"].includes(value.delivery),
    ).length >= 64
  ) {
    throw new Error(
      "This chat has 64 pending replies; wait or stop before adding more",
    );
  }
  const history = Object.entries(ledger.receipts).filter(
    ([, value]) => !["pending", "dispatching"].includes(value.delivery),
  );
  let excess = history.length - 511;
  for (const [key, row] of history) {
    if (excess <= 0) {
      break;
    }
    const task = row.taskId ? await tx.task(row.taskId) : undefined;
    if (!task || task.state.status === "terminal") {
      delete ledger.receipts[key];
      excess--;
    }
  }
  const source = input.source ?? { kind: "user" as const };
  const epoch = source.kind === "work-result" ? source.epoch : ledger.epoch;
  const id = await tx.createTask(
    Turn,
    { ...input, source, epoch },
    {
      ownership: { kind: "conversation" },
      conversationId: input.conversationId,
      background: true,
    },
  );
  ledger.receipts[input.requestId] = {
    taskId: id,
    epoch,
    source,
    notify: input.notify ?? {},
    delivery: "pending",
  };
  return id;
}
/** Origin is resolved from the active submission, never a mutable 'last chat'. */
export async function activeTurn(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<{
  origin: Origin;
  source: Source;
}> {
  const live = await harness.snapshot(LiveDoc, conversationId, context);
  const ledger = await harness.snapshot(TurnLedger, conversationId, context);
  const inputs = live?.run?.inputs ?? [];
  if (inputs.length !== 1) {
    throw new Error("Work controls require one durably admitted turn");
  }
  const submission = await harness.submission(inputs[0], context);
  const record = await submission?.status(context);
  const receipt = record?.requestId
    ? ledger?.receipts[record.requestId]
    : undefined;
  if (!receipt || !record?.requestId) {
    throw new Error("Work controls require a durably admitted turn");
  }
  return {
    origin: {
      conversationId,
      requestId: record.requestId,
      epoch: receipt.epoch,
      notify: receipt.notify,
    },
    source: receipt.source,
  };
}
export async function suppressReports(
  tx: Tx,
  conversationId: ConversationId,
  ids: readonly TaskId[],
): Promise<void> {
  const ledger = await tx.doc(TurnLedger, conversationId);
  for (const id of ids) {
    if (!ledger.suppressed.includes(id)) {
      ledger.suppressed.push(id);
    }
  }
  // Never forget suppression while a WORK or its independently owned report Turn can still dispatch.
  if (ledger.suppressed.length > 1024) {
    const live = new Set<number>(ids);
    for (const status of [
      "pending",
      "running",
      "waiting",
      "completing",
    ] as const) {
      for (const task of (
        await tx.scanTasks({ conversationId, kind: "kaeno.work", status }, 64)
      ).items) {
        live.add(task.id);
      }
      for (const task of (
        await tx.scanTasks({ conversationId, kind: "kaeno.turn", status }, 128)
      ).items) {
        const source = z
          .object({
            source: z
              .object({ kind: z.string(), workId: z.number().optional() })
              .optional(),
          })
          .parse(task.input).source;
        if (source?.kind === "work-result" && source.workId !== undefined) {
          live.add(source.workId);
        }
      }
    }
    ledger.suppressed = ledger.suppressed.filter((id) => live.has(id));
  }
}
interface ControlInput {
  conversationId: ConversationId;
  action: "stop" | "reset" | "cancel";
  workId?: TaskId;
}
export function defineControl(
  harness: () => Harness,
  cancel: (id: ConversationId, workId?: TaskId) => Promise<unknown>,
  cancelPlans: (id: ConversationId) => Promise<void> = async () => {},
): ControlTask {
  return defineTask<
    ControlInput,
    {
      phase: "execute";
    },
    null
  >({
    name: "kaeno.control",
    version: 1,
    initial: () => ({ phase: "execute" }),
    phases: {
      execute: async (task, runtime, context) => {
        if (task.input.action === "cancel") {
          await cancel(task.input.conversationId, task.input.workId);
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: null },
            }),
            context,
          );
          return;
        }
        // The fence was committed at admission. Wait only for native submission admission, never execution.
        for (;;) {
          const ledger = await readTurnLedger(
            runtime,
            task.input.conversationId,
            context,
          );
          if (!ledger.submitting) {
            break;
          }
          const owner = await runtime.getTask(ledger.submitting, context);
          if (!owner || owner.state.status === "terminal") {
            await runtime.commit(async (tx) => {
              delete (await tx.doc(TurnLedger, task.input.conversationId))
                .submitting;
              return undefined;
            }, context);
          } else {
            await runtime.sleep(runtime.now() + 20, context);
          }
        }
        const conversation = await requireConversation(
          harness(),
          task.input.conversationId,
          context,
        );
        await conversation.abort(context); // withdraw inputs submitted before the fence, including queued reports
        if (task.input.action === "reset") {
          await cancelPlans(task.input.conversationId);
          await conversation.reset(undefined, context);
        } else {
          await cancel(task.input.conversationId);
        }
        await runtime.commit(async (tx) => {
          const ledger = await tx.doc(TurnLedger, task.input.conversationId);
          if (ledger.control === task.id) {
            delete ledger.control;
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
        const ledger = await tx.doc(TurnLedger, task.input.conversationId);
        if (ledger.control === task.id) {
          delete ledger.control;
        }
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });
}
export type ControlTask = Task<
  ControlInput,
  {
    phase: "execute";
  },
  null,
  object
>;
export async function admitControl(
  tx: Tx,
  Control: ControlTask,
  conversationId: ConversationId,
  action: "stop" | "reset",
): Promise<TaskId<null>> {
  const ledger = await tx.doc(TurnLedger, conversationId);
  if (ledger.control) {
    throw new Error("Chat control already in progress");
  }
  const id = await tx.createTask(
    Control,
    { conversationId, action },
    { ownership: { kind: "conversation" }, conversationId, background: true },
  );
  ledger.epoch++;
  ledger.control = id;
  return id;
}
export async function admitCancel(
  tx: Tx,
  Control: ControlTask,
  conversationId: ConversationId,
  workId: TaskId,
): Promise<TaskId<null>> {
  const work = await tx.task(workId);
  if (
    !work ||
    work.kind !== "kaeno.work" ||
    work.conversationId !== conversationId
  ) {
    throw new Error("Work is not owned by this chat");
  }
  return tx.createTask(
    Control,
    { conversationId, action: "cancel", workId },
    { ownership: { kind: "conversation" }, conversationId, background: true },
  );
}
export async function resetEpoch(
  harness: Harness,
  conversationId: ConversationId,
  Control: ControlTask,
): Promise<void> {
  const id = await harness.commit(
    (tx) => admitControl(tx, Control, conversationId, "reset"),
    BACKGROUND_CONTEXT,
  );
  await harness.waitForTask(id, BACKGROUND_CONTEXT);
}
/** Definition name/version retained: existing v1 run/notify checkpoints remain executable. */
export function defineTurn(notifier: () => Notifier): TurnTask {
  return defineTask<Stored<TurnInput>, TurnState, null>({
    name: "kaeno.turn",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        const input = task.input;
        const source = input.source ?? { kind: "user" as const };
        // Legacy admitted Turn tasks had no receipt. Record it before their submission starts.
        await runtime.commit(async (tx) => {
          const ledger = await tx.doc(TurnLedger, input.conversationId);
          ledger.receipts[input.requestId] ??= {
            taskId: task.id,
            epoch: input.epoch ?? ledger.epoch,
            notify: input.notify ?? {},
            source,
            delivery: "pending",
          };
          return undefined;
        }, context);
        for (;;) {
          const ledger = await readTurnLedger(
            runtime,
            input.conversationId,
            context,
          );
          if (!ledger.control) {
            break;
          }
          // Recovery may find our abandoned admission permit; the control fence takes precedence.
          if (ledger.submitting === task.id) {
            await runtime.commit(async (tx) => {
              delete (await tx.doc(TurnLedger, input.conversationId))
                .submitting;
              return undefined;
            }, context);
          }
          await runtime.sleep(runtime.now() + 20, context);
        }
        if (source.kind === "work-result") {
          for (;;) {
            const ledger = await readTurnLedger(
              runtime,
              input.conversationId,
              context,
            );
            if (ledger.suppressed.includes(source.workId)) {
              await runtime.commit(async (tx) => {
                (await tx.doc(TurnLedger, input.conversationId)).receipts[
                  input.requestId
                ].delivery = "cancelled";
                return {
                  status: "terminal",
                  outcome: { status: "completed", result: null },
                };
              }, context);
              return;
            }
            if (
              !["pending", "dispatching"].includes(
                ledger.receipts[source.requestId]?.delivery ?? "failed",
              )
            ) {
              break;
            }
            await runtime.sleep(runtime.now() + 200, context);
          }
        }
        const ledger = await readTurnLedger(
          runtime,
          input.conversationId,
          context,
        );
        if (input.epoch !== undefined && input.epoch !== ledger.epoch) {
          if (source.kind !== "work-result") {
            await runtime.commit(async (tx) => {
              (await tx.doc(TurnLedger, input.conversationId)).receipts[
                input.requestId
              ].delivery = "cancelled";
              return {
                status: "terminal",
                outcome: { status: "completed", result: null },
              };
            }, context);
            return;
          }
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: {
                phase: "notify",
                text: `[Work #${source.workId}, started before /new]\n${input.report ?? input.content}`,
              },
            }),
            context,
          );
          return;
        }
        // A short durable permit serializes submit vs control admission. Control waits for it then withdraws all old inputs.
        for (;;) {
          let permitted = false;
          let fenced = false;
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(TurnLedger, input.conversationId);
            fenced =
              !!doc.control ||
              doc.receipts[input.requestId].epoch !== doc.epoch;
            if (fenced) {
              if (doc.submitting === task.id) {
                delete doc.submitting;
              }
            } else if (!doc.submitting || doc.submitting === task.id) {
              doc.submitting = task.id;
              permitted = true;
            }
            return undefined;
          }, context);
          if (fenced) {
            const current = await readTurnLedger(
              runtime,
              input.conversationId,
              context,
            );
            if (current.control) {
              await runtime.sleep(runtime.now() + 20, context);
              continue;
            }
            await runtime.commit(async (tx) => {
              if (source.kind === "work-result") {
                return {
                  status: "running",
                  checkpoint: {
                    phase: "notify",
                    text: `[Work #${source.workId}, started before /new]\n${input.report ?? input.content}`,
                  },
                };
              }
              (await tx.doc(TurnLedger, input.conversationId)).receipts[
                input.requestId
              ].delivery = "cancelled";
              return {
                status: "terminal",
                outcome: { status: "completed", result: null },
              };
            }, context);
            return;
          }
          if (permitted) {
            break;
          }
          await runtime.sleep(runtime.now() + 20, context);
        }
        const conversation = await requireConversation(
          runtime,
          input.conversationId,
          context,
        );
        let submission;
        try {
          submission = await conversation.submit(
            {
              type: "input",
              content: input.content,
              requestId: input.requestId,
              whenBusy: "followUp",
            },
            context,
          );
        } finally {
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(TurnLedger, input.conversationId);
            if (doc.submitting === task.id) {
              delete doc.submitting;
            }
            return undefined;
          }, context);
        }
        const notify = input.notify;
        const typing = notify
          ? setInterval(
              () =>
                void notifier()
                  .typing(notify)
                  .catch(() => {}),
              4500,
            )
          : undefined;
        if (notify) {
          void notifier()
            .typing(notify)
            .catch(() => {});
        }
        let settled;
        try {
          settled = await submission.wait(context);
        } finally {
          clearInterval(typing);
        }
        await runtime.commit(async (tx) => {
          const text = await settledReplyText(tx, settled);
          return { status: "running", checkpoint: { phase: "notify", text } };
        }, context);
      },
      notify: async (task, runtime, context) => {
        const { requestId, conversationId, notify } = task.input;
        const source = task.input.source ?? { kind: "user" as const };
        let dispatch = false;
        let replyText = "";
        // Linearization point: suppression/reset wins before this claim; after it the send is in flight.
        // A pre-upgrade notify checkpoint is also initialized here. Recovery retries a claimed send (at-least-once).
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(TurnLedger, conversationId);
          const row = (doc.receipts[requestId] ??= {
            taskId: task.id,
            epoch: task.input.epoch ?? doc.epoch,
            notify: notify ?? {},
            source,
            delivery: "pending",
          });
          if (["delivered", "failed", "cancelled"].includes(row.delivery)) {
            return {
              status: "terminal",
              outcome: { status: "completed", result: null },
            };
          }
          if (row.delivery !== "dispatching") {
            const suppressed =
              source.kind === "work-result" &&
              doc.suppressed.includes(source.workId);
            if (
              suppressed ||
              (source.kind !== "work-result" && row.epoch !== doc.epoch)
            ) {
              row.delivery = "cancelled";
              return {
                status: "terminal",
                outcome: { status: "completed", result: null },
              };
            }
            row.text =
              source.kind === "work-result" && source.epoch !== doc.epoch
                ? `[Work #${source.workId}, started before /new]\n${task.input.report ?? task.input.content}`
                : task.state.checkpoint.text;
            row.delivery = "dispatching";
          }
          row.text ??= task.state.checkpoint.text;
          replyText = row.text;
          dispatch = true;
          return undefined;
        }, context);
        if (!dispatch) {
          return;
        }
        let failed = false;
        try {
          if (notify) {
            await notifier().send(notify, replyText);
          }
        } catch (error) {
          const attempts = (task.state.checkpoint.attempts ?? 0) + 1;
          if (attempts < 6) {
            runtime.report(error);
            await runtime.sleep(
              runtime.now() + Math.min(30000, 1000 * 2 ** attempts),
              context,
            );
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: { ...task.state.checkpoint, attempts },
              }),
              context,
            );
            return;
          }
          runtime.report(error);
          failed = true;
        }
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(TurnLedger, conversationId);
          const row = (doc.receipts[requestId] ??= {
            taskId: task.id,
            epoch: task.input.epoch ?? doc.epoch,
            notify: notify ?? {},
            source,
            delivery: "pending",
          });
          row.delivery = failed ? "failed" : "delivered";
          row.text = replyText;
          if (!doc.replies.some((value) => value.requestId === requestId)) {
            doc.replies.push({
              id: doc.next++,
              requestId,
              text: row.text,
              source,
              epoch: row.epoch,
            });
            if (doc.replies.length > 500) {
              doc.replies.splice(0, doc.replies.length - 500);
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
        const row = (await tx.doc(TurnLedger, task.input.conversationId))
          .receipts[task.input.requestId];
        if (row) {
          row.delivery = "cancelled";
        }
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });
}
