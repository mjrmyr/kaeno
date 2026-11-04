/** The one list of router and ticket protocol names. The router registers tools from these; hosts approve from them. */
export const ROUTER_EXTENSION = "kaeno-router";
export const ROUTE = "route";
export const REPLY = "reply";
export const RECALL = "recall";
export const LIST_TICKETS = "list_tickets";
export const MESSAGE_TICKET = "message_ticket";
export const STOP_TICKET = "stop_ticket";
/** Tools of a ticket's root worker for its threads; reporting itself is WORK's `report`. */
export const HANDBACK = "handback";
export const UNSUBSCRIBE_THREAD = "unsubscribe_thread";
export const FOLLOW_THREAD = "follow_thread";

export const ROUTER_TOOLS = {
  /** Order is registration order and appears in stored setups; do not reorder. */
  router: [ROUTE, REPLY, RECALL, LIST_TICKETS, MESSAGE_TICKET, STOP_TICKET],
  ticket: [HANDBACK, UNSUBSCRIBE_THREAD, FOLLOW_THREAD],
  readOnly: [RECALL, LIST_TICKETS],
} as const;
