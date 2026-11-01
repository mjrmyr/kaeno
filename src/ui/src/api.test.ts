import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());
function mockResponse(value: unknown, status = 200) {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(value), { status }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
describe("HTTP boundary", () => {
  it("uses the host's thread and reply shapes", async () => {
    mockResponse([{ key: "web:example", conversationId: 7, createdAt: 10 }]);
    expect(await api.threads()).toHaveLength(1);
    mockResponse({
      replies: [
        {
          id: 1,
          requestId: "request-1",
          text: "Ready",
          source: { kind: "activity-result", activityId: 4, label: "Review" },
          epoch: 0,
        },
      ],
      next: 1,
      truncated: true,
    });
    expect((await api.replies("web:example")).truncated).toBe(true);
  });
  it("rejects malformed responses at the boundary", async () => {
    mockResponse({ replies: "not a page" });
    await expect(api.replies("example")).rejects.toThrow(
      "unsupported response",
    );
  });
  it("does not render arbitrary server error bodies", async () => {
    mockResponse({ error: "secret internal details" }, 400);
    await expect(api.stop("example")).rejects.toThrow("HTTP 400");
  });
  it("sends the exact turn contract with a stable request ID", async () => {
    const fetcher = mockResponse({ taskId: 42 });
    await api.send("web:example", "Hello", "ui:request-1");
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/threads/web%3Aexample/turn",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "Hello", requestId: "ui:request-1" }),
      }),
    );
  });
});
