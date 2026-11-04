// Router domain records: Triggers, Threads and Tickets. The Engine is their only writer.
import {
  defineDoc,
  defineDocFamily,
  type UserInput,
} from "@earendil-works/pi-durable";
import type { Stored } from "../durable/index.ts";
import type { ChannelRoute } from "../outbox/index.ts";

/** `owner` comes from the owner's own message or an owner-approved routine; nothing else may mutate. */
export type Authority = "owner" | "none";
/**
 * The programmatic gate's answer per source (Fast Path filtering): `explicit` requests always reach the router,
 * `candidate` events reach it only to be judged against written policies, `ignore` is recorded and dropped.
 */
export type GateMode = "explicit" | "candidate" | "ignore";

/** An event as a source reports it. */
export interface TriggerDraft {
  /** Source-scoped idempotency key, for example `telegram:<update_id>`. */
  key: string;
  source: string;
  /** Thread keys this event belongs to; the first is primary. */
  threads: string[];
  actor: string;
  authority: Authority;
  content: UserInput;
  /** Where a direct reply goes, including the message it answers. */
  route?: ChannelRoute;
  /** A client's request ID, echoed on the direct reply so a waiting client can find it. */
  requestId?: string;
  /** A short quote of the message this one replies to. */
  quote?: string;
}
export type DispositionKind =
  "reply" | "accept" | "attach" | "ignore" | "passed" | "filtered" | "unrouted";
export interface Disposition {
  kind: DispositionKind;
  tickets?: string[];
  at: number;
}
export interface TriggerRecord extends TriggerDraft {
  id: string;
  at: number;
  mode: GateMode;
  disposition?: Disposition;
}
export interface ThreadRecord {
  key: string;
  createdAt: number;
  lastAt: number;
  /** Where messages to this thread go; absent until a source names one. */
  route?: ChannelRoute;
  /** Tickets that follow this thread: its events pass straight through to them. */
  subscribers: string[];
  /** Newest last, bounded. */
  recent: string[];
}
export type TicketStatus = "queued" | "running" | "idle" | "ended";
export type ReportState =
  "progress" | "waiting" | "blocked" | "ready" | "failed" | "dropped";
export const FINAL_REPORTS: readonly ReportState[] = [
  "ready",
  "failed",
  "dropped",
];
export interface TicketInput {
  id: string;
  /** The trigger this input carries, if any. */
  trigger?: string;
  /** Text from the router or the host. */
  text?: string;
}
export interface TicketReport {
  state: ReportState;
  summary: string;
  at: number;
}
export interface TicketRecord {
  id: string;
  title: string;
  agent: string;
  createdAt: number;
  updatedAt: number;
  /** The trigger that started it. */
  origin: string;
  /** The worker conversation every Assignment continues. */
  conversation: number;
  /** Subscribed threads, own thread first. */
  threads: string[];
  /** Where relays go when the ticket has no own thread. */
  replyThread: string;
  status: TicketStatus;
  /** One per WORK run, newest last. */
  assignments: { workId: number; startedAt: number; endedAt?: number }[];
  /** Inputs waiting for the next Assignment. */
  pending: TicketInput[];
  /** Newest last, bounded. */
  reports: TicketReport[];
  ended?: { at: number; by: "owner" | "worker" | "host"; reason: string };
}
export interface RouterState {
  conversation: number | null;
  nextTrigger: number;
  nextTicket: number;
  /** Tickets that are not ended, oldest first. */
  open: string[];
  /** Tickets waiting for a worker slot; wakes for an owner input go first. */
  queue: string[];
  /** Newest last, bounded: what `recall` lists when asked for recent events. */
  recent: string[];
}

export const RouterDoc = defineDoc<Stored<RouterState>>({
  kind: "kaeno.router",
  version: 1,
  scope: "session",
  initial: () => ({
    conversation: null,
    nextTrigger: 1,
    nextTicket: 1,
    open: [],
    queue: [],
    recent: [],
  }),
});
function missing(kind: string): never {
  throw new Error(`Unknown ${kind}`);
}
/** One member per trigger ID (`t<n>`). Reading an absent member without a seed fails the commit. */
export const TriggerDoc = defineDocFamily<
  Stored<TriggerRecord>,
  Stored<TriggerRecord> | null
>({
  kind: "kaeno.trigger",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed ?? missing("trigger"),
});
/** One member per source key: deduplicates redelivered events. */
export const TriggerKeyDoc = defineDocFamily<{ id: string | null }, null>({
  kind: "kaeno.trigger-key",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ id: null }),
});
/** One member per thread key. */
export const ThreadDoc = defineDocFamily<Stored<ThreadRecord>, string>({
  kind: "kaeno.thread",
  version: 1,
  scope: "session",
  family: true,
  initial: (key) => ({
    key,
    createdAt: 0,
    lastAt: 0,
    subscribers: [],
    recent: [],
  }),
});
/** One member per ticket ID (`k<n>`). Reading an absent member without a seed fails the commit. */
export const TicketDoc = defineDocFamily<
  Stored<TicketRecord>,
  Stored<TicketRecord> | null
>({
  kind: "kaeno.ticket",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed ?? missing("ticket"),
});

export const LIMITS = {
  recentThread: 50,
  recentRouter: 200,
  reports: 20,
  assignments: 50,
  pending: 32,
  /** Idle tickets stop following their threads after this long. */
  followMs: 14 * 24 * 60 * 60_000,
  text: 4000,
  textMax: 8000,
  list: 20,
  listMax: 50,
  stub: 50,
  near: 1200,
  mid: 400,
} as const;

export function latestReport(
  ticket: Readonly<Stored<TicketRecord>>,
): Readonly<Stored<TicketReport>> | undefined {
  return ticket.reports.at(-1);
}
/** Display state: a running ticket whose latest report asks something waits for a person. */
export function ticketState(ticket: Readonly<Stored<TicketRecord>>): string {
  const report = latestReport(ticket);
  if (
    ticket.status === "running" &&
    (report?.state === "waiting" || report?.state === "blocked")
  ) {
    return report.state;
  }
  if (ticket.status === "idle" && report) {
    return `idle, ${report.state}`;
  }
  return ticket.status;
}
