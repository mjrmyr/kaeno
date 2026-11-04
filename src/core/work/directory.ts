// Read-side projections and WORK tree authorization. No lifecycle mutations.
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  LiveDoc,
  type ConversationId,
  type Cursor,
  type EntryRecord,
  type TaskId,
  type TaskRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { parseConversationId } from "../durable/index.ts";
import {
  WorkIndex,
  WorkScope,
  checkpointSchema,
  workConversationSchema,
  type WorkDetails,
  type WorkRuntime,
  type WorkView,
} from "./model.ts";
const LIVE = ["pending", "running", "waiting", "completing"] as const;
const workInputSchema = z.object({ title: z.string(), agent: z.string() });
const resultSchema = z.object({ status: z.string() });
/** Text projection only: task.ts owns whether a response is a final answer. */
export function assistantText(entry: EntryRecord): string | undefined {
  if (entry.kind !== AssistantEntry.kind) {
    return undefined;
  }
  const content = entry.model?.[0]?.content ?? [];
  const text =
    typeof content === "string"
      ? content
      : content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("");
  return text.trim() || undefined;
}
async function latestAnswer(
  tx: Tx,
  conversationId: ConversationId,
): Promise<string | undefined> {
  const { items } = await tx.scanEntries({ conversationId }, 64);
  for (const entry of items) {
    const text = assistantText(entry);
    if (text !== undefined) {
      return text.slice(0, 64000);
    }
  }
  return undefined;
}
export async function workConversation(
  tx: Tx,
  record: { id: TaskId; input: unknown },
): Promise<ConversationId | undefined> {
  const saved = z
    .object({ conversation: workConversationSchema })
    .safeParse(record.input);
  if (saved.success && saved.data.conversation.kind === "ticket") {
    return parseConversationId(saved.data.conversation.id);
  }
  return (await tx.scanConversations({ ownerTaskId: record.id }, 1)).items[0]
    ?.id;
}
/** Unfinished WORK started by one conversation, or by anyone when no conversation is given. */
export async function liveWork(
  tx: Tx,
  conversationId?: ConversationId,
): Promise<TaskId[]> {
  const ids: TaskId[] = [];
  for (const status of LIVE) {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks(
        { conversationId, kind: "kaeno.work", status },
        256,
        cursor,
      );
      ids.push(...page.items.map((task) => task.id));
      cursor = page.next;
    } while (cursor !== undefined);
  }
  return ids;
}
/** User-facing status from the durable task record alone. */
function describeWork(
  record: TaskRecord<JsonValue, JsonValue, unknown>,
): string {
  const state = record.state;
  if (state.status === "terminal") {
    return state.outcome.status === "completed"
      ? resultSchema.parse(state.outcome.result).status
      : state.outcome.status;
  }
  if (record.abortRequested) {
    return "cancelling";
  }
  const checkpoint = checkpointSchema.safeParse(
    "checkpoint" in state ? state.checkpoint : undefined,
  );
  if (!checkpoint.success) {
    return state.status;
  }
  if (
    checkpoint.data.phase === "message" ||
    checkpoint.data.awaiting === "reply"
  ) {
    return "awaiting-reply";
  }
  if (checkpoint.data.awaiting === "children") {
    return "waiting-for-children";
  }
  return checkpoint.data.phase === "start" ? "starting" : "running";
}
export async function listWork(
  harness: () => WorkRuntime,
  conversationId: ConversationId,
): Promise<WorkView[]> {
  const index = await harness().snapshot(
    WorkIndex,
    conversationId,
    BACKGROUND_CONTEXT,
  );
  const result: WorkView[] = [];
  for (const id of Object.values(index?.launches ?? {})) {
    const view = await viewWork(harness, id);
    if (view) {
      result.push(view);
    }
  }
  return result;
}
async function viewWork(
  harness: () => WorkRuntime,
  id: TaskId,
): Promise<WorkView | undefined> {
  const record = await harness().getTask(id, BACKGROUND_CONTEXT);
  if (!record) {
    return undefined;
  }
  const input = workInputSchema.parse(record.input);
  return {
    id,
    title: input.title,
    agent: input.agent,
    status: await refineStatus(harness, record, describeWork(record)),
  };
}
/**
 * A waiting checkpoint changes only when supervision next sees an idle point. Until then, a
 * live run is working again and an answered question is about to resume.
 */
async function refineStatus(
  harness: () => WorkRuntime,
  record: TaskRecord<JsonValue, JsonValue, unknown>,
  status: string,
): Promise<string> {
  if (status !== "awaiting-reply" && status !== "waiting-for-children") {
    return status;
  }
  const checkpoint = checkpointSchema.safeParse(
    "checkpoint" in record.state ? record.state.checkpoint : undefined,
  );
  if (!checkpoint.success || checkpoint.data.conversation === undefined) {
    return status;
  }
  const conversation = z
    .custom<ConversationId>((value) => typeof value === "number")
    .parse(checkpoint.data.conversation);
  if (
    (await harness().snapshot(LiveDoc, conversation, BACKGROUND_CONTEXT))?.run
  ) {
    return "running";
  }
  const scope = await harness().snapshot(
    WorkScope,
    conversation,
    BACKGROUND_CONTEXT,
  );
  return status === "awaiting-reply" && scope?.question?.answered
    ? "resuming"
    : status;
}
export async function inspectWork(
  harness: () => WorkRuntime,
  caller: ConversationId,
  id: TaskId,
  context: Context,
): Promise<WorkDetails> {
  // Authorization: walk up the tree from the target until the caller's conversation is reached.
  const target = await harness().getTask(id, context);
  let owner = target?.kind === "kaeno.work" ? target.conversationId : undefined;
  for (let level = 0; owner !== caller; level++) {
    const scope =
      owner === undefined || level > 16
        ? undefined
        : await harness().snapshot(WorkScope, owner, context);
    if (!scope || scope.workId === null) {
      throw new Error(`Work #${id} is not below this conversation`);
    }
    owner = (await harness().getTask(scope.workId, context))?.conversationId;
  }
  const view = await viewWork(harness, id);
  if (!view) {
    throw new Error(`Work #${id} is missing`);
  }
  const conversationId = target
    ? await harness().commit((tx) => workConversation(tx, target), context)
    : undefined;
  if (conversationId === undefined) {
    return { ...view, children: [] };
  }
  const conversation = { id: conversationId };
  const scope = await harness().snapshot(WorkScope, conversation.id, context);
  const latest = await harness().commit(
    (tx) => latestAnswer(tx, conversation.id),
    context,
  );
  // Supervision clears the mailbox when it records the message; the question outlives that.
  const question =
    view.status === "awaiting-reply" && scope?.question?.answered === false
      ? scope.question
      : undefined;
  return {
    ...view,
    message: question?.text ?? scope?.mailbox?.text ?? undefined,
    pendingQuestion: question && {
      id: question.id,
      text: question.text,
      askedAt: question.askedAt,
    },
    progress: scope?.progress ?? undefined,
    latest: latest?.slice(0, 4000),
    children: await listWork(harness, conversation.id),
  };
}
export async function requireChild(
  harness: () => WorkRuntime,
  caller: ConversationId,
  id: TaskId,
  context: Context,
): Promise<{ conversation?: ConversationId }> {
  const record = await harness().getTask(id, context);
  if (
    !record ||
    record.kind !== "kaeno.work" ||
    record.conversationId !== caller
  ) {
    throw new Error(`Work #${id} was not started here`);
  }
  if (record.state.status === "terminal" || record.abortRequested) {
    throw new Error(`Work #${id} has already finished`);
  }
  const checkpoint = checkpointSchema.safeParse(
    "checkpoint" in record.state ? record.state.checkpoint : undefined,
  );
  if (
    !checkpoint.success ||
    !["supervise", "message"].includes(checkpoint.data.phase)
  ) {
    return {};
  }
  const conversation = z
    .custom<ConversationId>((value) => typeof value === "number")
    .parse(checkpoint.data.conversation);
  // A message must never overtake the brief: the conversation is open once the brief was admitted.
  const briefed = await harness().commit(
    (tx) => tx.submissionByRequest(conversation, `work:${id}`),
    context,
  );
  return briefed ? { conversation } : {};
}
