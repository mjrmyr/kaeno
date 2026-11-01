// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mountChat } from "./chat.ts";
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!found) {
    throw new Error(`Button ${text} missing`);
  }
  return found;
}
function input(): HTMLTextAreaElement {
  const found = document.querySelector("textarea");
  if (!found) {
    throw new Error("Missing composer");
  }
  return found;
}
function start(
  handler: (path: string, options?: RequestInit) => Promise<Response>,
): void {
  vi.stubGlobal("fetch", vi.fn(handler));
  const root = document.createElement("div");
  document.body.append(root);
  cleanup = mountChat(root);
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}
async function write(text: string): Promise<void> {
  input().value = text;
  input().dispatchEvent(new Event("input"));
  document
    .querySelector("form")
    ?.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => {
    expect(input().disabled).toBe(false);
  });
}
it("loads real threads, submits text, polls escaped replies and admits stop", async () => {
  const posts: { path: string; body: unknown }[] = [];
  let replied = false;
  start(async (path, options) => {
    if (options?.method === "POST") {
      posts.push({ path, body: JSON.parse(String(options.body)) });
      if (path.endsWith("/turn")) {
        replied = true;
      }
      return json({ taskId: "task-1" }, 202);
    }
    if (path === "/v1/threads") {
      return json([{ key: "existing", createdAt: 1 }]);
    }
    return json({
      replies: replied
        ? [
            {
              id: 1,
              requestId: "request-1",
              text: "<img src=x onerror=alert(1)> hello",
            },
          ]
        : [],
      next: replied ? 1 : 0,
      truncated: false,
    });
  });
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Connected to Kaeno");
  });
  button("existing").click();
  await write("Real question");
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("<img src=x");
  });
  expect(document.querySelector("img")).toBeNull();
  expect(posts[0]).toMatchObject({
    path: "/v1/threads/existing/turn",
    body: { text: "Real question" },
  });
  expect(document.body.textContent).toContain("Real question");
  button("Stop thread").click();
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Stop accepted");
  });
  expect(posts[1].path).toBe("/v1/threads/existing/stop");
});
it("retains a failed draft and retries with the same request ID", async () => {
  const ids: string[] = [];
  start(async (path, options) => {
    if (options?.method === "POST") {
      ids.push(JSON.parse(String(options.body)).requestId);
      if (ids.length === 1) {
        throw new Error("Network unavailable");
      }
      return json({ taskId: "task-2" }, 202);
    }
    return path === "/v1/threads"
      ? json([])
      : json({ replies: [], next: 0, truncated: false });
  });
  await write("keep this");
  expect(input().value).toBe("keep this");
  expect(document.body.textContent).toContain("Network unavailable");
  await write("keep this");
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(input().value).toBe("");
});
it("shows actionable connectivity and malformed API errors instead of fake data", async () => {
  start(async () => json({ error: "Unauthorized" }, 401));
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("API 401");
  });
  expect(document.body.textContent).toContain("Disconnected");
  expect(button("Stop thread").disabled).toBe(true);
  expect(button("Send message ↑").disabled).toBe(true);
});
