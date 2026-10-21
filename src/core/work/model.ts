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
import type { Origin, Source } from "../turns/index.ts";
import type { AgentProfile, WorkEnvironment } from "./plan.ts";
/** Where messages and the final report go. CHAT parents route through the turn ledger; WORK parents get inputs. */
const workParentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("chat"),
    origin: z.object({
      conversationId: z.number().int().positive(),
      requestId: z.string(),
      epoch: z.number().int().nonnegative(),
      notify: z.object({
        route: z
          .object({ channel: z.string(), address: z.string() })
          .optional(),
      }),
    }),
  }),
  z.object({
    kind: z.literal("work"),
    conversationId: z.number().int().positive(),
  }),
]);
export type WorkParent =
  | { kind: "chat"; origin: Origin }
  | { kind: "work"; conversationId: ConversationId };
export interface WorkInput extends JsonObject {
  title: string;
  brief: string;
  agent: string;
  depth: number;
  maxDepth: number;
  parent: JsonValue;
  plan: JsonValue;
  environment: string | null;
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
interface WorkScopeState extends JsonObject {
  workId: TaskId | null;
  depth: number;
  maxDepth: number | null;
  agent: string | null;
  plan: JsonValue | null;
  /** commands produces; task atomically clears this while recording the message checkpoint. */
  message: string | null;
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
    message: null,
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
export interface WorkReport {
  workId: TaskId;
  key: string;
  content: string;
  report: string;
  origin: Extract<WorkParent, { kind: "chat" }>["origin"];
}
export interface WorkTurns {
  getActiveTurn(
    id: ConversationId,
    ctx: Context,
  ): Promise<{
    origin: Extract<WorkParent, { kind: "chat" }>["origin"];
    source: Source;
  }>;
  isOriginFenced(tx: Tx, origin: Origin): Promise<boolean>;
  getPendingReportIds(tx: Tx, id: ConversationId): Promise<TaskId[]>;
  suppressWorkReports(
    tx: Tx,
    id: ConversationId,
    ids: readonly TaskId[],
  ): Promise<void>;
  admitWorkReport(tx: Tx, report: WorkReport): Promise<TaskId>;
  admitWorkCancellation(
    tx: Tx,
    id: ConversationId,
    workId: TaskId,
  ): Promise<TaskId>;
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
  return parent.kind === "chat"
    ? {
        ...parent,
        origin: {
          ...parent.origin,
          conversationId: parseConversationId(parent.origin.conversationId),
        },
      }
    : { ...parent, conversationId: parseConversationId(parent.conversationId) };
}
export const checkpointSchema = z.object({
  phase: z.string(),
  conversation: z.number().optional(),
  awaiting: z.string().optional(),
});
