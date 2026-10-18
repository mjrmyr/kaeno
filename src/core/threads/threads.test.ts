import type { JsonObject, TaskRecord } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import {
  createMockRuntime,
  createMockTransaction,
} from "../../../test/mocks/durable.ts";
import { conversationId, taskId } from "../../../test/mocks/identifiers.ts";
import { ThreadDirectory, type ChatAgent } from "./index.ts";
vi.mock("@earendil-works/pi-durable", async () => {
  const { createMockSdk } = await import("../../../test/mocks/sdk.ts");
  return createMockSdk();
});
it("creates a conversation and asks the injected Agent to configure it in the same transaction", async () => {
  const tx = createMockTransaction();
  const id = conversationId(12);
  vi.mocked(tx.createConversation).mockResolvedValue({ id });
  const runtime = createMockRuntime(tx);
  const agent: ChatAgent = {
    configureChatConversation: vi
      .fn<ChatAgent["configureChatConversation"]>()
      .mockResolvedValue(undefined),
  };
  const directory = new ThreadDirectory(() => runtime, agent);
  expect(await directory.getOrCreateConversation("api:one")).toBe(id);
  expect(tx.createConversation).toHaveBeenCalledWith({
    ownership: { kind: "ownerless" },
  });
  expect(agent.configureChatConversation).toHaveBeenCalledWith(tx, id);
});
it("propagates configuration failure to the transaction owner", async () => {
  const tx = createMockTransaction();
  vi.mocked(tx.createConversation).mockResolvedValue({
    id: conversationId(12),
  });
  const failure = new Error("configuration failed");
  const agent: ChatAgent = {
    configureChatConversation: vi
      .fn<ChatAgent["configureChatConversation"]>()
      .mockRejectedValue(failure),
  };
  const runtime = createMockRuntime(tx);
  await expect(
    new ThreadDirectory(() => runtime, agent).getOrCreateConversation(
      "api:one",
    ),
  ).rejects.toBe(failure);
});
it("lists conversations through the SDK boundary without calling Agent", async () => {
  const runtime = createMockRuntime();
  const id = conversationId(12);
  vi.spyOn(runtime, "snapshot").mockResolvedValue({
    threads: { "api:one": { conversationId: id, createdAt: 123 } },
  });
  const agent: ChatAgent = {
    configureChatConversation: vi.fn<ChatAgent["configureChatConversation"]>(),
  };
  expect(
    await new ThreadDirectory(() => runtime, agent).listConversations(),
  ).toEqual([{ key: "api:one", conversationId: id, createdAt: 123 }]);
  expect(agent.configureChatConversation).not.toHaveBeenCalled();
});
it.each(["foreground", "background-turn", "background-activity"])(
  "refreshes only idle conversations with $0 tasks",
  async (kind) => {
    const tx = createMockTransaction();
    const id = conversationId(12);
    const record: TaskRecord<null, JsonObject, null> = {
      id: taskId(24),
      conversationId: id,
      kind: kind === "background-turn" ? "kaeno.turn" : "example.activity",
      version: 1,
      input: null,
      background: kind !== "foreground",
      abortRequested: false,
      state: { status: "pending", checkpoint: { phase: "hold" } },
    };
    vi.mocked(tx.scanTasks).mockResolvedValue({ items: [record] });
    const runtime = createMockRuntime(tx);
    vi.spyOn(runtime, "snapshot").mockResolvedValue({
      threads: { "api:one": { conversationId: id, createdAt: 123 } },
    });
    const agent: ChatAgent = {
      configureChatConversation: vi
        .fn<ChatAgent["configureChatConversation"]>()
        .mockResolvedValue(undefined),
    };
    await new ThreadDirectory(() => runtime, agent).refreshIdleConversations();
    expect(agent.configureChatConversation).toHaveBeenCalledTimes(
      kind === "background-activity" ? 1 : 0,
    );
  },
);
