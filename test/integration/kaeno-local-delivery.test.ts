import { afterEach, expect, it, vi } from "vitest";
import {
  ReplyDelivery,
  type Reply,
  type ReplyPage,
} from "../../pi-extension/kaeno/delivery.ts";

function reply(id: number): Reply {
  return {
    id,
    requestId: `request-${id}`,
    text: `reply ${id}`,
  };
}
function page(replies: Reply[], next = replies.at(-1)?.id ?? 0): ReplyPage {
  return {
    replies,
    next,
    truncated: false,
  };
}
afterEach(() => vi.unstubAllGlobals());

function setup(after: number | "latest" = 0) {
  const state = {
    idle: true,
    displayed: new Set<number>(),
    delivered: Array<Reply>(),
    checkpoints: Array<number>(),
    truncated: 0,
  };
  const inbox = new ReplyDelivery(
    { url: "http://kaeno.test", token: "t" },
    "session-1",
    {
      after,
      canDeliver: () => state.idle,
      displayed: () => state.displayed,
      deliver: (value) => {
        state.delivered.push(value);
        state.displayed.add(value.id);
      },
      checkpoint: (next) => state.checkpoints.push(next),
      truncated: () => state.truncated++,
    },
  );
  return { state, inbox };
}

it("delivers new replies once, suppresses the provider acknowledgment, and serializes polls", async () => {
  const { state, inbox } = setup();
  state.displayed.add(1);
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    return Response.json(page([reply(1), reply(2)]));
  });
  await Promise.all([inbox.poll(), inbox.poll()]);
  expect(urls).toHaveLength(1);
  expect(state.delivered).toEqual([reply(2)]);
  expect(state.checkpoints).toEqual([2]);
  vi.stubGlobal("fetch", async (url: string) => {
    expect(url).toContain("after=2");
    return Response.json(page([], 2));
  });
  expect(await inbox.poll()).toBe(0);
  expect(state.delivered).toEqual([reply(2)]);
});

it("does not read while busy, or advance when a turn starts during the read", async () => {
  const { state, inbox } = setup();
  state.idle = false;
  const fetcher = vi.fn<() => Promise<Response>>(async () =>
    Response.json(page([reply(1)])),
  );
  vi.stubGlobal("fetch", fetcher);
  await inbox.poll();
  expect(fetcher).not.toHaveBeenCalled();
  state.idle = true;
  vi.stubGlobal("fetch", async () => {
    state.idle = false;
    return Response.json(page([reply(1)]));
  });
  await inbox.poll();
  expect(state.delivered).toEqual([]);
  expect(state.checkpoints).toEqual([]);
  state.idle = true;
  vi.stubGlobal("fetch", fetcher);
  expect(await inbox.poll()).toBe(1);
});

it("keeps its cursor on HTTP failure and catches up after reconnection", async () => {
  const { state, inbox } = setup(4);
  vi.stubGlobal(
    "fetch",
    async () => new Response("unavailable", { status: 503 }),
  );
  await expect(inbox.poll()).rejects.toThrow("HTTP 503");
  expect(state.checkpoints).toEqual([]);
  vi.stubGlobal("fetch", async (url: string) => {
    expect(url).toContain("after=4");
    return Response.json(page([reply(5)]));
  });
  expect(await inbox.poll()).toBe(1);
  expect(state.checkpoints).toEqual([5]);
});

it("resumes from its saved cursor and suppresses messages persisted before a checkpoint", async () => {
  const { state, inbox } = setup(2);
  state.displayed.add(3);
  vi.stubGlobal("fetch", async (url: string) => {
    expect(url).toContain("after=2");
    return Response.json(page([reply(3), reply(4)]));
  });
  await inbox.poll();
  expect(state.delivered).toEqual([reply(4)]);
  expect(state.checkpoints).toEqual([4]);
});

it("baselines legacy history once before admitting new work", async () => {
  const { state, inbox } = setup("latest");
  const fetcher = vi.fn<() => Promise<Response>>(async () =>
    Response.json(page([reply(1), reply(2)])),
  );
  vi.stubGlobal("fetch", fetcher);
  await Promise.all([inbox.initialize(), inbox.initialize()]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(state.delivered).toEqual([]);
  expect(state.checkpoints).toEqual([2]);
  vi.stubGlobal("fetch", async () => Response.json(page([reply(3)])));
  await inbox.poll();
  expect(state.delivered).toEqual([reply(3)]);
});

it("retries a failed legacy baseline instead of admitting new work first", async () => {
  const { state, inbox } = setup("latest");
  vi.stubGlobal(
    "fetch",
    async () => new Response("unavailable", { status: 503 }),
  );
  await expect(inbox.initialize()).rejects.toThrow();
  expect(state.checkpoints).toEqual([]);
  vi.stubGlobal("fetch", async () => Response.json(page([reply(1)])));
  await inbox.initialize();
  expect(state.checkpoints).toEqual([1]);
});

it("does not leak an in-flight reply into a closed or replaced session", async () => {
  const { state, inbox } = setup();
  vi.stubGlobal("fetch", async () => {
    inbox.close();
    return Response.json(page([reply(1)]));
  });
  await inbox.poll();
  expect(state.delivered).toEqual([]);
  expect(state.checkpoints).toEqual([]);
  await inbox.poll();
  inbox.close();
});

it("warns about retention gaps and advances to the available replies", async () => {
  const { state, inbox } = setup(1);
  vi.stubGlobal("fetch", async () =>
    Response.json({ ...page([reply(10)]), truncated: true }),
  );
  await inbox.poll();
  expect(state.truncated).toBe(1);
  expect(state.delivered).toEqual([reply(10)]);
  expect(state.checkpoints).toEqual([10]);
});
