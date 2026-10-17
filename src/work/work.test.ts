import type { JsonValue } from "@earendil-works/chord";
import type { TaskRecord } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import {
  createMockRuntime,
  createMockTransaction,
} from "../../test/mocks/durable.ts";
import { conversationId, taskId } from "../../test/mocks/identifiers.ts";
import { ArtifactStore, type RunManifest } from "../artifacts/index.ts";
import { Work, type WorkAgents, type WorkTurns } from "./index.ts";
vi.mock("../artifacts/index.ts", () => {
  // Canned run store: any identity resolves to one manifest; enough to test wiring.
  class ArtifactStore {
    public readonly root: string;
    constructor(root: string) {
      this.root = root;
    }
    runDirectory(identity: { workId: number; taskId: number }): string {
      return `work-${identity.workId}/task-${identity.taskId}`;
    }
    async readManifest(): Promise<RunManifest> {
      return {
        workId: 1,
        taskId: 1,
        conversationId: 1,
        pod: "pod-1",
        template: "swe",
        createdAt: "1970-01-01T00:00:00.000Z",
        finishedAt: "1970-01-01T00:00:00.000Z",
        roots: ["/workspace", "/home/agent"],
        capture: { truncated: false, bytes: 7, skippedByBlacklist: 0 },
        envdLog: true,
        podLog: true,
      };
    }
    async readFile(): Promise<Uint8Array> {
      return new TextEncoder().encode("hello");
    }
    async list(): Promise<string[]> {
      return ["manifest.json", "workspace/a.txt"];
    }
  }
  return { ArtifactStore };
});
vi.mock("@earendil-works/pi-durable", async () => {
  const { createMockSdk } = await import("../../test/mocks/sdk.ts");
  return createMockSdk();
});
vi.mock("../config/index.ts", () => ({
  PROVIDERS: ["anthropic", "openai"],
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
function setup(artifacts?: ArtifactStore): {
  work: Work;
  runtime: ReturnType<typeof createMockRuntime>;
  turns: WorkTurns;
  agents: WorkAgents;
} {
  const runtime = createMockRuntime(createMockTransaction());
  const coordinator = turns();
  const agents: WorkAgents = {
    captureWorkBlueprint: () => {
      throw new Error("Unexpected blueprint capture");
    },
    configureWorkConversation: vi.fn<WorkAgents["configureWorkConversation"]>(),
    provisionWorkSandbox: vi.fn<WorkAgents["provisionWorkSandbox"]>(),
    releaseWorkSandbox: vi.fn<WorkAgents["releaseWorkSandbox"]>(),
    sandboxPool: async () => ({ slots: 4, summary: "4 (test)" }),
  };
  const work = new Work(
    () => runtime,
    coordinator,
    { listWorkTemplates: () => [{ name: "root", description: "Root" }] },
    () => agents,
    artifacts,
  );
  return { work, runtime, turns: coordinator, agents };
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
it("publishes orchestration and parent tools and reports an empty directory without crossing Agent", async () => {
  const { work, agents } = setup();
  expect(work.orchestrationTools.map((tool) => tool.name)).toEqual([
    "start_work",
    "list_work",
    "inspect_work",
    "message_work",
    "cancel_work",
  ]);
  expect(work.parentTools.map((tool) => tool.name)).toEqual(["message_parent"]);
  expect(await work.listWork(conversationId(12))).toEqual([]);
  expect(agents.configureWorkConversation).not.toHaveBeenCalled();
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
it("annotates listed work with an artifacts summary when a store is wired", async () => {
  const { work, runtime } = setup(new ArtifactStore("/tmp/artifacts"));
  vi.spyOn(runtime, "snapshot").mockResolvedValue({
    launches: { call: taskId(24) },
  });
  vi.spyOn(runtime, "getTask").mockResolvedValue(pending());
  expect(await work.listWork(conversationId(12))).toEqual([
    {
      id: taskId(24),
      title: "Job",
      agent: "root",
      status: "starting",
      artifacts: { present: true, truncated: false, bytes: 7 },
    },
  ]);
});
it("lets the CHAT root read any run's artifacts", async () => {
  const { work, runtime } = setup(new ArtifactStore("/tmp/artifacts"));
  // Default snapshot returns undefined: no WorkScope means depth-0 root.
  expect(runtime.snapshot).toBeDefined();
  const listing = await work.readArtifacts(conversationId(12), taskId(24));
  expect(listing?.manifest.pod).toBe("pod-1");
  expect(listing?.files).toContain("workspace/a.txt");
});
it("enforces parent↔child artifacts access at retrieval", async () => {
  const { work, runtime } = setup(new ArtifactStore("/tmp/artifacts"));
  const snapshot = vi.spyOn(runtime, "snapshot");
  const caller = conversationId(12);
  // Own run: the caller's scope points at the run; no launch lookup happens.
  snapshot.mockResolvedValueOnce({ depth: 1, workId: taskId(24) });
  expect(await work.readArtifacts(caller, taskId(24))).not.toBeUndefined();
  // Child run: scope misses, the launch index holds the edge.
  snapshot.mockResolvedValueOnce({ depth: 1, workId: taskId(24) });
  snapshot.mockResolvedValueOnce({ launches: { call: taskId(9) } });
  expect(await work.readArtifacts(caller, taskId(9))).not.toBeUndefined();
  // Invisible run: scope misses and the launch index lacks it.
  snapshot.mockResolvedValueOnce({ depth: 1, workId: taskId(24) });
  snapshot.mockResolvedValueOnce({ launches: { call: taskId(9) } });
  expect(await work.readArtifacts(caller, taskId(31))).toBeUndefined();
  // Same edge rule for single files: scope misses, index lacks it.
  snapshot.mockResolvedValueOnce({ depth: 1, workId: taskId(24) });
  snapshot.mockResolvedValueOnce({ launches: { call: taskId(9) } });
  expect(await work.readArtifactFile(caller, taskId(31), "x")).toBeUndefined();
});
it("reports no artifacts without a wired store", async () => {
  const { work } = setup();
  expect(
    await work.readArtifacts(conversationId(12), taskId(24)),
  ).toBeUndefined();
});
