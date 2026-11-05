export const ROUTER_EXTENSION = "kaeno-router";
export const ROUTE = "route";
export const REPLY = "reply";
export const RECALL = "recall";
export const LIST_TICKETS = "list_tickets";
export const MESSAGE_TICKET = "message_ticket";
export const STOP_TICKET = "stop_ticket";
export const HANDBACK = "handback";
export const UNSUBSCRIBE_THREAD = "unsubscribe_thread";
export const FOLLOW_THREAD = "follow_thread";

export const ROUTER_TOOLS = {
  router: [ROUTE, REPLY, RECALL, LIST_TICKETS, MESSAGE_TICKET, STOP_TICKET],
  ticket: [HANDBACK, UNSUBSCRIBE_THREAD, FOLLOW_THREAD],
  readOnly: [RECALL, LIST_TICKETS],
} as const;
