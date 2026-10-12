import type { JsonValue } from "@earendil-works/chord";
import type { TaskRecord } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import {
  createMockRuntime,
  createMockTransaction,
} from "../../test/mocks/durable.ts";
import { conversationId, taskId } from "../../test/mocks/identifiers.ts";
import { Work, type WorkAgents, type WorkTurns } from "./index.ts";
vi.mock("@earendil-works/pi-durable", async () => {
  const { createMockSdk } = await import("../../test/mocks/sdk.ts");
  return createMockSdk();
});
vi.mock("../config/index.ts", () => ({
  PROVIDERS: ["anthropic", "openai"],
  CODING_TOOLS: ["read", "write", "edit", "bash"],
}));
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
  agents: WorkAgents;
} {
  const runtime = createMockRuntime(createMockTransaction());
  const coordinator = turns();
  const agents: WorkAgents = {
    configureWorkConversation: vi.fn<WorkAgents["configureWorkConversation"]>(),
    isWorkClean: vi.fn<WorkAgents["isWorkClean"]>().mockResolvedValue(true),
  };
  const work = new Work(
    () => runtime,
    coordinator,
    { listWorkTemplates: () => [{ name: "root", description: "Root" }] },
    () => agents,
    () => ({
      captureWorkBlueprint: () => {
        throw new Error("Unexpected blueprint capture");
      },
    }),
  );
  return { work, runtime, turns: coordinator, agents };
}
function pending(): TaskRecord<JsonValue, JsonValue, unknown> {
  return {
    id: taskId(24),
    conversationId: conversationId(12),
    kind: "kaeno.work",
    version: 1,
    input: { title: "Job" },
    background: true,
    abortRequested: false,
    state: { status: "pending", checkpoint: { phase: "start" } },
  };
}
it("publishes named work capabilities and reports an empty directory without crossing Agent", async () => {
  const { work, agents } = setup();
  expect(work.tools.map((tool) => tool.name)).toEqual([
    "start_work",
    "list_work",
    "cancel_work",
  ]);
  expect(await work.listWork(conversationId(12))).toEqual([]);
  expect(agents.isWorkClean).not.toHaveBeenCalled();
});
it("lists only indexed work through the injected SDK runtime", async () => {
  const { work, runtime } = setup();
  vi.spyOn(runtime, "snapshot").mockResolvedValue({
    launches: { request: taskId(24) },
  });
  vi.spyOn(runtime, "getTask").mockResolvedValue(pending());
  expect(await work.listWork(conversationId(12))).toEqual([
    { id: taskId(24), title: "Job", status: "pending" },
  ]);
});
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
it("keeps terminal aborted work cancelling until the injected Agent confirms cleanup", async () => {
  const { work, runtime, agents } = setup();
  vi.spyOn(runtime, "snapshot").mockResolvedValue({
    launches: { request: taskId(24) },
  });
  const { memos: _memos, ...record } = pending();
  vi.spyOn(runtime, "getTask").mockResolvedValue({
    ...record,
    abortRequested: true,
    state: { status: "terminal", outcome: { status: "aborted" } },
  });
  vi.mocked(agents.isWorkClean).mockResolvedValue(false);
  expect((await work.listWork(conversationId(12)))[0].status).toBe(
    "cancelling",
  );
  vi.mocked(agents.isWorkClean).mockResolvedValue(true);
  expect((await work.listWork(conversationId(12)))[0].status).toBe("aborted");
});
