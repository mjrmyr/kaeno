import {
  defineDoc,
  defineDocFamily,
  type UserInput,
} from "@earendil-works/pi-durable";
import type { Stored } from "../durable/index.ts";
import type { ChannelRoute } from "../outbox/index.ts";

/**
 * `owner` comes from the owner's own message or an owner-approved routine; nothing else may mutate. `system` is a
 * source's verified verdict that one of the owner's systems sent the event: it may reach and wake a worker, but
 * grants nothing. `none` never reaches a worker.
 */
export type Authority = "owner" | "system" | "none";
/**
 * The programmatic gate's answer per source (Fast Path filtering): `explicit` requests always reach the router,
 * `candidate` events reach it only to be judged against written policies, `ignore` is recorded and dropped.
 */
export type GateMode = "explicit" | "candidate" | "ignore";

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
  route?: ChannelRoute;
  subscribers: string[];
  recent: string[];
}
export type TicketStatus = "queued" | "running" | "idle" | "ended";
export type ReportState =
  "progress" | "waiting" | "blocked" | "ready" | "failed" | "dropped" | "quiet";
export const FINAL_REPORTS: readonly ReportState[] = [
  "ready",
  "failed",
  "dropped",
  "quiet",
];
export interface TicketInput {
  id: string;
  trigger?: string;
  text?: string;
  system?: boolean;
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
  origin: string;
  conversation: number;
  ownThread: string | null;
  followed: string[];
  replyThread: string;
  status: TicketStatus;
  assignments: {
    workId: number;
    startedAt: number;
    endedAt?: number;
    /** Started by system events alone, with nothing from the owner since: it may end quietly. */
    system?: boolean;
  }[];
  pending: TicketInput[];
  /** Wakes by system events since the owner's last input. */
  systemWakes: number;
  reports: TicketReport[];
  ended?: { at: number; by: "owner" | "worker" | "host"; reason: string };
}
export interface RouterState {
  conversation: number | null;
  nextTrigger: number;
  nextTicket: number;
  open: string[];
  queue: string[];
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
export const TriggerKeyDoc = defineDocFamily<{ id: string | null }, null>({
  kind: "kaeno.trigger-key",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ id: null }),
});
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
  systemWakes: 5,
  idleTicketEndMs: 7 * 24 * 60 * 60_000,
  text: 4000,
  textMax: 8000,
  list: 20,
  listMax: 50,
  stub: 50,
  near: 1200,
  mid: 400,
} as const;

export function ticketThreads(
  ticket: Readonly<Stored<TicketRecord>>,
): string[] {
  return ticket.ownThread === null
    ? [...ticket.followed]
    : [ticket.ownThread, ...ticket.followed];
}
export function latestReport(
  ticket: Readonly<Stored<TicketRecord>>,
): Readonly<Stored<TicketReport>> | undefined {
  return ticket.reports.at(-1);
}
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
