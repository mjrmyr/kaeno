import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  defineExtension,
  defineTask,
  defineTool,
  type Conversation,
} from "@earendil-works/pi-durable";
import {
  openWorkspace,
  type HostExtension,
  type Workspace,
} from "../src/index.ts";
import { localCoding } from "../src/local.ts";

const ctx = BACKGROUND_CONTEXT;
const directories: string[] = [];
const workspaces: Workspace[] = [];
afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((workspace) => workspace.close().catch(() => {})),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "kaeno-test-"));
  directories.push(dir);
  const database = join(dir, "session.sqlite");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = {
    model: { provider: faux.models[0].provider, modelId: faux.models[0].id },
  };
  async function open(extensions: HostExtension[] = []) {
    const workspace = await openWorkspace({
      database,
      models,
      agent,
      extensions,
    });
    workspaces.push(workspace);
    return workspace;
  }
  return { dir, database, faux, models, agent, open };
}
async function ask(conversation: Conversation, text: string) {
  return (
    await conversation.submit({ type: "input", content: text }, ctx)
  ).wait(ctx);
}

it("atomically binds concurrent names, handles unusual keys, and survives reopen with transcript", async () => {
  const { open, faux } = await setup();
  faux.setResponses([fauxAssistantMessage("hello")]);
  const first = await open();
  const conversations = await Promise.all(
    Array.from({ length: 15 }, () => first.conversation("__proto__")),
  );
  const original = conversations[0];
  if (!original) {
    throw new Error("Missing conversation");
  }
  expect(
    new Set(conversations.map((conversation) => conversation.id)).size,
  ).toBe(1);
  expect((await first.conversation("else")).id).not.toBe(original.id);
  expect((await ask(original, "hi")).status).toBe("done");
  await first.close();
  const second = await open();
  const restored = await second.conversation("__proto__");
  expect(restored.id).toBe(original.id);
  expect(
    (await restored.context(ctx)).entries.some(
      (entry) => entry.kind === "pi.user",
    ),
  ).toBe(true);
});

it("has no tools or environment by default; opt-in coding executes locally", async () => {
  const { open, faux } = await setup();
  const bare = await open();
  expect((await (await bare.conversation("a")).agent(ctx)).tools).toEqual([]);
  await bare.close();
  const enabled = await open([localCoding]);
  const conversation = await enabled.conversation("b");
  expect(
    (await conversation.agent(ctx)).tools.map((tool) => tool.name),
  ).toContain("bash");
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", { command: "printf kaeno-local" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  expect((await ask(conversation, "run")).status).toBe("done");
  expect(
    JSON.stringify(
      (await conversation.context(ctx)).entries.filter(
        (entry) => entry.kind === "pi.tool-result",
      ),
    ),
  ).toContain("kaeno-local");
});

it("runs a native extension tool using real sqlite and faux provider", async () => {
  const { open, faux } = await setup();
  let called = 0;
  const ping = defineTool({
    name: "ping",
    description: "ping",
    parameters: Type.Object({ text: Type.String() }),
    execute: async ({ text }, api) => {
      expect(api.env).toBeUndefined();
      called++;
      return { content: [{ type: "text" as const, text: `pong ${text}` }] };
    },
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ping", { text: "now" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const workspace = await open([
    { definition: defineExtension({ name: "ping-extension", tools: [ping] }) },
  ]);
  const conversation = await workspace.conversation("ping");
  expect((await ask(conversation, "go")).status).toBe("done");
  expect(called).toBe(1);
  expect(
    (await conversation.context(ctx)).entries.some(
      (entry) => entry.kind === "pi.tool-result",
    ),
  ).toBe(true);
});

it("executes opt-in local tools through the provided environment", async () => {
  const { open, faux, dir } = await setup();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", {
        path: join(dir, "result.txt"),
        content: "extension works",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  const workspace = await open([localCoding]);
  expect(
    (await ask(await workspace.conversation("local"), "write it")).status,
  ).toBe("done");
  expect(await readFile(join(dir, "result.txt"), "utf8")).toBe(
    "extension works",
  );
});

it("recovers a native task after SIGKILL without graceful shutdown", async () => {
  const { database, open } = await setup();
  const child = spawn(
    process.execPath,
    [new URL("./crash-fixture.ts", import.meta.url).pathname, database],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        child.stdout.on("data", (chunk) => {
          if (String(chunk).includes("READY")) {
            resolve();
          }
        });
      }),
      exited.then(() => {
        throw new Error(`Crash fixture exited before ready: ${stderr}`);
      }),
    ]);
    child.kill("SIGKILL");
    await exited;
    const task = defineTask<{}, { phase: "run" }, string>({
      name: "test.crash",
      version: 1,
      initial: () => ({ phase: "run" }),
      abort: async (_task, runtime, context) => {
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "aborted" } }),
          context,
        );
      },
      phases: {
        run: async (_task, runtime, context) => {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: "recovered" },
            }),
            context,
          );
        },
      },
    });
    const workspace = await open([
      { definition: defineExtension({ name: "crash", tasks: [task] }) },
    ]);
    await workspace.harness.waitForIdle(ctx);
    const conversation = await workspace.conversation("crash");
    const records = await conversation.commit(
      (tx) => tx.scanTasks({ kind: "test.crash", status: "terminal" }, 10),
      ctx,
    );
    expect(records.items).toHaveLength(1);
    expect(records.items[0]?.state).toMatchObject({
      status: "terminal",
      outcome: { status: "completed", result: "recovered" },
    });
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
}, 10000);

it("rejects duplicate names and conflicting environment providers", async () => {
  const { database, models, agent } = await setup();
  const duplicate = { definition: defineExtension({ name: "same" }) };
  await expect(
    openWorkspace({
      database,
      models,
      agent,
      extensions: [duplicate, duplicate],
    }),
  ).rejects.toThrow("Duplicate");
  await expect(
    openWorkspace({
      database,
      models,
      agent,
      extensions: [
        localCoding,
        {
          definition: defineExtension({ name: "other" }),
          env: () => undefined,
        },
      ],
    }),
  ).rejects.toThrow("environment");
});

it("resumes pending native tasks only when their definition is installed", async () => {
  const { open, faux } = await setup();
  let completed = 0;
  const task = defineTask<{}, { phase: "run" }, string>({
    name: "test.pending",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime, context) => {
        if (completed === 0) {
          await new Promise<void>((resolve) => {
            if (runtime.signal.aborted) {
              resolve();
            } else {
              runtime.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            }
          });
          return;
        }
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: "ok" },
          }),
          context,
        );
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });
  const extension = {
    definition: defineExtension({ name: "tasks", tasks: [task] }),
  };
  const first = await open([extension]);
  const conversation = await first.conversation("pending");
  const id = await conversation.commit(
    (tx) => tx.createTask(task, {}, { ownership: { kind: "conversation" } }),
    ctx,
  );
  await first.close();
  await expect(open()).rejects.toThrow("test.pending");
  const incompatible = defineTask({ ...task.definition, version: 2 });
  await expect(
    open([
      { definition: defineExtension({ name: "tasks", tasks: [incompatible] }) },
    ]),
  ).rejects.toThrow("matching definitions");
  const throwingMigration = defineTask({
    ...task.definition,
    version: 2,
    migrate: () => {
      throw new Error("must never run");
    },
  });
  await expect(
    open([
      {
        definition: defineExtension({
          name: "tasks",
          tasks: [throwingMigration],
        }),
      },
    ]),
  ).rejects.toThrow("matching definitions");
  completed = 1;
  const second = await open([extension]);
  expect((await second.harness.waitForTask(id, ctx)).state.outcome).toEqual({
    status: "completed",
    result: "ok",
  });
  expect(faux.state.callCount).toBe(0);
});

it("starts services in order, stops in reverse, unwinds failed startup, and closes once despite stop errors", async () => {
  const { database, models, agent } = await setup();
  const events: string[] = [];
  const service = (
    name: string,
    failure?: "start" | "stop",
  ): HostExtension => ({
    definition: defineExtension({ name }),
    start: async (workspace) => {
      expect(workspace.harness).toBeDefined();
      events.push(`start:${name}`);
      if (failure === "start") {
        throw new Error("start failed");
      }
      return async () => {
        events.push(`stop:${name}`);
        if (failure === "stop") {
          throw new Error("stop failed");
        }
      };
    },
  });
  const workspace = await openWorkspace({
    database,
    models,
    agent,
    extensions: [service("a", "stop"), service("b")],
  });
  await expect(workspace.close()).rejects.toThrow("shutdown failed");
  await expect(workspace.close()).rejects.toThrow("shutdown failed");
  expect(events).toEqual(["start:a", "start:b", "stop:b", "stop:a"]);
  await expect(
    openWorkspace({
      database,
      models,
      agent,
      extensions: [service("a"), service("c", "start")],
    }),
  ).rejects.toThrow("start failed");
  expect(events.slice(4)).toEqual(["start:a", "start:c", "stop:a"]);
  const reopened = await openWorkspace({ database, models, agent });
  await reopened.close();
});
