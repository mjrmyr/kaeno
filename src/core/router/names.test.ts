import { expect, it } from "vitest";
import { ROUTER_TOOLS } from "./index.ts";

it("keeps the router's tool order, which stored setups record", () => {
  expect(ROUTER_TOOLS.router).toEqual([
    "route",
    "reply",
    "recall",
    "list_tickets",
    "message_ticket",
    "stop_ticket",
  ]);
});
