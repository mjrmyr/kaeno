import type { JsonValue } from "@earendil-works/chord";
import type { TaskRecord } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import {
  createMockRuntime,
  createMockTransaction,
} from "../../../test/mocks/durable.ts";
import { conversationId, taskId } from "../../../test/mocks/identifiers.ts";
import { Work, type WorkTurns } from "./index.ts";
vi.mock("@earendil-works/pi-durable", async () => {
  const { createMockSdk } = await import("../../../test/mocks/sdk.ts");
  return createMockSdk();
});
function turns(): WorkTurns {
  return {
    getActiveTurn: async () => {
      throw new Error("Unexpected turn lookup");
    },
    isOriginFenced: vi
      .fn<WorkTurns["isOriginFenced"]>()
      .mockResolvedValue(false),
    getPendingReportIds: vi
      .fn<WorkTurns["getPendingReportIds"]>()
      .mockResolvedValue([]),
    suppressWorkReports: vi
      .fn<WorkTurns["suppressWorkReports"]>()
      .mockResolvedValue(undefined),
    admitWorkReport: vi.fn<WorkTurns["admitWorkReport"]>(),
    admitWorkCancellation: vi.fn<WorkTurns["admitWorkCancellation"]>(),
  };
}
function setup(): {
  work: Work;
  runtime: ReturnType<typeof createMockRuntime>;
  turns: WorkTurns;
} {
  const runtime = createMockRuntime(createMockTransaction());
  const coordinator = turns();
  const work = new Work(() => runtime, coordinator, {
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
  return { work, runtime, turns: coordinator };
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
  const { work } = setup();
  expect(work.orchestrationTools.map((tool) => tool.name)).toEqual([
    "start_work",
    "list_work",
    "inspect_work",
    "message_work",
    "cancel_work",
  ]);
  expect(work.parentTools.map((tool) => tool.name)).toEqual(["message_parent"]);
  expect(await work.listWork(conversationId(12))).toEqual([]);
  expect(work.describeForChat()).toContain("- local:root: Root");
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
    const { work, runtime } = setup();
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
    expect(await work.listWork(conversationId(12))).toEqual([
      { id: taskId(24), title: "Job", agent: "root", status },
    ]);
  },
);
it("rejects cross-chat cancellation before suppressing reports or aborting a task", async () => {
  const { work, runtime, turns } = setup();
  await expect(work.cancelWork(conversationId(12), taskId(24))).rejects.toThrow(
    /belongs to this chat/,
  );
  expect(turns.suppressWorkReports).not.toHaveBeenCalled();
  expect(runtime.abortTask).not.toHaveBeenCalled();
});
it("suppresses reports in a transaction before requesting an abort", async () => {
  const { work, runtime, turns } = setup();
  vi.spyOn(runtime, "snapshot").mockResolvedValue({
    launches: { request: taskId(24) },
  });
  vi.spyOn(runtime, "getTask").mockResolvedValue(pending());
  const operations: string[] = [];
  vi.mocked(turns.suppressWorkReports).mockImplementation(async () => {
    operations.push("suppress");
  });
  vi.mocked(runtime.abortTask).mockImplementation(async () => {
    operations.push("abort");
    return "marked";
  });
  expect(await work.cancelWork(conversationId(12), taskId(24))).toEqual([
    taskId(24),
  ]);
  expect(operations).toEqual(["suppress", "abort"]);
});
