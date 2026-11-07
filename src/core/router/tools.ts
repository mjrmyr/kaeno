import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { LIMITS, ticketThreads } from "./model.ts";
import type { Engine } from "./engine.ts";
import {
  FOLLOW_THREAD,
  HANDBACK,
  LIST_TICKETS,
  MESSAGE_TICKET,
  RECALL,
  REPLY,
  ROUTE,
  STOP_TICKET,
  UNSUBSCRIBE_THREAD,
} from "./names.ts";
import {
  recallThread,
  recallTicket,
  recallTrigger,
  stub,
  contentText,
  ticketLine,
} from "./render.ts";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

export async function recall(
  engine: Engine,
  ref: string,
  offset: number,
  limit: number,
  context: Context,
): Promise<string> {
  if (/^t[0-9]+$/.test(ref)) {
    const trigger = await engine.trigger(ref, context);
    const tickets = [];
    for (const id of trigger.disposition?.tickets ?? []) {
      tickets.push(await engine.ticket(id, context));
    }
    return recallTrigger(trigger, tickets, offset, limit);
  }
  if (/^k[0-9]+$/.test(ref)) {
    const ticket = await engine.ticket(ref, context);
    const triggers = [];
    for (const key of ticketThreads(ticket)) {
      const thread = await engine.thread(key, context);
      for (const id of thread?.recent ?? []) {
        if (id !== ticket.origin) {
          const trigger = await engine.trigger(id, context);
          if (trigger.disposition?.tickets?.includes(ticket.id)) {
            triggers.push(trigger);
          }
        }
      }
    }
    const origin = await engine
      .trigger(ticket.origin, context)
      .catch(() => undefined);
    return recallTicket(ticket, origin, triggers, offset, limit);
  }
  if (ref === "recent") {
    const lines = [];
    for (const id of (await engine.recentTriggers(context))
      .slice(-limit)
      .toReversed()) {
      const trigger = await engine.trigger(id, context);
      lines.push(
        `- ${trigger.id} ${trigger.threads[0]}${trigger.disposition ? ` [${trigger.disposition.kind}${trigger.disposition.tickets?.length ? ` ${trigger.disposition.tickets.join(" ")}` : ""}]` : ""}: ${stub(contentText(trigger.content))}`,
      );
    }
    return lines.join("\n") || "No events yet.";
  }
  const thread = await engine.thread(ref, context);
  if (!thread) {
    throw new Error(
      `Nothing is called ${ref}. Recall a trigger (t12), a ticket (k3), a thread key, or "recent".`,
    );
  }
  const followers = [];
  for (const id of thread.subscribers) {
    followers.push(await engine.ticket(id, context));
  }
  const triggers = [];
  for (const id of thread.recent) {
    triggers.push(await engine.trigger(id, context));
  }
  return recallThread(thread, followers, triggers);
}

export function routerTools(engine: Engine): ToolRegistration[] {
  async function inBatch(id: string, context: Context): Promise<void> {
    if (!(await engine.currentBatch(context)).has(id)) {
      throw new Error(`${id} is not one of the events in front of you`);
    }
  }
  const route = defineTool({
    name: ROUTE,
    description:
      "Decide what happens to events in front of you. accept: start a new ticket for a worker; the worker receives the event verbatim, so do not rewrite it. attach: hand the event to an existing ticket, only when it clearly refers to that ticket. ignore: only for events that are not the owner's requests. Reply to an event with the reply tool instead.",
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          trigger: Type.String({ description: "Trigger ID, e.g. t12" }),
          kind: Type.Union([
            Type.Literal("accept"),
            Type.Literal("attach"),
            Type.Literal("ignore"),
          ]),
          agent: Type.Optional(
            Type.String({
              description: "accept: agent ID from your instructions",
            }),
          ),
          title: Type.Optional(
            Type.String({
              maxLength: 80,
              description: "accept: a few words naming the task",
            }),
          ),
          ack: Type.Optional(
            Type.String({
              maxLength: 600,
              description:
                "accept: one short sentence to the owner naming the intended result, in their language",
            }),
          ),
          ticket: Type.Optional(
            Type.String({ description: "attach: ticket ID, e.g. k3" }),
          ),
          note: Type.Optional(
            Type.String({
              maxLength: 1200,
              description:
                "accept/attach: facts the worker needs that the event does not contain (from memory or other tickets). Never a rewrite of the request.",
            }),
          ),
        }),
        { minItems: 1, maxItems: 20 },
      ),
    }),
    replay: "safe",
    execute: async ({ items }, api, context) => {
      const lines: string[] = [];
      for (const item of items) {
        try {
          lines.push(`${item.trigger}: ${await routeOne(item, api, context)}`);
        } catch (error) {
          lines.push(
            `${item.trigger}: not routed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return text(lines.join("\n"));
    },
  });
  async function routeOne(
    item: {
      trigger: string;
      kind: "accept" | "attach" | "ignore";
      agent?: string;
      title?: string;
      ack?: string;
      ticket?: string;
      note?: string;
    },
    api: ToolExecutionApi,
    context: Context,
  ): Promise<string> {
    const trigger = await engine.trigger(item.trigger, context);
    if (trigger.disposition?.kind === item.kind) {
      return `already ${item.kind}${trigger.disposition.tickets?.length ? ` (${trigger.disposition.tickets.join(", ")})` : ""}`;
    }
    if (item.kind === "ignore") {
      await inBatch(item.trigger, context);
      await api.commit((tx) => engine.ignore(tx, item.trigger), context);
      return "ignored";
    }
    await engine.requireOwnerBasis(item.trigger, context);
    if (item.kind === "attach") {
      if (!item.ticket) {
        throw new Error("attach needs a ticket");
      }
      const ticket = item.ticket;
      await api.commit(
        (tx) =>
          engine.attach(tx, {
            trigger: item.trigger,
            ticket,
            ...(item.note ? { note: item.note } : {}),
          }),
        context,
      );
      return `attached to ${ticket}`;
    }
    if (!item.agent || !item.title || !item.ack) {
      throw new Error("accept needs agent, title and ack");
    }
    const { agent, title, ack } = item;
    const own = await engine.openOwnThread(item.trigger, title, context);
    const id = await api.commit(
      (tx) =>
        engine.accept(tx, {
          trigger: item.trigger,
          agent,
          title,
          ack,
          ...(item.note ? { note: item.note } : {}),
          ...(own ? { own } : {}),
        }),
      context,
    );
    return `accepted as ${id}${own ? ` in thread ${own.key}` : ""}; the acknowledgement is sent`;
  }
  const reply = defineTool({
    name: REPLY,
    description:
      "Send a message to the owner. to: a trigger ID replies to that message; a ticket ID speaks in that ticket's thread (use it to relay a result or a worker's question); a thread key speaks there. Keep IM messages short: conclusions, decisions and one question at a time.",
    parameters: Type.Object({
      to: Type.String({ description: "t12, k3, or a thread key" }),
      text: Type.String({ minLength: 1, maxLength: 16000 }),
    }),
    replay: "safe",
    execute: async ({ to, text: message }, api, context) => {
      if (/^t[0-9]+$/.test(to)) {
        const trigger = await engine.trigger(to, context);
        if (!trigger.disposition) {
          await inBatch(to, context);
        }
      }
      const sent = await api.commit(
        (tx) =>
          engine.reply(tx, { to, text: message, key: String(api.taskId) }),
        context,
      );
      return text(`Sent to ${sent.thread}.`);
    },
  });
  const recallTool = defineTool({
    name: RECALL,
    description:
      'Read one object in full: a trigger (t12), a ticket (k3), a thread key, or "recent" for the latest events. Each result names related IDs you can recall next. Use offset to continue a truncated text.',
    parameters: Type.Object({
      ref: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: LIMITS.textMax }),
      ),
    }),
    replay: "safe",
    execute: async ({ ref, offset, limit }, _api, context) =>
      text(
        await recall(engine, ref, offset ?? 0, limit ?? LIMITS.text, context),
      ),
  });
  const list = defineTool({
    name: LIST_TICKETS,
    description: "List open tickets, or every ticket with all=true.",
    parameters: Type.Object({ all: Type.Optional(Type.Boolean()) }),
    replay: "safe",
    execute: async ({ all }, _api, context) => {
      const tickets = await engine.listTickets(context, all ?? false);
      return text(
        tickets.slice(-LIMITS.listMax).map(ticketLine).join("\n") ||
          "No tickets.",
      );
    },
  });
  const message = defineTool({
    name: MESSAGE_TICKET,
    description:
      "Give a ticket's worker information it needs: the owner's answer given elsewhere, or context from another ticket. A running worker sees it after its current step; an idle ticket resumes.",
    parameters: Type.Object({
      ticket: Type.String(),
      text: Type.String({ minLength: 1, maxLength: 16000 }),
    }),
    replay: "safe",
    execute: async ({ ticket, text: message }, api, context) => {
      await api.commit(
        (tx) => engine.messageTicket(tx, ticket, message, String(api.taskId)),
        context,
      );
      return text(`Delivered to ${ticket}.`);
    },
  });
  const stop = defineTool({
    name: STOP_TICKET,
    description:
      "Stop a ticket and its running work, because the owner asked for it.",
    parameters: Type.Object({
      ticket: Type.String(),
      basis: Type.String({
        description: "ID of the owner's message asking for this, e.g. t12",
      }),
    }),
    replay: "safe",
    execute: async ({ ticket, basis }, api, context) => {
      await engine.requireOwnerBasis(basis, context);
      const works = await api.commit(
        (tx) => engine.stopTicket(tx, ticket, "owner", "stopped by the owner"),
        context,
      );
      await engine.abortWorks(works, context);
      return text(`Stopped ${ticket}.`);
    },
  });
  return [route, reply, recallTool, list, message, stop];
}

export function ticketTools(engine: Engine): ToolRegistration[] {
  async function ticketOf(
    api: ToolExecutionApi,
    context: Context,
  ): Promise<string> {
    const ticket = await engine.ticketOf(api.conversationId, context);
    if (!ticket) {
      throw new Error("Only a ticket's worker follows threads");
    }
    return ticket;
  }
  const handback = defineTool({
    name: HANDBACK,
    description:
      "Hand an event that reached you back to Kaeno's router because it is not about your ticket. You will not see it again.",
    parameters: Type.Object({
      trigger: Type.String({
        description: "Trigger ID from the message header, e.g. t12",
      }),
      reason: Type.String({ minLength: 1, maxLength: 400 }),
    }),
    replay: "safe",
    execute: async ({ trigger, reason }, api, context) => {
      const ticket = await ticketOf(api, context);
      await api.commit(
        (tx) => engine.handback(tx, ticket, trigger, reason),
        context,
      );
      return text(`Handed ${trigger} back to the router.`);
    },
  });
  const unsubscribe = defineTool({
    name: UNSUBSCRIBE_THREAD,
    description:
      "Stop following a thread; its later events go to Kaeno's router instead of to you.",
    parameters: Type.Object({ thread: Type.String() }),
    replay: "safe",
    execute: async ({ thread }, api, context) => {
      const ticket = await ticketOf(api, context);
      await api.commit((tx) => engine.unsubscribe(tx, ticket, thread), context);
      return text(`No longer following ${thread}.`);
    },
  });
  const follow = defineTool({
    name: FOLLOW_THREAD,
    description:
      "Follow another thread that your ticket depends on, for example a pull request you opened, even before it has any events: its later events from the owner or the owner's systems reach you directly and wake you.",
    parameters: Type.Object({ thread: Type.String() }),
    replay: "safe",
    execute: async ({ thread }, api, context) => {
      const ticket = await ticketOf(api, context);
      await api.commit((tx) => engine.follow(tx, ticket, thread), context);
      return text(`Following ${thread}.`);
    },
  });
  return [handback, unsubscribe, follow];
}
