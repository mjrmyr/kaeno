import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
const mocks = vi.hoisted(() => {
  const transports: Record<string, unknown>[] = [];
  return {
    connect: vi.fn<() => Promise<void>>(),
    close: vi.fn<() => Promise<void>>(),
    call: vi.fn<
      (
        input: object,
        schema: unknown,
        options: { signal: AbortSignal },
      ) => Promise<{ content: unknown[] }>
    >(),
    transports,
  };
});
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mocks.connect;
    close = mocks.close;
    callTool = mocks.call;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(options: Record<string, unknown>) {
      mocks.transports.push(options);
    }
  },
}));
import { BrowserSession } from "./index.ts";
const input = {
  name: "browser_snapshot",
  arguments: {},
  proxy: "http://egress:3128",
};
afterEach(() => {
  vi.resetAllMocks();
  mocks.transports.length = 0;
});
it("reuses one sanitized isolated stdio session and removes its temporary directory", async () => {
  mocks.call.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  const session = new BrowserSession();
  await session.call(input);
  await session.call(input);
  expect(mocks.connect).toHaveBeenCalledTimes(1);
  const transport = mocks.transports[0];
  expect(transport.args).toEqual(
    expect.arrayContaining([
      "--sandbox",
      "--isolated",
      "--proxy-bypass",
      "<-loopback>",
    ]),
  );
  expect(transport.env).not.toHaveProperty("KAENO_ENV_TOKEN");
  expect(transport.env).not.toHaveProperty("NODE_OPTIONS");
  expect(transport.cwd).not.toBe("/workspace");
  expect(existsSync(String(transport.cwd))).toBe(true);
  await session.close();
  expect(existsSync(String(transport.cwd))).toBe(false);
  expect(mocks.close).toHaveBeenCalledOnce();
});
it("rejects unknown tools and credentialed/non-HTTP proxies before starting a process", async () => {
  const session = new BrowserSession();
  await expect(
    session.call({ ...input, name: "browser_run_code" }),
  ).rejects.toThrow();
  await expect(
    session.call({ ...input, proxy: "http://secret:password@egress" }),
  ).rejects.toThrow();
  await expect(
    session.call({ ...input, proxy: "file:///tmp/x" }),
  ).rejects.toThrow();
  expect(mocks.connect).not.toHaveBeenCalled();
});
it("resets on transport failure and can reconnect", async () => {
  mocks.call.mockRejectedValueOnce(new Error("cancelled"));
  const session = new BrowserSession();
  await expect(session.call(input)).rejects.toThrow("cancelled");
  expect(mocks.close).toHaveBeenCalledOnce();
  mocks.call.mockResolvedValue({ content: [] });
  await session.call(input);
  expect(mocks.connect).toHaveBeenCalledTimes(2);
  await session.close();
});
it("does not start an already cancelled call", async () => {
  const session = new BrowserSession();
  await expect(session.call(input, AbortSignal.abort())).rejects.toThrow();
  expect(mocks.connect).not.toHaveBeenCalled();
});
it("resets when popups exceed the tab budget", async () => {
  mocks.call.mockResolvedValueOnce({ content: [] }).mockResolvedValueOnce({
    content: [
      {
        type: "text",
        text: Array.from({ length: 9 }, (_, index) => `- ${index}: page`).join(
          "\n",
        ),
      },
    ],
  });
  const session = new BrowserSession();
  await expect(session.call(input)).rejects.toThrow("8 tabs");
  expect(mocks.close).toHaveBeenCalledOnce();
});
it("does not reopen the browser to count tabs after close", async () => {
  mocks.call.mockResolvedValue({ content: [] });
  const session = new BrowserSession();
  await session.call({ ...input, name: "browser_close" });
  expect(mocks.call).toHaveBeenCalledOnce();
  await session.close();
});

it("cancels an active MCP call, rejects concurrent mutation and discards state", async () => {
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  mocks.call.mockImplementationOnce(
    (_input, _schema, options) =>
      new Promise((_resolve, reject) => {
        started?.();
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("active call cancelled")),
          { once: true },
        );
      }),
  );
  const controller = new AbortController();
  const session = new BrowserSession();
  const pending = session.call(input, controller.signal);
  await ready;
  await expect(session.call(input)).rejects.toThrow("busy");
  controller.abort();
  await expect(pending).rejects.toThrow("active call cancelled");
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(existsSync(String(mocks.transports[0].cwd))).toBe(false);
});
