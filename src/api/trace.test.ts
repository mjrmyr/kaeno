import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentEventStream } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { conversationId } from "../../test/mocks/identifiers.ts";
import { traceConversation, type ConversationEvents } from "./index.ts";
function stream(): AgentEventStream {
  return {
    snapshot: {
      type: "snapshot",
      entries: [],
      tools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
    },
    start: vi.fn<AgentEventStream["start"]>(),
    stop: vi
      .fn<AgentEventStream["stop"]>()
      .mockResolvedValue({ reason: "stopped" }),
    closed: Promise.resolve({ reason: "stopped" }),
  };
}
it("attaches and disposes an injected SDK event stream without owning the conversation", async () => {
  const events = stream();
  const source: ConversationEvents = {
    watchConversation: vi
      .fn<ConversationEvents["watchConversation"]>()
      .mockResolvedValue(events),
  };
  const stop = await traceConversation(
    source,
    conversationId(12),
    vi.fn<(line: string) => void>(),
    BACKGROUND_CONTEXT,
  );
  expect(source.watchConversation).toHaveBeenCalledWith(
    conversationId(12),
    BACKGROUND_CONTEXT,
  );
  await stop();
  expect(events.stop).toHaveBeenCalledOnce();
});
it("formats public SDK events through the registered listener", async () => {
  const events = stream();
  const emit = vi.fn<(line: string) => void>();
  await traceConversation(
    { watchConversation: async () => events },
    conversationId(12),
    emit,
    BACKGROUND_CONTEXT,
  );
  const listener = vi.mocked(events.start).mock.calls[0][0];
  await listener(
    [
      {
        type: "tool_execution_start",
        toolName: "start_work",
        toolCallId: "call",
        args: { agent: "worker", title: "Plan", brief: "Do it" },
      },
    ],
    BACKGROUND_CONTEXT,
  );
  expect(emit).toHaveBeenCalledWith("▸ starting work: Plan");
});
