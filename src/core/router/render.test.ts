import { expect, it } from "vitest";
import {
  LIMITS,
  recallThread,
  recallTicket,
  renderReport,
  renderTrigger,
  truncateWithRecall,
  stub,
} from "./index.ts";

const trigger = {
  key: "test:1",
  source: "telegram",
  threads: ["telegram:1"],
  actor: "owner",
  authority: "owner" as const,
  content: "x".repeat(LIMITS.text + 10),
  id: "t7",
  at: 0,
  mode: "explicit" as const,
};
const ticket = {
  id: "k2",
  title: "Flights",
  agent: "travel",
  createdAt: 0,
  updatedAt: 0,
  origin: "t1",
  conversation: 9,
  ownThread: "telegram:1/topic:5",
  followed: [],
  systemWakes: 0,
  replyThread: "telegram:1",
  status: "running" as const,
  assignments: [],
  pending: [],
  reports: [{ state: "waiting" as const, summary: "Which date?", at: 0 }],
};

it("spills long text behind a pointer that recall can follow", () => {
  expect(truncateWithRecall("short", 10, "t1")).toBe("short");
  expect(truncateWithRecall("abcdefghij", 4, "t1")).toBe(
    "abcd… [6 more characters: recall t1 offset=4]",
  );
  expect(truncateWithRecall("abcdefghij", 4, "t1", 4)).toBe(
    "efgh… [2 more characters: recall t1 offset=8]",
  );
  expect(stub("one\n two   three", 7)).toBe("one two…");
});

it("inlines a trigger's thread, followers and open tickets, and spills its text", () => {
  const rendered = renderTrigger(trigger, [ticket], [ticket]);
  expect(typeof rendered).toBe("string");
  expect(rendered).toContain('<trigger id="t7" thread="telegram:1"');
  expect(rendered).toContain('followed by: k2 "Flights" [waiting]');
  expect(rendered).toContain('open tickets: k2 "Flights" [waiting]');
  expect(rendered).toContain(`recall t7 offset=${LIMITS.text}`);
});

it("keeps images of a trigger as image blocks", () => {
  const rendered = renderTrigger(
    {
      ...trigger,
      content: [
        { type: "text", text: "look" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    },
    [],
    [],
  );
  expect(rendered).toEqual([
    { type: "text", text: expect.stringContaining("look") },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ]);
});

it("renders a report with its ticket's thread, and recalls a thread newest first", () => {
  expect(renderReport(ticket, ticket.reports[0])).toBe(
    '<report ticket="k2" title="Flights" state="waiting" thread="telegram:1/topic:5">\nWhich date?\n</report>',
  );
  const recalled = recallThread(
    {
      key: "telegram:1",
      createdAt: 1,
      lastAt: 1,
      subscribers: [],
      recent: [],
    },
    [],
    [
      { ...trigger, id: "t1", content: "old" },
      {
        ...trigger,
        id: "t2",
        content: "new",
        disposition: { kind: "accept", tickets: ["k2"], at: 0 },
      },
    ],
  );
  expect(recalled.indexOf("t2 [accept k2]: new")).toBeLessThan(
    recalled.indexOf("t1: old"),
  );
});

it("continues a long report from the ticket's recall pointer", () => {
  const long = {
    ...ticket,
    reports: [
      {
        state: "ready" as const,
        summary: "a".repeat(10) + "b".repeat(5),
        at: 0,
      },
    ],
  };
  expect(recallTicket(long, undefined, [], 0, 10)).toContain(
    `${"a".repeat(10)}… [5 more characters: recall k2 offset=10]`,
  );
  expect(recallTicket(long, undefined, [], 10, 10)).toContain("- ready: bbbbb");
});
