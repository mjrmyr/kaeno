// Durable WORK representation and consumer-owned contracts. No execution policy lives here.
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineDoc,
  type ConversationId,
  type Harness,
  type JsonObject,
  type Task,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import type { SetupSurface } from "../conversation/index.ts";
import { parseConversationId, type Stored } from "../durable/index.ts";
import type { AgentProfile, WorkEnvironment } from "./plan.ts";
const workParentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ticket"),
    ticket: z.string().regex(/^k[0-9]+$/),
  }),
  z.object({
    kind: z.literal("work"),
    conversationId: z.number().int().positive(),
  }),
]);
export type WorkParent =
  | { kind: "ticket"; ticket: string }
  | { kind: "work"; conversationId: ConversationId };
export const workBriefSchema = z.union([
  z.string(),
  z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("image"),
        data: z.string(),
        mimeType: z.string(),
      }),
    ]),
  ),
]);
export type WorkBrief = z.infer<typeof workBriefSchema>;
export const workConversationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owned") }),
  z.object({
    kind: z.literal("ticket"),
    id: z.number().int().positive(),
  }),
]);
export type WorkConversation = z.infer<typeof workConversationSchema>;
export interface WorkInput extends JsonObject {
  title: string;
  brief: WorkBrief;
  agent: string;
  depth: number;
  maxDepth: number;
  parent: JsonValue;
  plan: JsonValue;
  environment: string | null;
  conversation: WorkConversation;
}
export interface WorkResult {
  status: "completed" | "failed";
  text: string;
}
/**
 * The WORK conversation's newest entry is the supervisor's clock: a new entry after an idle point means a run ended.
 * `awaiting` says why an idle WORK is not finished yet.
 */
export type WorkState =
  | {
      phase: "start";
    }
  | {
      phase: "supervise";
      conversation: ConversationId;
      sent: number;
      seen?: number;
      awaiting?: "children" | "reply";
    }
  | {
      phase: "message";
      conversation: ConversationId;
      sent: number;
      seen: number;
      message: string;
      state: ParentMessage["state"];
    }
  | {
      phase: "report";
      conversation: ConversationId;
      text: string;
      failed: boolean;
    };
export type WorkTaskRuntime = TaskRuntime<
  WorkInput,
  WorkState,
  Stored<WorkResult>,
  object
>;
export interface WorkRuntime extends Pick<
  Harness,
  "snapshot" | "getTask" | "commit" | "abortTask" | "inspect"
> {}
/** Children started by one conversation (CHAT or WORK), keyed by the start_work tool call that admitted them. */
export const WorkIndex = defineDoc<{
  launches: Record<string, TaskId<WorkResult>>;
  /** Durable steering intents, keyed by tool invocation; external dispatch follows this commit. */
  messages?: Record<string, TaskId>;
}>({
  kind: "kaeno.work-index",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ launches: {} }),
});
export interface WorkScopeState extends JsonObject {
  workId: TaskId | null;
  depth: number;
  maxDepth: number | null;
  agent: string | null;
  plan: JsonValue | null;
  /** commands produces; task atomically clears this while recording the message checkpoint. */
  mailbox: ParentMessage | null;
  /**
   * The latest blocking question, kept after delivery so inspection can show it. Steering
   * marks it answered. Scopes stored before questions were recorded lack it; read defensively.
   */
  question: WorkQuestion | null;
  /** The latest nonblocking progress note; may be missing in older scopes too. */
  progress: string | null;
  outcome: "dropped" | null;
}
interface ParentMessage extends JsonObject {
  text: string;
  state: "waiting" | "blocked";
}
interface WorkQuestion extends JsonObject {
  /** The message_parent invocation that asked it; replays keep the same question. */
  id: number;
  text: string;
  askedAt: number;
  answered: boolean;
}
/** A WORK conversation's place in its tree. CHAT conversations keep the initial value (depth 0, no work). */
export const WorkScope = defineDoc<WorkScopeState>({
  kind: "kaeno.work-node",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    workId: null,
    depth: 0,
    maxDepth: null,
    agent: null,
    plan: null,
    mailbox: null,
    question: null,
    progress: null,
    outcome: null,
  }),
});
export interface WorkView {
  id: TaskId;
  title: string;
  agent: string;
  status: string;
}
export interface WorkDetails extends WorkView {
  message?: string;
  pendingQuestion?: { id: number; text: string; askedAt: number };
  progress?: string;
  latest?: string;
  children: WorkView[];
}
/** Core WORK settings supplied by application composition. */
export interface WorkSettings {
  /** Agents WORK may start, fit-checked once when Kaeno opens. */
  agents: readonly AgentProfile[];
  environment?: WorkEnvironment;
  /** Operational failures that do not prevent durable reporting or cleanup retries. */
  onReport?: (error: unknown) => void;
  /** The approved worker surface: tools agents may select, and installed binding owners. */
  surface: () => SetupSurface;
  maxDepth: number;
  /** Unfinished WORK across the whole host; counted inside the admission transaction. */
  maxConcurrent: number;
  /** Unfinished WORK started by one conversation. */
  maxActive?: number;
}
export interface WorkReports {
  report(
    tx: Tx,
    reported: {
      ticket: string;
      workId: TaskId;
      key: string;
      state:
        "progress" | "waiting" | "blocked" | "ready" | "failed" | "dropped";
      text: string;
      handedOff?: boolean;
    },
  ): Promise<void>;
  ended(tx: Tx, ticket: string, workId: TaskId): Promise<void>;
  retainedConversations(context: Context): Promise<ConversationId[]>;
}
export type WorkTask = Task<WorkInput, WorkState, Stored<WorkResult>, object>;
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
export function readParent(value: JsonValue): WorkParent {
  const parent = workParentSchema.parse(value);
  return parent.kind === "ticket"
    ? parent
    : { ...parent, conversationId: parseConversationId(parent.conversationId) };
}
export const checkpointSchema = z.object({
  phase: z.string(),
  conversation: z.number().optional(),
  awaiting: z.string().optional(),
});
