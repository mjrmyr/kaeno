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
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import {
  MemoryStorage,
  type ConversationId,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  openKaeno,
  type ChannelRoute,
  type Kaeno,
} from "../../src/core/application/index.ts";
import { parseTaskId } from "../../src/core/durable/index.ts";
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

function fakeSandboxes() {
  const sandboxes = new Map<string, { running: boolean; files: string[] }>();
  const events: string[] = [];
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
      events.push(`stop ${identity.id}`);
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
  return { provider, sandboxes, events };
}

async function fixture(options: {
  worker: FauxResponseFactory;
  maxConcurrent?: number;
}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 200 }, () => async (...args) => {
      const [request] = args;
      if (getCurrentSystemPrompt(request.messages).includes("WORKER")) {
        return options.worker(...args);
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
    }),
  );
  const fake = fakeSandboxes();
  const environment = new SandboxWorkEnvironment({
    sandbox: fake.provider,
    image: "sandbox:test",
    limits: { cpus: 1, memoryBytes: 268435456 },
  });
  const sent: { route: ChannelRoute; text: string }[] = [];
  const core = await openKaeno({
    storage: new MemoryStorage(),
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
          send: async (route, text) => {
            sent.push({ route, text });
          },
          openThread: async (_route, title) => ({
            key: `test:${title}`,
            route: { channel: "test", address: title },
          }),
        },
      },
    ],
    onReport: (error) => console.error("REPORT", error),
    work: {
      setup: { model, instructions: "WORKER", tools: ["report"] },
      tools: ["report"],
      maxDepth: 1,
      maxConcurrent: options.maxConcurrent ?? 2,
      environment,
    },
  });
  async function say(text: string, thread = "test:main") {
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
  return { core, say, environment, ...fake };
}

async function isIdle(core: Kaeno, id: string): Promise<boolean> {
  return (await core.router.listTickets(context, true)).some(
    (ticket) => ticket.id === id && ticket.status === "idle",
  );
}

function asksFirst(request: ModelContext) {
  const text = JSON.stringify(request.messages);
  return text.includes("the answer is main")
    ? answer("Done on main")
    : call("report", { state: "waiting", text: "Which branch?" });
}

it("keeps a ticket's files across Assignments and removes them after the ticket ends", async () => {
  const { core, say, sandboxes, events } = await fixture({
    worker: async (request) =>
      answer(JSON.stringify(request.messages).includes("again") ? "2" : "1"),
  });
  try {
    await say("first task");
    await until(() => isIdle(core, "k1"), "the first run to end");
    const [id] = [...sandboxes.keys()];
    await until(() => sandboxes.get(id)?.running === false, "the stop");
    sandboxes.get(id)?.files.push("checkout");
    expect(events).not.toContain(`remove ${id}`);

    await say("again", "test:t1");
    await until(
      async () =>
        (await core.router.ticket("k1", context)).assignments.length === 2 &&
        (await core.router.ticket("k1", context)).status === "idle",
      "the second run to end",
    );
    expect([...sandboxes.keys()]).toEqual([id]);
    expect(sandboxes.get(id)?.files).toEqual(["checkout"]);

    await core.work?.reconcileEnvironment(context);
    expect(sandboxes.has(id)).toBe(true);

    await core.harness.commit(
      (tx) => core.router.stopTicket(tx, "k1", "owner", "done"),
      context,
    );
    await core.work?.reconcileEnvironment(context);
    expect(sandboxes.has(id)).toBe(false);
  } finally {
    await core.close();
  }
});

it("frees the slot of a worker waiting on the owner, and resumes it on the answer", async () => {
  const { core, say } = await fixture({
    maxConcurrent: 1,
    worker: async (request) =>
      JSON.stringify(request.messages).includes("second task")
        ? answer("Second done")
        : asksFirst(request),
  });
  try {
    await say("first task");
    await until(() => isIdle(core, "k1"), "the question to free the slot");
    const asked = await core.router.ticket("k1", context);
    expect(asked.reports.at(-1)?.state).toBe("waiting");
    expect(asked.assignments[0].endedAt).toBeDefined();

    await say("second task", "test:other");
    await until(
      () => isIdle(core, "k2"),
      "the second ticket to run in the freed slot",
    );

    await say("the answer is main", "test:t1");
    await until(
      async () =>
        (await core.router.ticket("k1", context)).reports.at(-1)?.state ===
        "ready",
      "the resumed ticket's result",
    );
    expect((await core.router.ticket("k1", context)).assignments).toHaveLength(
      2,
    );
  } finally {
    await core.close();
  }
});

it("ignores a suspend from an Assignment that no longer holds the sandbox", async () => {
  const { core, environment, sandboxes, events } = await fixture({
    worker: async () => answer("unused"),
  });
  try {
    const conversationId: ConversationId = await core.harness.commit(
      async (tx) =>
        (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
      context,
    );
    const first = { workId: parseTaskId(1), conversationId };
    const second = { workId: parseTaskId(2), conversationId };
    await environment.ensure(first, core.harness, context);
    await environment.ensure(second, core.harness, context);

    await environment.suspend(first, core.harness);
    expect(events.filter((event) => event.startsWith("stop"))).toEqual([]);
    expect([...sandboxes.values()][0].running).toBe(true);

    await environment.suspend(second, core.harness);
    expect([...sandboxes.values()][0].running).toBe(false);
  } finally {
    await core.close();
  }
});

it("runs an ensure after a suspend already in progress", async () => {
  const { core, environment, sandboxes } = await fixture({
    worker: async () => answer("unused"),
  });
  try {
    const conversationId: ConversationId = await core.harness.commit(
      async (tx) =>
        (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
      context,
    );
    const first = { workId: parseTaskId(1), conversationId };
    const second = { workId: parseTaskId(2), conversationId };
    await environment.ensure(first, core.harness, context);

    await Promise.all([
      environment.suspend(first, core.harness),
      environment.ensure(second, core.harness, context),
    ]);
    expect([...sandboxes.values()][0].running).toBe(true);
  } finally {
    await core.close();
  }
});
