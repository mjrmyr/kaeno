import type { JsonValue } from "@earendil-works/chord";
import type { TaskRecord } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import {
  createMockRuntime,
  createMockTransaction,
} from "../../../test/mocks/durable.ts";
import { conversationId, taskId } from "../../../test/mocks/identifiers.ts";
import {
  listWork,
  NoWorkSlot,
  Work,
  WorkIndex,
  WorkScope,
  type WorkReports,
} from "./index.ts";
vi.mock("@earendil-works/pi-durable", async () => {
  const { createMockSdk } = await import("../../../test/mocks/sdk.ts");
  return createMockSdk();
});
function reports(): WorkReports {
  return {
    report: vi.fn<WorkReports["report"]>().mockResolvedValue(undefined),
    ended: vi.fn<WorkReports["ended"]>().mockResolvedValue(undefined),
    retainedConversations: vi
      .fn<WorkReports["retainedConversations"]>()
      .mockResolvedValue([]),
  };
}
function setup(): {
  work: Work;
  runtime: ReturnType<typeof createMockRuntime>;
  reports: WorkReports;
} {
  const runtime = createMockRuntime(createMockTransaction());
  const sink = reports();
  const work = new Work(() => runtime, sink, {
    agents: [
      {
        id: "local:root",
        description: "Root",
        setup: { model: { provider: "faux", modelId: "x" }, instructions: "" },
      },
    ],
    surface: () => ({ tools: new Map(), extensions: new Map() }),
    maxDepth: 2,
    maxConcurrent: 4,
  });
  return { work, runtime, reports: sink };
}
function pending(): TaskRecord<JsonValue, JsonValue, unknown> {
  return {
    id: taskId(24),
    conversationId: conversationId(12),
    kind: "kaeno.work",
    version: 1,
    input: { title: "Job", agent: "root" },
    background: true,
    abortRequested: false,
    state: { status: "pending", checkpoint: { phase: "start" } },
  };
}
it("publishes orchestration and parent tools and reports an empty directory", async () => {
  const { work, runtime } = setup();
  expect(work.orchestrationTools.map((tool) => tool.name)).toEqual([
    "start_work",
    "list_work",
    "inspect_work",
    "message_work",
    "cancel_work",
  ]);
  expect(work.parentTools.map((tool) => tool.name)).toEqual([
    "message_parent",
    "report",
  ]);
  expect(await listWork(() => runtime, conversationId(12))).toEqual([]);
  expect(work.describeAgents()).toContain("- local:root: Root");
  expect(work.resolveAgent("root")).toBe("local:root");
});
it("preserves the durable task and document identities behind the public API", () => {
  const { work } = setup();
  expect(work.extension.name).toBe("kaeno-work");
  expect(work.extension.tasks).toHaveLength(1);
  const definition = work.extension.tasks?.[0].definition;
  expect(definition).toMatchObject({ name: "kaeno.work", version: 4 });
  expect(Object.keys(definition?.phases ?? {})).toEqual([
    "start",
    "supervise",
    "message",
    "report",
  ]);
  expect(WorkIndex.definition).toMatchObject({
    kind: "kaeno.work-index",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
  });
  expect(WorkIndex.definition.initial()).toEqual({ launches: {} });
  expect(WorkScope.definition).toMatchObject({
    kind: "kaeno.work-node",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
  });
  expect(WorkScope.definition.initial()).toEqual({
    workId: null,
    depth: 0,
    maxDepth: null,
    agent: null,
    plan: null,
    mailbox: null,
    question: null,
    progress: null,
    outcome: null,
  });
  expect(work.extension.tools).toEqual([
    ...work.orchestrationTools,
    ...work.parentTools,
  ]);
  expect(work.extension.tools?.every((tool) => tool.replay === "safe")).toBe(
    true,
  );
});
const states: [
  TaskRecord<JsonValue, JsonValue, unknown>["state"],
  boolean,
  string,
][] = [
  [{ status: "pending", checkpoint: { phase: "start" } }, false, "starting"],
  [
    { status: "running", checkpoint: { phase: "supervise", sent: 0 } },
    false,
    "running",
  ],
  [
    {
      status: "running",
      checkpoint: { phase: "message", sent: 1, seen: 3, message: "Which?" },
    },
    false,
    "awaiting-reply",
  ],
  [
    {
      status: "running",
      checkpoint: { phase: "supervise", sent: 1, awaiting: "reply" },
    },
    false,
    "awaiting-reply",
  ],
  [
    {
      status: "running",
      checkpoint: { phase: "supervise", sent: 0, awaiting: "children" },
    },
    false,
    "waiting-for-children",
  ],
  [
    { status: "running", checkpoint: { phase: "supervise", sent: 0 } },
    true,
    "cancelling",
  ],
  [
    {
      status: "terminal",
      outcome: {
        status: "completed",
        result: { status: "failed", text: "x" },
      },
    },
    false,
    "failed",
  ],
  [{ status: "terminal", outcome: { status: "aborted" } }, true, "aborted"],
];
it.each(states)(
  "lists indexed work with a status derived from its durable state (%j)",
  async (state, abortRequested, status) => {
    const { runtime } = setup();
    vi.spyOn(runtime, "snapshot").mockResolvedValue({
      launches: { call: taskId(24) },
    });
    const { memos: _memos, ...record } = pending();
    const base = { ...record, abortRequested };
    vi.spyOn(runtime, "getTask").mockResolvedValue(
      state.status === "terminal" || state.status === "completing"
        ? { ...base, state }
        : { ...base, state },
    );
    expect(await listWork(() => runtime, conversationId(12))).toEqual([
      { id: taskId(24), title: "Job", agent: "root", status },
    ]);
  },
);
it("recognizes a full slot so the router can queue a ticket instead of failing it", () => {
  const { work } = setup();
  expect(work.isNoSlot(new NoWorkSlot("full"))).toBe(true);
  expect(work.isNoSlot(new Error("full"))).toBe(false);
});
