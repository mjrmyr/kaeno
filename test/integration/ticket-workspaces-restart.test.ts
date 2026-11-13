import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  getCurrentSystemPrompt,
  type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage as answer,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type JsonObject } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openKaeno, type Kaeno } from "../../src/core/application/index.ts";
import {
  SandboxWorkEnvironment,
  type SandboxProvider,
} from "../../src/extensions/execution/index.ts";

const model = { provider: "faux", modelId: "faux-1" };
function call(name: string, args: JsonObject) {
  return answer([fauxToolCall(name, args)], { stopReason: "toolUse" });
}
function batch(request: ModelContext): string {
  const start = request.messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  return JSON.stringify(request.messages.slice(start + 1));
}
async function until(check: () => boolean | Promise<boolean>, what: string) {
  const end = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function fakeHost() {
  const sandboxes = new Map<string, { running: boolean; files: string[] }>();
  const events: string[] = [];
  const failures = { stop: false };
  const provider: SandboxProvider = {
    identity: "test:sandbox",
    ensure: async (identity) => {
      events.push(`ensure ${identity.id}`);
      const existing = sandboxes.get(identity.id);
      if (existing) {
        existing.running = true;
      } else {
        sandboxes.set(identity.id, { running: true, files: [] });
      }
    },
    executionEnvironment: async () => new NodeExecutionEnv({ cwd: tmpdir() }),
    stop: async (identity) => {
      if (failures.stop) {
        throw new Error("the backend is unavailable");
      }
      const sandbox = sandboxes.get(identity.id);
      if (sandbox) {
        sandbox.running = false;
      }
    },
    remove: async (identity) => {
      events.push(`remove ${identity.id}`);
      sandboxes.delete(identity.id);
    },
    reconcile: async (active) => {
      const keep = new Set(active.map((identity) => identity.id));
      for (const id of sandboxes.keys()) {
        if (!keep.has(id)) {
          events.push(`remove ${id}`);
          sandboxes.delete(id);
        }
      }
    },
  };
  return { provider, sandboxes, events, failures };
}

function respond(request: ModelContext) {
  if (getCurrentSystemPrompt(request.messages).includes("WORKER")) {
    const text = JSON.stringify(request.messages);
    return text.includes("ask me") && !text.includes("ANSWER-TOKEN")
      ? call("report", { state: "waiting", text: "Which branch?" })
      : answer("Done");
  }
  const last = request.messages.findLast(
    (message) => message.role !== "system",
  );
  if (last?.role === "toolResult") {
    return answer("ok");
  }
  const id = /<trigger id=\\"(t[0-9]+)\\"/.exec(batch(request))?.[1];
  return id
    ? call("route", {
        items: [
          {
            trigger: id,
            kind: "accept",
            title: id,
            ack: "On it.",
          },
        ],
      })
    : answer("nothing to do");
}

async function open(path: string, provider: SandboxProvider): Promise<Kaeno> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 100 }, () => async (request) => respond(request)),
  );
  return openKaeno({
    storage: await openNodeSqliteStorage(path),
    models,
    assistant: {
      model,
      instructions: "ROUTER",
      tools: ["route", "reply", "recall", "list_tickets", "stop_ticket"],
    },
    channels: [
      {
        delivery: {
          channel: "test",
          send: async () => {},
          openThread: async (_route, title) => ({
            key: `test:${title}`,
            route: { channel: "test", address: title },
          }),
        },
      },
    ],
    onReport: () => {},
    work: {
      setup: { model, instructions: "WORKER", tools: ["report"] },
      tools: ["report"],
      maxDepth: 1,
      maxConcurrent: 2,
      environment: new SandboxWorkEnvironment({
        sandbox: provider,
        image: "sandbox:test",
        limits: { cpus: 1, memoryBytes: 268435456 },
      }),
    },
  });
}
function say(core: Kaeno, text: string, thread: string) {
  return core.harness.commit(
    (tx) =>
      core.router.receive(tx, {
        key: `test:${text}`,
        source: "test",
        threads: [thread],
        actor: "owner",
        authority: "owner",
        content: text,
        route: { channel: "test", address: thread, replyTo: text },
      }),
    context,
  );
}
async function ticket(core: Kaeno, id: string) {
  return (await core.router.listTickets(context, true)).find(
    (value) => value.id === id,
  );
}
async function withDatabase(body: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-ticket-restart-"));
  try {
    await body(join(directory, "durable.sqlite"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it("keeps a waiting ticket's stopped sandbox across a restart and resumes in it", async () => {
  await withDatabase(async (path) => {
    const host = fakeHost();
    const first = await open(path, host.provider);
    let id: string;
    try {
      await say(first, "ask me", "test:main");
      await until(
        async () => (await ticket(first, "k1"))?.status === "idle",
        "the question",
      );
      expect((await ticket(first, "k1"))?.reports.at(-1)?.state).toBe(
        "waiting",
      );
      [id] = [...host.sandboxes.keys()];
      await until(() => host.sandboxes.get(id)?.running === false, "the stop");
      host.sandboxes.get(id)?.files.push("checkout");
    } finally {
      await first.close();
    }

    const second = await open(path, host.provider);
    try {
      expect(host.events).not.toContain(`remove ${id}`);
      expect(host.sandboxes.get(id)?.running).toBe(false);
      const waiting = await ticket(second, "k1");
      expect(waiting?.status).toBe("idle");
      expect(waiting?.reports.at(-1)?.state).toBe("waiting");

      const answered = await say(
        second,
        "ANSWER-TOKEN",
        waiting?.ownThread ?? "",
      );
      expect(answered.path).toBe("tickets");
      await until(
        async () =>
          (await ticket(second, "k1"))?.reports.at(-1)?.state === "ready",
        "the resumed result",
      );
      expect((await ticket(second, "k1"))?.assignments).toHaveLength(2);
      expect([...host.sandboxes.keys()]).toEqual([id]);
      expect(host.sandboxes.get(id)?.files).toEqual(["checkout"]);
      await until(
        () => host.sandboxes.get(id)?.running === false,
        "the stop after the resumed run",
      );
    } finally {
      await second.close();
    }
  });
});

it("removes at startup the sandbox of a ticket that ended before the restart", async () => {
  await withDatabase(async (path) => {
    const host = fakeHost();
    const first = await open(path, host.provider);
    let ended: string;
    let open2: string;
    try {
      await say(first, "first task", "test:main");
      await until(
        async () => (await ticket(first, "k1"))?.status === "idle",
        "the first ticket",
      );
      [ended] = [...host.sandboxes.keys()];
      await say(first, "second task", "test:other");
      await until(
        async () => (await ticket(first, "k2"))?.status === "idle",
        "the second ticket",
      );
      [open2] = [...host.sandboxes.keys()].filter((id) => id !== ended);
      await first.harness.commit(
        (tx) => first.router.stopTicket(tx, "k1", "owner", "done"),
        context,
      );
      expect(host.sandboxes.has(ended)).toBe(true);
    } finally {
      await first.close();
    }

    const second = await open(path, host.provider);
    try {
      expect(host.sandboxes.has(ended)).toBe(false);
      expect(host.sandboxes.has(open2)).toBe(true);
    } finally {
      await second.close();
    }
  });
});

it("adopts after a restart a sandbox whose stop never happened", async () => {
  await withDatabase(async (path) => {
    const host = fakeHost();
    host.failures.stop = true;
    const first = await open(path, host.provider);
    let id: string;
    try {
      await say(first, "ask me", "test:main");
      await until(
        async () => (await ticket(first, "k1"))?.status === "idle",
        "the question",
      );
      expect((await ticket(first, "k1"))?.reports.at(-1)?.state).toBe(
        "waiting",
      );
      [id] = [...host.sandboxes.keys()];
      await until(
        async () =>
          (await ticket(first, "k1"))?.assignments[0].endedAt !== undefined,
        "the Assignment to end",
      );
      expect(host.sandboxes.get(id)?.running).toBe(true);
    } finally {
      await first.close();
    }

    host.failures.stop = false;
    const second = await open(path, host.provider);
    try {
      expect(host.sandboxes.has(id)).toBe(true);
      const waiting = await ticket(second, "k1");
      await say(second, "ANSWER-TOKEN", waiting?.ownThread ?? "");
      await until(
        async () =>
          (await ticket(second, "k1"))?.reports.at(-1)?.state === "ready",
        "the resumed result",
      );
      expect([...host.sandboxes.keys()]).toEqual([id]);
      await until(
        () => host.sandboxes.get(id)?.running === false,
        "the stop after the resumed run",
      );
    } finally {
      await second.close();
    }
  });
});
