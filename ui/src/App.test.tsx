import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const thread = {
  key: "project:alpha",
  conversationId: 1,
  createdAt: 1700000000000,
};
const page = (text = "", requestId = "initial-request") => ({
  replies: text
    ? [{ id: 1, requestId, text, source: { kind: "user" }, epoch: 0 }]
    : [],
  next: text ? 1 : 0,
  truncated: false,
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setupFetch(threads: unknown[] = []) {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/v1/threads") return json(threads);
    if (url.includes("/replies")) return json(page());
    if (options?.method === "POST") return json({ taskId: 2 }, 202);
    throw new Error(`Unexpected URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function openThread() {
  await userEvent.click(
    await screen.findByRole("button", { name: /project:alpha/ }),
  );
  await screen.findByText("A fresh page in this conversation.");
}
describe("workspace", () => {
  it("renders an accessible empty state without creating a thread", async () => {
    const fetcher = setupFetch();
    render(<App />);
    await screen.findByText("Your next idea starts here.");
    expect(
      screen.getByRole("heading", { name: "What’s on your mind?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Message Kaeno" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("creates a new web thread only when a nonempty message is submitted", async () => {
    const fetcher = setupFetch();
    render(<App />);
    await screen.findByText("Your next idea starts here.");
    fireEvent.change(screen.getByRole("textbox", { name: "Message Kaeno" }), {
      target: { value: "First idea" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Accepted · awaiting reply");
    const post = fetcher.mock.calls.find(([url]) => url.endsWith("/turn"));
    expect(post?.[0]).toMatch(/^\/v1\/threads\/web%3A[0-9a-f-]+\/turn$/);
    expect(JSON.parse(post![1]!.body as string)).toMatchObject({
      text: "First idea",
      requestId: expect.stringMatching(/^ui:/),
    });
  });
  it("supports mobile navigation dismissal and returns keyboard focus", async () => {
    setupFetch();
    render(<App />);
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });
  it("has useful connection errors and retry", async () => {
    const fetcher = setupFetch();
    fetcher.mockRejectedValueOnce(new Error("Host offline"));
    render(<App />);
    await screen.findByText("Host offline");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Your next idea starts here.");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("submits a real turn and displays polled replies without claiming worker progress", async () => {
    const fetcher = setupFetch([thread]);
    let requestId = "";
    fetcher.mockImplementation(async (url, options) => {
      if (url === "/v1/threads") return json([thread]);
      if (url.includes("/turn")) {
        requestId = JSON.parse(options!.body as string).requestId;
        return json({ taskId: 2 }, 202);
      }
      return json(page(requestId ? "Here is your real reply" : "", requestId));
    });
    render(<App />);
    await openThread();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Message Kaeno" }),
      "Plan the project",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Here is your real reply");
    expect(
      screen.getByText("Plan the project", { selector: ".message-body p" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Reply received")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/threads/project%3Aalpha/turn",
      expect.objectContaining({ method: "POST" }),
    );
    expect(screen.queryByText("In progress")).not.toBeInTheDocument();
  });
  it("retries uncertain admission with the same request ID", async () => {
    const fetcher = setupFetch([thread]);
    const posted: string[] = [];
    fetcher.mockImplementation(async (url, options) => {
      if (url === "/v1/threads") return json([thread]);
      if (url.includes("/turn")) {
        posted.push(options!.body as string);
        if (posted.length === 1) throw new Error("Connection lost");
        return json({ taskId: 2 }, 202);
      }
      return json(page());
    });
    render(<App />);
    await openThread();
    fireEvent.change(screen.getByRole("textbox", { name: "Message Kaeno" }), {
      target: { value: "Do this once" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Retry same request" }),
    );
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[0]).toBe(posted[1]);
  });
  it("filters threads and keeps drafts separate", async () => {
    setupFetch([thread]);
    render(<App />);
    await openThread();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Message Kaeno" }),
      "Alpha draft",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /New conversation/ }),
    );
    expect(screen.getByRole("textbox", { name: "Message Kaeno" })).toHaveValue(
      "",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /project:alpha/ }),
    );
    expect(screen.getByRole("textbox", { name: "Message Kaeno" })).toHaveValue(
      "Alpha draft",
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Find a conversation" }),
      "does-not-exist",
    );
    expect(screen.getByText("No matching conversations.")).toBeInTheDocument();
  });
  it("requests stop through the API without claiming all work has stopped", async () => {
    const fetcher = setupFetch([thread]);
    render(<App />);
    await openThread();
    await userEvent.click(screen.getByRole("button", { name: "Request stop" }));
    await screen.findByText(/not confirmation that all work has stopped/);
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/threads/project%3Aalpha/stop",
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("isolates stale thread responses when switching conversations", async () => {
    const second = { ...thread, key: "project:beta", conversationId: 2 };
    let resolveAlpha!: (value: Response) => void;
    const fetcher = setupFetch([thread, second]);
    fetcher.mockImplementation(async (url) => {
      if (url === "/v1/threads") return json([thread, second]);
      if (url.includes("alpha"))
        return new Promise<Response>((resolve) => {
          resolveAlpha = resolve;
        });
      return json(page("Beta reply"));
    });
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: /project:alpha/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: /project:beta/ }));
    await screen.findByText("Beta reply");
    await act(async () => {
      resolveAlpha(json(page("Stale alpha reply")));
    });
    expect(screen.queryByText("Stale alpha reply")).not.toBeInTheDocument();
  });
  it("labels demo states and simulates completion without backend calls", async () => {
    const fetcher = setupFetch();
    render(<App />);
    await screen.findByText("Your next idea starts here.");
    await userEvent.click(
      screen.getByRole("button", { name: /Explore the demo/ }),
    );
    const calls = fetcher.mock.calls.length;
    expect(screen.getByText("Demo data")).toBeInTheDocument();
    expect(screen.getByText("Input needed")).toBeInTheDocument();
    vi.useFakeTimers();
    fireEvent.click(
      screen.getByRole("button", { name: /Conversation \+ context/ }),
    );
    expect(screen.getByText("In progress")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(2300);
    });
    expect(screen.getAllByText("Completed").length).toBeGreaterThan(1);
    expect(
      screen.getByText("Example outcome · no files were changed"),
    ).toBeInTheDocument();
    expect(fetcher.mock.calls.length).toBe(calls);
    const context = screen.getByRole("complementary", {
      name: "Conversation context",
    });
    expect(
      within(context).getAllByText("Simulated", { exact: true }),
    ).toHaveLength(2);
  });
});
