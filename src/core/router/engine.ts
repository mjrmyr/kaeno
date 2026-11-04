// The router's single writer. Commands take the caller's transaction and change their records in it; external
// work (router submissions, steering, sends) is admitted as durable tasks in the same commit and performed after.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  defineDoc,
  defineTask,
  InboxDoc,
  LiveDoc,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type SettledSubmissionRecord,
  type Harness,
  type Task,
  type TaskId,
  type Tx,
  type UserInput,
} from "@earendil-works/pi-durable";
import {
  parseConversationId,
  parseTaskId,
  requireConversation,
  type Stored,
} from "../durable/index.ts";
import { WorkScope } from "../work/index.ts";
import {
  admitDelivery,
  readReplies,
  type ChannelRoute,
  type DeliveryTask,
  type Notifier,
  type ReplyPage,
} from "../outbox/index.ts";
import {
  FINAL_REPORTS,
  LIMITS,
  RouterDoc,
  ThreadDoc,
  TicketDoc,
  TriggerDoc,
  TriggerKeyDoc,
  type Authority,
  type GateMode,
  type ReportState,
  type ThreadRecord,
  type TicketInput,
  type TicketRecord,
  type TriggerDraft,
  type TriggerRecord,
} from "./model.ts";
import {
  contentText,
  renderPassed,
  renderReport,
  renderTrigger,
} from "./render.ts";

type Ticket = Stored<TicketRecord>;
type Trigger = Stored<TriggerRecord>;

/** Which ticket a worker conversation belongs to. Written once, when the ticket is accepted. */
export const TicketRef = defineDoc<{ ticket: string | null }>({
  kind: "kaeno.ticket-ref",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ ticket: null }),
});

/** What the Engine needs from WORK. Assignments are root WORK runs on the ticket's own conversation. */
export interface TicketWork {
  /**
   * Admit one Assignment; the same key always finds the same work. Throws `NoWorkSlot` when every slot is
   * taken; `reserve` lets a wake for an owner's message use slots beyond the limit.
   */
  launch(
    request: {
      owner: ConversationId;
      key: string;
      ticket: string;
      agent: string;
      title: string;
      content: UserInput;
      conversation: ConversationId;
      reserve: number;
    },
    context: Context,
  ): Promise<TaskId>;
  isNoSlot(error: unknown): boolean;
  /** The configured agent a requested name refers to; throws when unknown or ambiguous. */
  resolveAgent(requested: string): string;
}
/** What one channel offers the router. Absent for channels with nothing to add. */
export interface ChannelInfo {
  /** Hard cap for messages on this channel (IM: 100 words). */
  maxWords?: number;
  /**
   * A thread of the ticket's own for an event that arrived on `route`: a topic, or a reply chain anchored at the
   * event. Absent: the ticket has no own thread and follow-ups go through the router.
   */
  openThread?(
    route: ChannelRoute,
    title: string,
  ): Promise<{ key: string; route: ChannelRoute } | undefined>;
}
export interface EngineOptions {
  harness: () => Harness;
  /** Programmatic policy per source (Fast Path). Default: explicit. */
  gate?: (trigger: TriggerDraft) => GateMode;
  channel: (name: string) => ChannelInfo | undefined;
  notifier: () => Notifier;
  onReport?: (error: unknown) => void;
}
type DispatchInput =
  | {
      kind: "router";
      requestId: string;
      content: Stored<UserInput>;
      /** The trigger this input asks the router to dispose of; the dispatch checks it got an answer. */
      trigger: string | null;
      attempt: number;
    }
  | { kind: "note"; requestId: string; text: string }
  /** Launch queued tickets once the commit that queued them has landed. */
  | { kind: "pump" }
  | {
      kind: "steer";
      conversation: number;
      requestId: string;
      content: Stored<UserInput>;
      /** The live Assignment: a message never overtakes its brief. */
      work: number | null;
    };
type DispatchState = { phase: "submit" } | { phase: "wait" };
export type DispatchTask = Task<DispatchInput, DispatchState, null, object>;
export interface Reported {
  ticket: string;
  /** Absent when no Assignment started, for example when its launch failed. */
  workId: TaskId | null;
  key: string;
  state: ReportState;
  text: string;
}

const REMINDER =
  "got no reply and no route. Reply to it, or route it (accept or attach). An owner's message is never ignored.";

export class Engine {
  readonly dispatchTask: DispatchTask;
  private readonly options: EngineOptions;
  private delivery: DeliveryTask | undefined;
  private work: TicketWork | undefined;
  private pumping: Promise<void> = Promise.resolve();
  private pumpQueued = false;
  private timer: NodeJS.Timeout | undefined;
  constructor(options: EngineOptions) {
    this.options = options;
    this.dispatchTask = this.defineDispatch();
  }
  /** Late binding: WORK and the outbox are composed after the Engine. */
  compose(parts: {
    delivery: DeliveryTask;
    work: TicketWork | undefined;
  }): void {
    this.delivery = parts.delivery;
    this.work = parts.work;
  }
  get hasWork(): boolean {
    return this.work !== undefined;
  }
  private now(): number {
    return Date.now();
  }
  private harness(): Harness {
    return this.options.harness();
  }

  // ---------------------------------------------------------------- startup

  /** Create the router conversation once; reconfigure it when idle so a changed setup applies. */
  async open(
    configure: (tx: Tx, id: ConversationId) => Promise<void>,
    context: Context,
  ): Promise<ConversationId> {
    const id = await this.harness().commit(async (tx) => {
      const router = await tx.doc(RouterDoc);
      if (router.conversation === null) {
        const created = await tx.createConversation({
          ownership: { kind: "ownerless" },
        });
        router.conversation = created.id;
        await configure(tx, created.id);
        return created.id;
      }
      const existing = parseConversationId(router.conversation);
      if (
        !(await tx.doc(LiveDoc, existing)).run &&
        (await tx.doc(InboxDoc, existing)).items.length === 0
      ) {
        await configure(tx, existing);
      }
      return existing;
    }, context);
    this.timer = setInterval(() => this.schedulePump(), 2000);
    this.schedulePump();
    return id;
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.pumping;
  }
  /** A fresh router context: older turns become a summary; tickets keep running. */
  async compact(context: Context): Promise<void> {
    const conversation = await requireConversation(
      this.harness(),
      await this.routerConversation(context),
      context,
    );
    await conversation.compact(
      "Keep open tickets, their IDs and the owner's pending questions.",
      context,
    );
  }
  /** Messages sent to a thread, for clients that poll. */
  readReplies(
    thread: string,
    after: number,
    context: Context,
  ): Promise<ReplyPage> {
    return readReplies(this.harness(), thread, after, context);
  }
  async routerConversation(context: Context): Promise<ConversationId> {
    const router = await this.harness().snapshot(RouterDoc, context);
    if (!router || router.conversation === null) {
      throw new Error("The router is not open yet");
    }
    return parseConversationId(router.conversation);
  }
  private async routerIn(tx: Tx): Promise<ConversationId> {
    const router = await tx.doc(RouterDoc);
    if (router.conversation === null) {
      throw new Error("The router is not open yet");
    }
    return parseConversationId(router.conversation);
  }

  // ---------------------------------------------------------------- sources

  /**
   * Record one event. Redelivery finds the first record. Events on a followed thread pass straight to the
   * following tickets and the router only sees a note (Fast Path); every other event goes to the router (Slow Path).
   */
  async receive(
    tx: Tx,
    draft: TriggerDraft,
  ): Promise<{
    id: string;
    duplicate: boolean;
    path: "router" | "tickets" | "filtered";
  }> {
    if (draft.threads.length === 0) {
      throw new Error("A trigger needs at least one thread");
    }
    const key = await tx.doc(TriggerKeyDoc, draft.key, null);
    if (key.id !== null) {
      const known = await tx.doc(TriggerDoc, key.id, null);
      return { id: key.id, duplicate: true, path: pathOf(known) };
    }
    const router = await tx.doc(RouterDoc);
    const id = `t${router.nextTrigger++}`;
    key.id = id;
    const now = this.now();
    const mode = this.options.gate?.(draft) ?? "explicit";
    const record = await tx.doc(TriggerDoc, id, {
      ...structuredClone(draft),
      id,
      at: now,
      mode,
    } satisfies Trigger);
    router.recent.push(id);
    trim(router.recent, LIMITS.recentRouter);
    for (const [index, threadKey] of draft.threads.entries()) {
      const thread = await tx.doc(ThreadDoc, threadKey, threadKey);
      thread.createdAt ||= now;
      thread.lastAt = now;
      thread.recent.push(id);
      trim(thread.recent, LIMITS.recentThread);
      if (index === 0 && draft.route && !thread.route) {
        thread.route = {
          channel: draft.route.channel,
          address: draft.route.address,
        };
      }
    }
    if (mode === "ignore") {
      record.disposition = { kind: "filtered", at: now };
      return { id, duplicate: false, path: "filtered" };
    }
    const primary = await tx.doc(ThreadDoc, draft.threads[0], draft.threads[0]);
    const followers: Ticket[] = [];
    for (const ticketId of primary.subscribers) {
      const ticket = await tx.doc(TicketDoc, ticketId, null);
      if (ticket.status !== "ended") {
        followers.push(ticket);
      }
    }
    if (followers.length) {
      for (const ticket of followers) {
        await this.deliverInput(tx, ticket, { id, trigger: id });
      }
      record.disposition = {
        kind: "passed",
        tickets: followers.map((ticket) => ticket.id),
        at: now,
      };
      await this.note(tx, `passed:${id}`, renderPassed(record, followers));
      return { id, duplicate: false, path: "tickets" };
    }
    await this.toRouter(tx, {
      requestId: `trigger:${id}`,
      content: renderTrigger(record, [], await this.openTickets(tx)),
      trigger: id,
    });
    return { id, duplicate: false, path: "router" };
  }

  /**
   * Host-started work with an owner's standing approval, such as a routine run: a deterministic accept with no
   * router decision. The same key always finds the same ticket.
   */
  async startTicket(
    tx: Tx,
    request: {
      key: string;
      source: string;
      thread: string;
      replyThread: string;
      agent: string;
      title: string;
      content: UserInput;
    },
  ): Promise<string> {
    const work = this.requireWork();
    const agent = work.resolveAgent(request.agent);
    const key = await tx.doc(TriggerKeyDoc, request.key, null);
    if (key.id !== null) {
      const known = await tx.doc(TriggerDoc, key.id, null);
      const ticket = known.disposition?.tickets?.[0];
      if (!ticket) {
        throw new Error(`Start ${request.key} has no ticket`);
      }
      return ticket;
    }
    const router = await tx.doc(RouterDoc);
    const id = `t${router.nextTrigger++}`;
    key.id = id;
    const now = this.now();
    const trigger = await tx.doc(TriggerDoc, id, {
      key: request.key,
      source: request.source,
      threads: [request.thread],
      actor: "host",
      authority: "owner",
      content: structuredClone(request.content),
      id,
      at: now,
      mode: "explicit",
    } satisfies Trigger);
    const thread = await tx.doc(ThreadDoc, request.thread, request.thread);
    thread.createdAt ||= now;
    thread.lastAt = now;
    thread.recent.push(id);
    trim(thread.recent, LIMITS.recentThread);
    const ticket = await this.createTicket(tx, {
      trigger,
      agent,
      title: request.title,
      own: { key: request.thread },
      replyThread: request.replyThread,
      note: undefined,
    });
    trigger.disposition = { kind: "accept", tickets: [ticket.id], at: now };
    await this.pumpAfterCommit(tx);
    return ticket.id;
  }

  // ---------------------------------------------------------------- router decisions

  /** Trigger IDs the router's current run was given, so a tool can only cite what it was actually asked. */
  async currentBatch(context: Context): Promise<Set<string>> {
    const conversation = await this.routerConversation(context);
    const live = await this.harness().snapshot(LiveDoc, conversation, context);
    const ids = new Set<string>();
    for (const input of live?.run?.inputs ?? []) {
      const record = await (
        await this.harness().submission(input, context)
      )?.status(context);
      const match = /^(?:trigger|remind):(t[0-9]+)$/.exec(
        record?.requestId ?? "",
      );
      if (match) {
        ids.add(match[1]);
      }
    }
    return ids;
  }
  /** The trigger an owner-authority action cites: it must be in the current batch and carry owner authority. */
  async requireOwnerBasis(basis: string, context: Context): Promise<void> {
    if (!(await this.currentBatch(context)).has(basis)) {
      throw new Error(
        `${basis} is not one of the events in front of you; cite the owner's message that asks for this`,
      );
    }
    const trigger = await this.harness().snapshot(TriggerDoc, basis, context);
    if (trigger?.authority !== "owner") {
      throw new Error(
        `${basis} is not the owner's own message; only the owner's messages can authorise this`,
      );
    }
  }
  async trigger(id: string, context: Context): Promise<Readonly<Trigger>> {
    const trigger = /^t[0-9]+$/.test(id)
      ? await this.harness().snapshot(TriggerDoc, id, context)
      : undefined;
    if (!trigger) {
      throw new Error(`Unknown trigger ${id}`);
    }
    return trigger;
  }
  async thread(
    key: string,
    context: Context,
  ): Promise<Readonly<Stored<ThreadRecord>> | undefined> {
    const thread = await this.harness().snapshot(ThreadDoc, key, context);
    return thread?.createdAt ? thread : undefined;
  }
  /** The thread of the owner's latest message, where a new routine reports by default. */
  async lastOwnerThread(context: Context): Promise<string | undefined> {
    for (const id of (await this.recentTriggers(context)).toReversed()) {
      const trigger = await this.harness().snapshot(TriggerDoc, id, context);
      if (trigger?.authority === "owner" && trigger.actor !== "host") {
        return trigger.threads[0];
      }
    }
    return undefined;
  }
  async recentTriggers(context: Context): Promise<readonly string[]> {
    return (await this.harness().snapshot(RouterDoc, context))?.recent ?? [];
  }
  async ticket(id: string, context: Context): Promise<Readonly<Ticket>> {
    const ticket = /^k[0-9]+$/.test(id)
      ? await this.harness().snapshot(TicketDoc, id, context)
      : undefined;
    if (!ticket) {
      throw new Error(`Unknown ticket ${id}`);
    }
    return ticket;
  }
  /** A thread of the ticket's own for its origin event, when that event's channel offers one. */
  async openOwnThread(
    triggerId: string,
    title: string,
    context: Context,
  ): Promise<{ key: string; route: ChannelRoute } | undefined> {
    const trigger = await this.trigger(triggerId, context);
    if (!trigger.route) {
      return undefined;
    }
    try {
      return await this.options
        .channel(trigger.route.channel)
        ?.openThread?.(trigger.route, title);
    } catch (error) {
      this.options.onReport?.(error);
      return undefined;
    }
  }
  async accept(
    tx: Tx,
    request: {
      trigger: string;
      agent: string;
      title: string;
      ack: string;
      note?: string;
      own?: { key: string; route: ChannelRoute };
    },
  ): Promise<string> {
    const agent = this.requireWork().resolveAgent(request.agent);
    const trigger = await tx.doc(TriggerDoc, request.trigger, null);
    this.assertUndecided(trigger);
    // A client waiting for its request ID gets the acknowledgement, unless a reply already answered it.
    const direct = trigger.disposition ? undefined : trigger.requestId;
    const ticket = await this.createTicket(tx, {
      trigger,
      agent,
      title: request.title,
      own: request.own,
      replyThread: trigger.threads[0],
      note: request.note,
    });
    trigger.disposition = {
      kind: "accept",
      tickets: [ticket.id],
      at: this.now(),
    };
    await this.send(tx, {
      thread: request.own?.key ?? trigger.threads[0],
      route: request.own?.route ?? trigger.route ?? null,
      requestId: direct ?? `ack:${ticket.id}`,
      text: request.ack,
      ticket: ticket.id,
    });
    await this.pumpAfterCommit(tx);
    return ticket.id;
  }
  async attach(
    tx: Tx,
    request: { trigger: string; ticket: string; note?: string },
  ): Promise<void> {
    const trigger = await tx.doc(TriggerDoc, request.trigger, null);
    this.assertUndecided(trigger);
    const ticket = await tx.doc(TicketDoc, request.ticket, null);
    if (ticket.status === "ended") {
      throw new Error(`${ticket.id} has ended; accept a new ticket instead`);
    }
    await this.deliverInput(tx, ticket, {
      id: trigger.id,
      trigger: trigger.id,
      ...(request.note ? { text: request.note } : {}),
    });
    trigger.disposition = {
      kind: "attach",
      tickets: [ticket.id],
      at: this.now(),
    };
  }
  async ignore(tx: Tx, triggerId: string): Promise<void> {
    const trigger = await tx.doc(TriggerDoc, triggerId, null);
    this.assertUndecided(trigger);
    if (trigger.authority === "owner" && trigger.mode === "explicit") {
      throw new Error(
        `${trigger.id} is the owner's request; reply to it, even briefly, or route it`,
      );
    }
    trigger.disposition = { kind: "ignore", at: this.now() };
  }
  /** Say something. `to` is a trigger (reply to that message), a ticket (its thread) or a thread key. */
  async reply(
    tx: Tx,
    request: { to: string; text: string; key: string },
  ): Promise<{ thread: string }> {
    let thread: string;
    let route: ChannelRoute | undefined;
    let requestId = `reply:${request.key}`;
    let ticketId: string | null = null;
    if (/^t[0-9]+$/.test(request.to)) {
      const trigger = await tx.doc(TriggerDoc, request.to, null);
      thread = trigger.threads[0];
      route = trigger.route;
      if (trigger.requestId !== undefined && !trigger.disposition) {
        requestId = trigger.requestId;
      }
      trigger.disposition ??= { kind: "reply", at: this.now() };
      ticketId = trigger.disposition.tickets?.[0] ?? null;
    } else if (/^k[0-9]+$/.test(request.to)) {
      const ticket = await tx.doc(TicketDoc, request.to, null);
      ticketId = ticket.id;
      // The ticket's own thread when it can be reached, otherwise where it was started.
      thread = ticket.replyThread;
      for (const key of ticket.threads) {
        const own = await tx.doc(ThreadDoc, key, key);
        if (own.route) {
          thread = key;
          break;
        }
      }
      route = (await tx.doc(ThreadDoc, thread, thread)).route;
    } else {
      const known = await tx.doc(ThreadDoc, request.to, request.to);
      if (!known.createdAt) {
        throw new Error(`Unknown thread ${request.to}`);
      }
      thread = known.key;
      route = known.route;
    }
    const cap = route
      ? this.options.channel(route.channel)?.maxWords
      : undefined;
    const words = request.text.trim().split(/\s+/).length;
    if (cap !== undefined && words > cap) {
      throw new Error(
        `${route?.channel} messages are limited to ${cap} words; this one has ${words}. Shorten it to the conclusion or the one question; details stay available through recall.`,
      );
    }
    await this.send(tx, {
      thread,
      route: route ?? null,
      requestId,
      text: request.text,
      ticket: ticketId,
    });
    return { thread };
  }
  /** Router text for a ticket's worker: a relayed answer or cross-ticket context. */
  async messageTicket(
    tx: Tx,
    ticketId: string,
    text: string,
    key: string,
  ): Promise<void> {
    const ticket = await tx.doc(TicketDoc, ticketId, null);
    if (ticket.status === "ended") {
      throw new Error(`${ticket.id} has ended`);
    }
    await this.deliverInput(tx, ticket, { id: `m:${key}`, text });
  }
  /** Stop a ticket and its live run. The caller aborts the returned works after committing. */
  async stopTicket(
    tx: Tx,
    ticketId: string,
    by: "owner" | "worker" | "host",
    reason: string,
  ): Promise<TaskId[]> {
    const ticket = await tx.doc(TicketDoc, ticketId, null);
    if (ticket.status === "ended") {
      return [];
    }
    const live = ticket.assignments.flatMap((assignment) =>
      assignment.endedAt === undefined ? [assignment.workId] : [],
    );
    await this.end(tx, ticket, by, reason);
    return live.map((workId) => parseTaskId(workId));
  }
  /** Stop every open ticket, or those of `thread`: following it, or started there. */
  async stopAll(
    tx: Tx,
    thread?: string,
  ): Promise<{ tickets: string[]; works: TaskId[] }> {
    const router = await tx.doc(RouterDoc);
    const tickets: string[] = [];
    const works: TaskId[] = [];
    for (const id of [...router.open]) {
      const ticket = await tx.doc(TicketDoc, id, null);
      if (
        thread !== undefined &&
        !ticket.threads.includes(thread) &&
        ticket.replyThread !== thread
      ) {
        continue;
      }
      tickets.push(id);
      works.push(
        ...(await this.stopTicket(tx, id, "owner", "stopped by the owner")),
      );
    }
    return { tickets, works };
  }
  async abortWorks(works: readonly TaskId[], context: Context): Promise<void> {
    for (const work of works) {
      await this.harness().abortTask(work, context);
    }
  }
  async listTickets(
    context: Context,
    all = false,
  ): Promise<Readonly<Ticket>[]> {
    const router = await this.harness().snapshot(RouterDoc, context);
    const ids = all
      ? Array.from(
          { length: (router?.nextTicket ?? 1) - 1 },
          (_value, index) => `k${index + 1}`,
        )
      : (router?.open ?? []);
    const tickets: Readonly<Ticket>[] = [];
    for (const id of ids) {
      const ticket = await this.harness().snapshot(TicketDoc, id, context);
      if (ticket) {
        tickets.push(ticket);
      }
    }
    return tickets;
  }

  // ---------------------------------------------------------------- worker side

  /** The ticket a worker conversation runs for, if any. */
  async ticketOf(
    conversation: ConversationId,
    context: Context,
  ): Promise<string | undefined> {
    return (
      (await this.harness().snapshot(TicketRef, conversation, context))
        ?.ticket ?? undefined
    );
  }
  /** A report from a ticket's Assignment. Reports on an ended ticket are dropped. */
  async report(tx: Tx, reported: Reported): Promise<void> {
    const ticket = await tx.doc(TicketDoc, reported.ticket, null);
    if (ticket.status === "ended") {
      return;
    }
    const now = this.now();
    const report = { state: reported.state, summary: reported.text, at: now };
    ticket.reports.push(report);
    trim(ticket.reports, LIMITS.reports);
    ticket.updatedAt = now;
    if (FINAL_REPORTS.includes(reported.state)) {
      for (const assignment of ticket.assignments) {
        if (assignment.workId === reported.workId) {
          assignment.endedAt ??= now;
        }
      }
      if (reported.state === "dropped") {
        await this.end(tx, ticket, "worker", reported.text);
      } else {
        await this.idleOrWake(tx, ticket);
      }
      await this.pumpAfterCommit(tx);
    }
    if (reported.state === "progress" || reported.state === "dropped") {
      await this.note(
        tx,
        `report:${reported.key}`,
        renderReport(ticket, report),
      );
      return;
    }
    await this.toRouter(tx, {
      requestId: `report:${reported.key}`,
      content: renderReport(ticket, report),
      trigger: null,
    });
  }
  /** An Assignment ended without a report: cancelled, or failed in recovery. */
  async assignmentEnded(
    tx: Tx,
    ticketId: string,
    workId: TaskId,
  ): Promise<void> {
    const ticket = await tx.doc(TicketDoc, ticketId, null);
    const assignment = ticket.assignments.find(
      (value) => value.workId === workId,
    );
    if (!assignment || assignment.endedAt !== undefined) {
      return;
    }
    assignment.endedAt = this.now();
    if (ticket.status !== "ended") {
      await this.report(tx, {
        ticket: ticketId,
        workId,
        key: `${workId}:aborted`,
        state: "failed",
        text: "The run was cancelled before it reported.",
      });
    }
    await this.pumpAfterCommit(tx);
  }
  /** Return an event that is not this ticket's business to the router. */
  async handback(
    tx: Tx,
    ticketId: string,
    triggerId: string,
    reason: string,
  ): Promise<void> {
    const ticket = await tx.doc(TicketDoc, ticketId, null);
    const trigger = await tx.doc(TriggerDoc, triggerId, null);
    if (!trigger.disposition?.tickets?.includes(ticket.id)) {
      throw new Error(`${triggerId} did not reach ${ticketId}`);
    }
    trigger.disposition.tickets = trigger.disposition.tickets.filter(
      (id) => id !== ticket.id,
    );
    if (trigger.disposition.tickets.length > 0) {
      return;
    }
    delete trigger.disposition;
    await this.toRouter(tx, {
      requestId: `handback:${triggerId}:${ticketId}`,
      content: [
        `${ticketId} handed this back: ${reason}`,
        contentText(renderTrigger(trigger, [], await this.openTickets(tx))),
      ].join("\n"),
      trigger: triggerId,
    });
  }
  async unsubscribe(tx: Tx, ticketId: string, thread: string): Promise<void> {
    const ticket = await tx.doc(TicketDoc, ticketId, null);
    ticket.threads = ticket.threads.filter((key) => key !== thread);
    const record = await tx.doc(ThreadDoc, thread, thread);
    record.subscribers = record.subscribers.filter((id) => id !== ticketId);
  }
  async follow(tx: Tx, ticketId: string, thread: string): Promise<void> {
    const ticket = await tx.doc(TicketDoc, ticketId, null);
    const record = await tx.doc(ThreadDoc, thread, thread);
    if (!record.createdAt) {
      throw new Error(`Unknown thread ${thread}`);
    }
    if (!ticket.threads.includes(thread)) {
      ticket.threads.push(thread);
    }
    if (!record.subscribers.includes(ticketId)) {
      record.subscribers.push(ticketId);
    }
  }

  // ---------------------------------------------------------------- slots

  /** A pump that runs after the caller's commit, so it sees what that commit queued. */
  private async pumpAfterCommit(tx: Tx): Promise<void> {
    if (this.work) {
      await this.dispatch(tx, { kind: "pump" });
    }
  }
  /** Launch queued tickets while slots are free. Idempotent: every pass converges on the same Assignments. */
  schedulePump(): void {
    if (this.pumpQueued || !this.work) {
      return;
    }
    this.pumpQueued = true;
    this.pumping = this.pumping.then(async () => {
      this.pumpQueued = false;
      try {
        await this.pumpOnce(BACKGROUND_CONTEXT);
      } catch (error) {
        this.options.onReport?.(error);
      }
    });
  }
  /** Settles once every launch scheduled so far has been attempted. */
  async idle(): Promise<void> {
    while (this.pumpQueued) {
      await this.pumping;
    }
    await this.pumping;
  }
  private async pumpOnce(context: Context): Promise<void> {
    const work = this.work;
    const router = await this.harness().snapshot(RouterDoc, context);
    if (!work || !router || router.conversation === null) {
      return;
    }
    const owner = parseConversationId(router.conversation);
    await this.expire(router.open, context);
    for (const id of router.queue) {
      const ticket = await this.harness().snapshot(TicketDoc, id, context);
      if (!ticket || ticket.status !== "queued") {
        await this.harness().commit(async (tx) => {
          const current = await tx.doc(RouterDoc);
          current.queue = current.queue.filter((value) => value !== id);
        }, context);
        continue;
      }
      const number = ticket.assignments.length + 1;
      const included = ticket.pending.map((input) => input.id);
      let workId: TaskId;
      try {
        workId = await work.launch(
          {
            owner,
            key: `${id}:${number}`,
            ticket: id,
            agent: ticket.agent,
            title: ticket.title,
            content: await this.briefing(ticket, context),
            conversation: parseConversationId(ticket.conversation),
            reserve: ticket.assignments.length > 0 ? 1 : 0,
          },
          context,
        );
      } catch (error) {
        if (work.isNoSlot(error)) {
          // Wakes for an owner's message are first and may use the reserved slot; the rest wait in order.
          if (ticket.assignments.length > 0) {
            continue;
          }
          break;
        }
        this.options.onReport?.(error);
        await this.harness().commit(async (tx) => {
          const current = await tx.doc(TicketDoc, id, null);
          if (current.status !== "queued") {
            return;
          }
          current.pending = [];
          await this.report(tx, {
            ticket: id,
            workId: null,
            key: `${id}:${number}:launch`,
            state: "failed",
            text: `Could not start: ${error instanceof Error ? error.message : String(error)}`,
          });
        }, context);
        continue;
      }
      await this.harness().commit(async (tx) => {
        const current = await tx.doc(TicketDoc, id, null);
        const routerDoc = await tx.doc(RouterDoc);
        routerDoc.queue = routerDoc.queue.filter((value) => value !== id);
        if (
          current.status !== "queued" ||
          current.assignments.length !== number - 1
        ) {
          return;
        }
        current.assignments.push({ workId, startedAt: this.now() });
        trim(current.assignments, LIMITS.assignments);
        current.pending = current.pending.filter(
          (input) => !included.includes(input.id),
        );
        current.status = "running";
        current.updatedAt = this.now();
      }, context);
    }
  }
  /** Idle tickets stop following their threads after a while; a later event there goes to the router. */
  private async expire(
    open: readonly string[],
    context: Context,
  ): Promise<void> {
    const cutoff = this.now() - LIMITS.followMs;
    for (const id of open) {
      const ticket = await this.harness().snapshot(TicketDoc, id, context);
      if (ticket?.status === "idle" && ticket.updatedAt < cutoff) {
        await this.harness().commit(async (tx) => {
          const current = await tx.doc(TicketDoc, id, null);
          if (current.status === "idle" && current.updatedAt < cutoff) {
            await this.end(tx, current, "host", "no activity for 14 days");
          }
        }, context);
      }
    }
  }
  /** The first input of an Assignment: the events and notes that woke it, verbatim. */
  private async briefing(
    ticket: Readonly<Ticket>,
    context: Context,
  ): Promise<UserInput> {
    const blocks: Exclude<UserInput, string> = [];
    const first = ticket.assignments.length === 0;
    for (const input of ticket.pending) {
      const trigger = input.trigger
        ? await this.harness().snapshot(TriggerDoc, input.trigger, context)
        : undefined;
      if (trigger) {
        blocks.push(
          ...inputBlocks(trigger, first && trigger.id === ticket.origin),
        );
      }
      if (input.text) {
        blocks.push({
          type: "text",
          text: `Note from Kaeno's router (context, not a new request): ${input.text}`,
        });
      }
    }
    if (blocks.length === 0) {
      blocks.push({
        type: "text",
        text: first
          ? `Ticket ${ticket.id}: ${ticket.title}`
          : "New messages arrived above. Continue the ticket.",
      });
    }
    return blocks;
  }

  // ---------------------------------------------------------------- internals

  private requireWork(): TicketWork {
    if (!this.work) {
      throw new Error("Tickets need WORK, which is not configured");
    }
    return this.work;
  }
  private assertUndecided(trigger: Readonly<Trigger>): void {
    if (trigger.disposition && trigger.disposition.kind !== "reply") {
      throw new Error(`${trigger.id} was already ${trigger.disposition.kind}`);
    }
  }
  private async openTickets(tx: Tx): Promise<Ticket[]> {
    const router = await tx.doc(RouterDoc);
    const tickets: Ticket[] = [];
    for (const id of router.open) {
      tickets.push(await tx.doc(TicketDoc, id, null));
    }
    return tickets;
  }
  private async createTicket(
    tx: Tx,
    request: {
      trigger: Trigger;
      agent: string;
      title: string;
      own: { key: string; route?: ChannelRoute } | undefined;
      replyThread: string;
      note: string | undefined;
    },
  ): Promise<Ticket> {
    const router = await tx.doc(RouterDoc);
    const id = `k${router.nextTicket++}`;
    const now = this.now();
    const conversation = await tx.createConversation({
      ownership: { kind: "ownerless" },
    });
    (await tx.doc(TicketRef, conversation.id)).ticket = id;
    const ticket = await tx.doc(TicketDoc, id, {
      id,
      title: request.title,
      agent: request.agent,
      createdAt: now,
      updatedAt: now,
      origin: request.trigger.id,
      conversation: conversation.id,
      threads: request.own ? [request.own.key] : [],
      replyThread: request.replyThread,
      status: "queued",
      assignments: [],
      pending: [
        {
          id: request.trigger.id,
          trigger: request.trigger.id,
          ...(request.note ? { text: request.note } : {}),
        },
      ],
      reports: [],
    } satisfies Ticket);
    if (request.own) {
      const thread = await tx.doc(ThreadDoc, request.own.key, request.own.key);
      thread.createdAt ||= now;
      thread.lastAt = now;
      if (request.own.route) {
        thread.route = copyRoute(request.own.route);
      }
      if (!thread.subscribers.includes(id)) {
        thread.subscribers.push(id);
      }
    }
    router.open.push(id);
    router.queue.push(id);
    return ticket;
  }
  private async deliverInput(
    tx: Tx,
    ticket: Ticket,
    input: TicketInput,
  ): Promise<void> {
    if (ticket.status === "ended") {
      return;
    }
    ticket.updatedAt = this.now();
    if (ticket.status === "running") {
      const trigger = input.trigger
        ? await tx.doc(TriggerDoc, input.trigger, null)
        : undefined;
      const blocks: Exclude<UserInput, string> = trigger
        ? inputBlocks(trigger, false)
        : [];
      if (input.text) {
        blocks.push({
          type: "text",
          text: `Message from Kaeno's router: ${input.text}`,
        });
      }
      const live = ticket.assignments.findLast(
        (assignment) => assignment.endedAt === undefined,
      );
      // The input answers a question the worker is waiting on, as message_work does for child WORK.
      const scope = await tx.doc(
        WorkScope,
        parseConversationId(ticket.conversation),
      );
      if (scope.question) {
        scope.question.answered = true;
      }
      await this.dispatch(tx, {
        kind: "steer",
        conversation: ticket.conversation,
        requestId: `input:${ticket.id}:${input.id}`,
        content: blocks,
        work: live?.workId ?? null,
      });
      return;
    }
    if (!ticket.pending.some((value) => value.id === input.id)) {
      ticket.pending.push(input);
      trim(ticket.pending, LIMITS.pending);
    }
    if (ticket.status === "idle") {
      ticket.status = "queued";
      const router = await tx.doc(RouterDoc);
      router.queue = [
        ticket.id,
        ...router.queue.filter((id) => id !== ticket.id),
      ];
      await this.pumpAfterCommit(tx);
    }
  }
  /** After a final report: wait for the next event, or run again at once if input arrived meanwhile. */
  private async idleOrWake(tx: Tx, ticket: Ticket): Promise<void> {
    const conversation = parseConversationId(ticket.conversation);
    const busy =
      Boolean((await tx.doc(LiveDoc, conversation)).run) ||
      (await tx.doc(InboxDoc, conversation)).items.length > 0;
    if (ticket.pending.length === 0 && !busy) {
      ticket.status = "idle";
      return;
    }
    ticket.status = "queued";
    const router = await tx.doc(RouterDoc);
    router.queue = [
      ticket.id,
      ...router.queue.filter((id) => id !== ticket.id),
    ];
  }
  private async end(
    tx: Tx,
    ticket: Ticket,
    by: "owner" | "worker" | "host",
    reason: string,
  ): Promise<void> {
    ticket.status = "ended";
    ticket.ended = { at: this.now(), by, reason };
    ticket.updatedAt = this.now();
    ticket.pending = [];
    for (const key of ticket.threads) {
      const thread = await tx.doc(ThreadDoc, key, key);
      thread.subscribers = thread.subscribers.filter((id) => id !== ticket.id);
    }
    const router = await tx.doc(RouterDoc);
    router.open = router.open.filter((id) => id !== ticket.id);
    router.queue = router.queue.filter((id) => id !== ticket.id);
  }
  private async send(
    tx: Tx,
    message: {
      thread: string;
      route: ChannelRoute | null;
      requestId: string;
      text: string;
      ticket: string | null;
    },
  ): Promise<void> {
    if (!this.delivery) {
      throw new Error("The outbox is not composed");
    }
    await admitDelivery(tx, this.delivery, await this.routerIn(tx), {
      ...message,
      route: message.route && copyRoute(message.route),
    });
  }
  private async toRouter(
    tx: Tx,
    input: { requestId: string; content: UserInput; trigger: string | null },
  ): Promise<void> {
    await this.dispatch(tx, {
      kind: "router",
      requestId: input.requestId,
      content: structuredClone(input.content),
      trigger: input.trigger,
      attempt: 0,
    });
  }
  private async note(tx: Tx, requestId: string, text: string): Promise<void> {
    await this.dispatch(tx, { kind: "note", requestId, text });
  }
  private async dispatch(tx: Tx, input: DispatchInput): Promise<void> {
    await tx.createTask(this.dispatchTask, input, {
      ownership: { kind: "conversation" },
      conversationId: await this.routerIn(tx),
      background: true,
    });
  }
  private async conversationFor(
    input: DispatchInput,
    context: Context,
  ): Promise<ConversationId> {
    return input.kind === "steer"
      ? parseConversationId(input.conversation)
      : this.routerConversation(context);
  }
  /**
   * After the router answered a batch: did this trigger get a decision? An answer that is the only one an owner
   * message got becomes its reply; otherwise remind once, then give up loudly.
   */
  private async settled(
    input: Extract<DispatchInput, { kind: "router" }>,
    settled: SettledSubmissionRecord,
    context: Context,
  ): Promise<void> {
    const triggerId = input.trigger;
    if (triggerId === null) {
      return;
    }
    const failure = failureOf(settled);
    await this.harness().commit(async (tx) => {
      const trigger = await tx.doc(TriggerDoc, triggerId, null);
      if (trigger.disposition) {
        return;
      }
      if (
        settled.status === "done" &&
        settled.type === "input" &&
        trigger.authority === "owner"
      ) {
        const text = answerText(await tx.entry(AssistantEntry, settled.answer));
        const route = trigger.route;
        const cap = route
          ? this.options.channel(route.channel)?.maxWords
          : undefined;
        if (
          text &&
          (cap === undefined || text.split(/\s+/).length <= cap) &&
          (await this.soleUndecided(tx, settled.answer)) === trigger.id
        ) {
          trigger.disposition = { kind: "reply", at: this.now() };
          await this.send(tx, {
            thread: trigger.threads[0],
            route: route ?? null,
            requestId: trigger.requestId ?? `answer:${trigger.id}`,
            text,
            ticket: null,
          });
          return;
        }
      }
      if (failure !== undefined || input.attempt > 0) {
        trigger.disposition = { kind: "unrouted", at: this.now() };
        if (trigger.authority === "owner") {
          await this.send(tx, {
            thread: trigger.threads[0],
            route: trigger.route ?? null,
            requestId: trigger.requestId ?? `unrouted:${trigger.id}`,
            text:
              failure === undefined
                ? "⚠️ Kaeno could not handle that message. Please send it again."
                : `⚠️ Kaeno could not answer: ${failure}`,
            ticket: null,
          });
        }
        return;
      }
      await this.dispatch(tx, {
        kind: "router",
        requestId: `remind:${trigger.id}`,
        content: `${trigger.id} ${REMINDER}`,
        trigger: trigger.id,
        attempt: 1,
      });
    }, context);
  }
  /** The one undecided owner trigger a router answer belongs to, if exactly one does. */
  private async soleUndecided(
    tx: Tx,
    answer: EntryId,
  ): Promise<string | undefined> {
    const router = await tx.doc(RouterDoc);
    const conversation = await this.routerIn(tx);
    const found: string[] = [];
    for (const id of router.recent.slice(-50)) {
      const trigger = await tx.doc(TriggerDoc, id, null);
      if (trigger.disposition || trigger.authority !== "owner") {
        continue;
      }
      for (const request of [`trigger:${id}`, `remind:${id}`]) {
        const submission = await tx.submissionByRequest(conversation, request);
        if (submission?.status === "done" && submission.answer === answer) {
          found.push(id);
          break;
        }
      }
    }
    return found.length === 1 ? found[0] : undefined;
  }
  /** Wait until an Assignment's brief is admitted, or the Assignment is gone (then the next one takes the input). */
  private async briefed(
    conversation: ConversationId,
    work: TaskId,
    clock: {
      sleep(until: number, context: Context): Promise<void>;
      now(): number;
    },
    context: Context,
  ): Promise<void> {
    for (;;) {
      const admitted = await this.harness().commit(
        (tx) => tx.submissionByRequest(conversation, `work:${work}`),
        context,
      );
      if (admitted) {
        return;
      }
      const record = await this.harness().getTask(work, context);
      if (!record || record.state.status === "terminal") {
        return;
      }
      await clock.sleep(clock.now() + 50, context);
    }
  }
  private defineDispatch(): DispatchTask {
    return defineTask<DispatchInput, DispatchState, null>({
      name: "kaeno.dispatch",
      version: 1,
      initial: () => ({ phase: "submit" }),
      phases: {
        submit: async (task, runtime, context) => {
          const input = task.input;
          if (input.kind === "pump") {
            this.schedulePump();
            await this.idle();
            await runtime.commit(
              () => ({
                status: "terminal",
                outcome: { status: "completed", result: null },
              }),
              context,
            );
            return;
          }
          const conversation = await requireConversation(
            runtime,
            await this.conversationFor(input, context),
            context,
          );
          if (input.kind === "note") {
            // A passive entry: the router reads it on its next turn without being woken for it.
            const full = await requireConversation(
              this.harness(),
              conversation.id,
              context,
            );
            await full.submit(
              {
                type: "write",
                requestId: input.requestId,
                entry: {
                  kind: "kaeno.note",
                  model: [
                    {
                      role: "user" as const,
                      content: input.text,
                      timestamp: runtime.now(),
                    },
                  ],
                },
              },
              context,
            );
          } else {
            if (input.kind === "steer" && input.work !== null) {
              await this.briefed(
                parseConversationId(input.conversation),
                parseTaskId(input.work),
                runtime,
                context,
              );
            }
            await conversation.submit(
              {
                type: "input",
                content: input.content,
                requestId: input.requestId,
                whenBusy: input.kind === "steer" ? "steer" : "followUp",
              },
              context,
            );
          }
          await runtime.commit(
            () =>
              input.kind === "router" && input.trigger !== null
                ? { status: "running", checkpoint: { phase: "wait" } }
                : {
                    status: "terminal",
                    outcome: { status: "completed", result: null },
                  },
            context,
          );
        },
        wait: async (task, runtime, context) => {
          const input = task.input;
          if (input.kind !== "router") {
            throw new Error("Only router inputs wait for an answer");
          }
          const conversation = await requireConversation(
            runtime,
            await this.routerConversation(context),
            context,
          );
          // Resubmitting the same request ID finds the admitted submission.
          const submission = await conversation.submit(
            {
              type: "input",
              content: input.content,
              requestId: input.requestId,
              whenBusy: "followUp",
            },
            context,
          );
          const trigger =
            input.trigger === null
              ? undefined
              : await runtime.snapshot(TriggerDoc, input.trigger, context);
          const route =
            trigger?.authority === "owner" ? trigger.route : undefined;
          const typing = route
            ? setInterval(
                () =>
                  void this.options
                    .notifier()
                    .typing(route)
                    .catch(() => {}),
                4500,
              )
            : undefined;
          if (route) {
            void this.options
              .notifier()
              .typing(route)
              .catch(() => {});
          }
          let settled;
          try {
            settled = await submission.wait(context);
          } finally {
            clearInterval(typing);
          }
          await this.settled(input, settled, context);
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: null },
            }),
            context,
          );
        },
      },
      abort: (_task, runtime, context) =>
        runtime.commit(
          () => ({ status: "terminal", outcome: { status: "aborted" } }),
          context,
        ),
    });
  }
}

function pathOf(trigger: Readonly<Trigger>): "router" | "tickets" | "filtered" {
  if (trigger.disposition?.kind === "filtered") {
    return "filtered";
  }
  return trigger.disposition?.kind === "passed" ? "tickets" : "router";
}
function failureOf(settled: SettledSubmissionRecord): string | undefined {
  if (settled.status === "done") {
    return undefined;
  }
  return settled.reason === "aborted" ? "stopped" : settled.reason;
}
function answerText(entry: EntryRecord | undefined): string {
  const content = entry?.model?.[0]?.content ?? [];
  if (typeof content === "string") {
    return content.trim();
  }
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}
/** A plain copy: routes are often read from a document draft, which cannot be cloned or stored elsewhere. */
function copyRoute(route: Readonly<ChannelRoute>): ChannelRoute {
  return {
    channel: route.channel,
    address: route.address,
    ...(route.replyTo === undefined ? {} : { replyTo: route.replyTo }),
  };
}
function trim<T>(values: T[], limit: number): void {
  if (values.length > limit) {
    values.splice(0, values.length - limit);
  }
}
/** A trigger as a worker receives it: its source and thread, then its content verbatim. */
function inputBlocks(
  trigger: Readonly<Trigger>,
  origin: boolean,
): Exclude<UserInput, string> {
  const header = origin
    ? `Your ticket's request (${trigger.id}, from ${trigger.source} in ${trigger.threads[0]}):`
    : `New message in your ticket's thread (${trigger.id}, from ${trigger.source} in ${trigger.threads[0]}):`;
  const content = trigger.content;
  if (typeof content === "string") {
    return [{ type: "text", text: `${header}\n${content}` }];
  }
  return [
    { type: "text", text: header },
    ...content.map((block) =>
      block.type === "text"
        ? { type: "text" as const, text: block.text }
        : {
            type: "image" as const,
            data: block.data,
            mimeType: block.mimeType,
          },
    ),
  ];
}
export type { Authority };
