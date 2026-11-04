// Inline & Spill: what the router sees of each object. Inline what is likely needed next, cap the rest
// and leave a pointer to it, and name related objects by ID so recall can follow them hop by hop.
import type { UserInput } from "@earendil-works/pi-durable";
import type { Stored } from "../durable/index.ts";
import {
  LIMITS,
  latestReport,
  ticketState,
  type ThreadRecord,
  type TicketRecord,
  type TicketReport,
  type TriggerRecord,
} from "./model.ts";

type Ticket = Readonly<Stored<TicketRecord>>;
type Trigger = Readonly<Stored<TriggerRecord>>;
type Thread = Readonly<Stored<ThreadRecord>>;

export function contentText(content: Stored<UserInput> | UserInput): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}
function images(content: Stored<UserInput> | UserInput) {
  return typeof content === "string"
    ? []
    : content.flatMap((block) =>
        block.type === "image"
          ? [
              {
                type: "image" as const,
                data: block.data,
                mimeType: block.mimeType,
              },
            ]
          : [],
      );
}
/** Text from `offset`, capped at `limit`, with a pointer to the rest. */
export function spill(
  text: string,
  limit: number,
  ref: string,
  offset = 0,
): string {
  const end = offset + limit;
  if (text.length <= end) {
    return text.slice(offset);
  }
  return `${text.slice(offset, end)}… [${text.length - end} more characters: recall ${ref} offset=${end}]`;
}
/** One line: the start of a text, for an object the model only needs to recognise. */
export function stub(text: string, limit: number = LIMITS.stub): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= limit ? line : `${line.slice(0, limit)}…`;
}
export function ticketLine(ticket: Ticket): string {
  return `${ticket.id} "${ticket.title}" [${ticketState(ticket)}]`;
}
function attribute(name: string, value: string | undefined): string {
  return value === undefined ? "" : ` ${name}="${value.replaceAll('"', "'")}"`;
}

/** A trigger as the router receives it: ID, where it came from, who follows its thread, and its content. */
export function renderTrigger(
  trigger: Trigger,
  followers: readonly Ticket[],
  open: readonly Ticket[],
): UserInput {
  const lines = [
    `<trigger${attribute("id", trigger.id)}${attribute("thread", trigger.threads[0])}${attribute("source", trigger.source)}${attribute("authority", trigger.authority)}${attribute("mode", trigger.mode)}>`,
  ];
  if (trigger.quote !== undefined) {
    lines.push(`replying to: "${stub(trigger.quote)}"`);
  }
  if (followers.length) {
    lines.push(`followed by: ${followers.map(ticketLine).join(", ")}`);
  }
  if (open.length) {
    lines.push(
      `open tickets: ${open
        .slice(-LIMITS.list)
        .map(ticketLine)
        .join(
          ", ",
        )}${open.length > LIMITS.list ? ` (+${open.length - LIMITS.list}: list_tickets)` : ""}`,
    );
  }
  lines.push(
    spill(contentText(trigger.content), LIMITS.text, trigger.id),
    "</trigger>",
  );
  const text = lines.join("\n");
  const attached = images(trigger.content);
  return attached.length ? [{ type: "text", text }, ...attached] : text;
}

/** A worker report relayed to the router. Report text is data from the worker, never instructions. */
export function renderReport(ticket: Ticket, report: TicketReport): string {
  return [
    `<report${attribute("ticket", ticket.id)}${attribute("title", ticket.title)}${attribute("state", report.state)}${attribute("thread", ticket.threads[0] ?? ticket.replyThread)}>`,
    spill(report.summary, LIMITS.near, ticket.id),
    "</report>",
  ].join("\n");
}

/** A trigger that went straight to its subscribers: the router sees it without being asked to act. */
export function renderPassed(
  trigger: Trigger,
  tickets: readonly Ticket[],
): string {
  return `<passed${attribute("trigger", trigger.id)}${attribute("thread", trigger.threads[0])}${attribute("to", tickets.map((ticket) => ticket.id).join(" "))}>${stub(contentText(trigger.content), LIMITS.mid)}</passed>`;
}

function renderReports(
  reports: readonly Readonly<Stored<TicketReport>>[],
): string[] {
  const shown = reports.slice(-5);
  return shown.map(
    (report, index) =>
      `- ${report.state}: ${index === shown.length - 1 ? spill(report.summary, LIMITS.near, "") : stub(report.summary, LIMITS.mid)}`,
  );
}

export function recallTicket(
  ticket: Ticket,
  origin: Trigger | undefined,
  inputs: readonly Trigger[],
): string {
  const report = latestReport(ticket);
  return [
    `<ticket${attribute("id", ticket.id)}${attribute("title", ticket.title)}${attribute("state", ticketState(ticket))}${attribute("agent", ticket.agent)}>`,
    `threads: ${ticket.threads.join(", ") || `(none; replies go to ${ticket.replyThread})`}`,
    `origin: ${origin ? `${origin.id} "${stub(contentText(origin.content))}"` : ticket.origin}`,
    ...(inputs.length
      ? [
          `inputs: ${inputs
            .slice(-LIMITS.list)
            .map((input) => `${input.id} "${stub(contentText(input.content))}"`)
            .join(", ")}`,
        ]
      : []),
    `assignments: ${ticket.assignments.map((assignment) => `work #${assignment.workId}${assignment.endedAt === undefined ? " (live)" : ""}`).join(", ") || "none yet"}`,
    ...(ticket.pending.length
      ? [`pending inputs: ${ticket.pending.length}`]
      : []),
    ...(ticket.ended
      ? [`ended by ${ticket.ended.by}: ${ticket.ended.reason}`]
      : []),
    ...(report
      ? ["reports (newest last):", ...renderReports(ticket.reports)]
      : []),
    "</ticket>",
  ].join("\n");
}

export function recallThread(
  thread: Thread,
  followers: readonly Ticket[],
  triggers: readonly Trigger[],
): string {
  const newest = triggers.slice(-LIMITS.list).toReversed();
  return [
    `<thread${attribute("key", thread.key)}${attribute("channel", thread.route?.channel)}>`,
    `followed by: ${followers.map(ticketLine).join(", ") || "nobody"}`,
    "recent events (newest first):",
    ...newest.map((trigger, index) => {
      const text = contentText(trigger.content);
      // Locality: the newest events in full, the next ones shortened, the rest as stubs.
      let body = stub(text);
      if (index < 2) {
        body = spill(text, LIMITS.near, trigger.id);
      } else if (index < 7) {
        body = stub(text, LIMITS.mid);
      }
      return `- ${trigger.id}${trigger.disposition ? ` [${trigger.disposition.kind}${trigger.disposition.tickets?.length ? ` ${trigger.disposition.tickets.join(" ")}` : ""}]` : ""}: ${body}`;
    }),
    "</thread>",
  ].join("\n");
}

export function recallTrigger(
  trigger: Trigger,
  tickets: readonly Ticket[],
  offset: number,
  limit: number,
): string {
  return [
    `<trigger${attribute("id", trigger.id)}${attribute("threads", trigger.threads.join(" "))}${attribute("source", trigger.source)}${attribute("authority", trigger.authority)}${attribute("disposition", trigger.disposition?.kind)}>`,
    ...(tickets.length
      ? [`tickets: ${tickets.map(ticketLine).join(", ")}`]
      : []),
    ...(trigger.quote === undefined
      ? []
      : [`replying to: "${stub(trigger.quote, LIMITS.mid)}"`]),
    spill(contentText(trigger.content), limit, trigger.id, offset),
    "</trigger>",
  ].join("\n");
}
