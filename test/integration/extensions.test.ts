import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  openKaeno,
  type Kaeno,
  type KaenoExtension,
} from "../../src/core/application/index.ts";

import { ConversationBindings } from "../../src/core/conversation/index.ts";

const assistant = {
  model: { provider: "faux", modelId: "faux-1" },
  instructions: "Use the extension when requested.",
};

const Ingress = defineDoc({
  kind: "test.extension.ingress",
  version: 1,
  scope: "session",
  initial: () => ({ cursor: 0, completed: 0 }),
});

function catalog() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

it("composes native tools/tasks/docs, transactional channel ingress and delivery, then reopens SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-extensions-"));
  const path = join(directory, "core.sqlite");
  const { faux, models } = catalog();
  const sent: { address: string; text: string }[] = [];
  const lifecycle: string[] = [];
  const environment = new NodeExecutionEnv({ cwd: directory });
  let environmentCalls = 0;
  const Job = defineTask<null, { phase: "run" }, null>({
    name: "test.extension.job",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime, ctx) => {
        await runtime.commit(async (tx) => {
          (await tx.doc(Ingress)).completed++;
          return {
            status: "terminal",
            outcome: { status: "completed", result: null },
          };
        }, ctx);
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        ctx,
      );
    },
  });
  const tool = defineTool({
    name: "extension_execute",
    description:
      "Execute extension-owned work in the host-provided environment",
    parameters: Type.Object({}),
    execute: async (_args, api, ctx) => {
      if (!api.env) {
        throw new Error("Missing extension environment");
      }
      const written = await api.env.writeFile(
        "execution.txt",
        "external execution",
        ctx,
      );
      if (!written.ok) {
        throw written.error;
      }
      const task = await api.createTask(
        Job,
        null,
        { ownership: { kind: "conversation" }, background: true },
        ctx,
      );
      await api.waitForTask(task, ctx);
      return { content: [{ type: "text", text: "Executed" }] };
    },
  });
  function service(name: string): KaenoExtension {
    return {
      durable: defineExtension({ name }),
      start: async (core, signal) => {
        lifecycle.push(`start:${name}`);
        expect((await core.harness.inspect(context)).scheduling).toBe("paused");
        signal.addEventListener(
          "abort",
          () => lifecycle.push(`abort:${name}`),
          { once: true },
        );
        return async () => {
          expect(signal.aborted).toBe(true);
          // Resources are disposed only after durable invocations are quiescent.
          lifecycle.push(`close:${name}`);
        };
      },
    };
  }
  const extension: KaenoExtension = {
    ...service("external-adapter"),
    durable: defineExtension({
      name: "external-adapter",
      tools: [tool],
      tasks: [Job],
    }),
    environment: () => {
      environmentCalls++;
      return environment;
    },
    delivery: {
      channel: "test-channel",
      send: async (address, text) => {
        sent.push({ address, text });
      },
    },
  };
  let core: Kaeno | undefined;
  try {
    core = await openKaeno({
      storage: await openNodeSqliteStorage(path),
      models,
      assistant: { ...assistant, tools: [tool.name] },
      extensions: [extension, service("second")],
    });
    const opened = core;
    const id = await opened.threads.getOrCreateConversation("channel:room");
    // The authenticated adapter owns its cursor and admits the turn in the SAME native transaction.
    await expect(
      opened.harness.commit(async (tx) => {
        (await tx.doc(Ingress)).cursor = 1;
        await opened.turns.admitUserTurn(tx, id, "rolled back", "rollback", {
          route: { channel: "test-channel", address: "room" },
        });
        throw new Error("ingress failed");
      }, context),
    ).rejects.toThrow("ingress failed");
    expect((await opened.harness.snapshot(Ingress, context))?.cursor ?? 0).toBe(
      0,
    );
    expect(await opened.turns.readReplyText(id, "rollback")).toBeUndefined();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(tool.name, {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("DONE")]),
    ]);
    const task = await opened.harness.commit(async (tx) => {
      (await tx.doc(Ingress)).cursor = 1;
      return opened.turns.admitUserTurn(tx, id, "execute", "channel-event:1", {
        route: { channel: "test-channel", address: "room" },
      });
    }, context);
    await opened.harness.waitForTask(task, context);
    expect(await opened.turns.readReplyText(id, "channel-event:1")).toBe(
      "DONE",
    );
    expect(sent).toEqual([{ address: "room", text: "DONE" }]);
    expect(await opened.harness.snapshot(Ingress, context)).toMatchObject({
      cursor: 1,
      completed: 1,
    });
    expect(environmentCalls).toBeGreaterThan(0);
    expect(await readFile(join(directory, "execution.txt"), "utf8")).toBe(
      "external execution",
    );
    await opened.close();
    core = undefined;
    expect(lifecycle.slice(-2)).toEqual([
      "close:second",
      "close:external-adapter",
    ]);
    expect(lifecycle.indexOf("abort:external-adapter")).toBeLessThan(
      lifecycle.indexOf("close:second"),
    );
    expect(lifecycle.indexOf("abort:second")).toBeLessThan(
      lifecycle.indexOf("close:second"),
    );

    // A selected tool's owning extension is a saved conversation dependency. Removing it fails before resume.
    await expect(
      openKaeno({
        storage: await openNodeSqliteStorage(path),
        models,
        assistant: { ...assistant, tools: [tool.name] },
        extensions: [service("second")],
      }),
    ).rejects.toThrow(
      'Assistant: tool "extension_execute" is not available here',
    );

    core = await openKaeno({
      storage: await openNodeSqliteStorage(path),
      models,
      assistant: { ...assistant, tools: [tool.name] },
      extensions: [extension, service("second")],
    });
    expect(await core.threads.getOrCreateConversation("channel:room")).toBe(id);
    expect(await core.harness.snapshot(Ingress, context)).toMatchObject({
      cursor: 1,
      completed: 1,
    });
    expect(await core.turns.readReplyText(id, "channel-event:1")).toBe("DONE");
    const reopened = core;
    const duplicate = await reopened.harness.commit(
      (tx) =>
        reopened.turns.admitUserTurn(tx, id, "execute", "channel-event:1", {
          route: { channel: "test-channel", address: "room" },
        }),
      context,
    );
    expect(duplicate).toBe(task);
    await reopened.harness.waitForTask(duplicate, context);
    expect(sent).toHaveLength(1);
  } finally {
    await core?.close();
    await environment.cleanup(context);
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects a removed delivery capability before resuming its pending turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-route-"));
  const path = join(directory, "core.sqlite");
  const { models } = catalog();
  const durable = defineExtension({ name: "channel-adapter" });
  try {
    await expect(
      openKaeno({
        storage: await openNodeSqliteStorage(path),
        models,
        assistant,
        extensions: [
          {
            durable,
            delivery: { channel: "removed", send: async () => {} },
            start: async (core) => {
              const id = await core.threads.getOrCreateConversation("pending");
              await core.harness.commit(
                (tx) =>
                  core.turns.admitUserTurn(tx, id, "hello", "pending-turn", {
                    route: { channel: "removed", address: "room" },
                  }),
                context,
              );
              throw new Error("interrupted startup");
            },
          },
        ],
      }),
    ).rejects.toThrow("interrupted startup");
    await expect(
      openKaeno({
        storage: await openNodeSqliteStorage(path),
        models,
        assistant,
        extensions: [{ durable }],
      }),
    ).rejects.toThrow("Missing delivery channel: removed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["extension", "task", "tool", "channel", "environment", "read-only"])(
  "rejects duplicate %s definitions before services start",
  async (kind) => {
    let starts = 0;
    const tool = defineTool({
      name: "collision",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => ({}),
    });
    const task = defineTask<null, { phase: "run" }, null>({
      name: "collision",
      version: 1,
      initial: () => ({ phase: "run" }),
      phases: {
        run: async () => {
          throw new Error("must not run");
        },
      },
      abort: async () => {
        throw new Error("must not run");
      },
    });
    const extensions: KaenoExtension[] = [0, 1].map((index) => ({
      durable: defineExtension({
        name: kind === "extension" ? "same" : `extension-${index}`,
        ...(kind === "tool" || (kind === "read-only" && index === 0)
          ? { tools: [tool] }
          : {}),
        ...(kind === "task" ? { tasks: [task] } : {}),
      }),
      ...(kind === "channel"
        ? { delivery: { channel: "same", send: async () => {} } }
        : {}),
      ...(kind === "environment" ? { environment: () => undefined } : {}),
      ...(kind === "read-only" && index === 1
        ? { readOnlyTools: [tool.name] }
        : {}),
      start: async () => {
        starts++;
      },
    }));
    await expect(
      openKaeno({
        storage: new MemoryStorage(),
        models: createModels(),
        assistant,
        extensions,
      }),
    ).rejects.toThrow();
    expect(starts).toBe(0);
  },
);

it("rejects duplicate saved binding owners before any service restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-duplicate-bindings-"));
  const path = join(directory, "core.sqlite");
  const { models } = catalog();
  let starts = 0;
  const owner: KaenoExtension = {
    durable: defineExtension({ name: "binding-owner" }),
    validateBinding: () => {},
    start: async () => {
      starts++;
    },
  };
  try {
    await expect(
      openKaeno({
        storage: await openNodeSqliteStorage(path),
        models,
        assistant,
        extensions: [
          owner,
          {
            durable: defineExtension({ name: "interrupt" }),
            start: async (core) => {
              const id =
                await core.threads.getOrCreateConversation(
                  "corrupted-bindings",
                );
              await core.harness.commit(async (tx) => {
                const doc = await tx.doc(ConversationBindings, id);
                doc.bindings = [0, 1].map(() => ({
                  owner: "binding-owner",
                  version: 1,
                  value: {},
                }));
              }, context);
              throw new Error("interrupted startup");
            },
          },
        ],
      }),
    ).rejects.toThrow("interrupted startup");
    starts = 0;
    await expect(
      openKaeno({
        storage: await openNodeSqliteStorage(path),
        models,
        assistant,
        extensions: [owner],
      }),
    ).rejects.toThrow('duplicate binding owner "binding-owner"');
    expect(starts).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("aborts all started services and cleans them up when a later service fails", async () => {
  const events: string[] = [];
  let captured: Kaeno | undefined;
  const extensions: KaenoExtension[] = ["first", "second", "failing"].map(
    (name) => ({
      durable: defineExtension({ name }),
      start: async (core, signal) => {
        captured = core;
        signal.addEventListener("abort", () => events.push(`abort:${name}`), {
          once: true,
        });
        if (name === "failing") {
          throw new Error("service startup failed");
        }
        return async () => {
          expect(signal.aborted).toBe(true);
          await expect(core.harness.inspect(context)).rejects.toThrow();
          events.push(`close:${name}`);
        };
      },
    }),
  );
  await expect(
    openKaeno({
      storage: new MemoryStorage(),
      models: createModels(),
      assistant,
      extensions,
    }),
  ).rejects.toThrow("service startup failed");
  expect(events.slice(-2)).toEqual(["close:second", "close:first"]);
  for (const name of ["first", "second"]) {
    expect(events.indexOf(`abort:${name}`)).toBeLessThan(
      events.indexOf("close:second"),
    );
  }
  if (!captured) {
    throw new Error("Expected service to receive the core");
  }
  await expect(captured.harness.inspect(context)).rejects.toThrow();
});
