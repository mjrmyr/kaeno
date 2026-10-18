import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  createRegistry,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
  MemoryStorage,
  type AgentState,
  type HarnessSettings,
  type Registry,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertRecoveryCompatible } from "../../src/core/durable/index.ts";

// Native MemoryStorage has a terminal close. Keep its lifetime outside the
// individual Harness instances so the same persisted records can be reopened.
class ReopenableMemoryStorage extends MemoryStorage {
  override async close(_context: Context): Promise<void> {}
  async dispose(): Promise<void> {
    await super.close(context);
  }
}

async function withStorage(
  backend: "memory" | "sqlite",
  test: (fixture: {
    open(registry: Registry, settings?: HarnessSettings): Promise<Harness>;
    close(harness: Harness): Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-startup-"));
  const memory = new ReopenableMemoryStorage();
  const opened = new Set<Harness>();
  try {
    await test({
      open: async (registry, settings) => {
        const storage: Storage =
          backend === "memory"
            ? memory
            : await openNodeSqliteStorage(join(directory, "session.sqlite"));
        const harness = await Harness.open(
          storage,
          { registry, models: createModels(), settings },
          context,
        );
        opened.add(harness);
        return harness;
      },
      close: async (harness) => {
        await harness.close(context);
        opened.delete(harness);
      },
    });
  } finally {
    for (const harness of opened) {
      await harness.close(context);
    }
    await memory.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

function taskDefinition(
  version: number,
  calls: { tasks: number; migrations: number },
  migrate = false,
) {
  return defineTask<null, { phase: "run" }, null>({
    name: "startup.example.task",
    version,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime, taskContext) => {
        calls.tasks++;
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          taskContext,
        );
      },
    },
    abort: async () => {
      throw new Error("preflight must not abort tasks");
    },
    ...(migrate
      ? {
          migrate: () => {
            calls.migrations++;
            return { input: null, checkpoint: { phase: "run" as const } };
          },
        }
      : {}),
  });
}

async function saveAgent(harness: Harness, agent: AgentState) {
  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" } },
    context,
  );
  await harness.commit(async (tx) => {
    Object.assign(await tx.doc(AgentDoc, conversation.id), agent);
  }, context);
  return conversation.id;
}

describe.each(["memory", "sqlite"] as const)(
  "startup preflight (%s)",
  (backend) => {
    it("reports missing saved extensions and tools on reopen, including idle conversations", async () => {
      await withStorage(backend, async (fixture) => {
        const registry = createRegistry();
        const tool = defineTool({
          name: "startup_example_tool",
          description: "example",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => {
            throw new Error("preflight must not execute tools");
          },
        });
        registry.install(defineExtension({ name: "example", tools: [tool] }));
        const first = await fixture.open(registry);
        const id = await saveAgent(first, {
          extensions: ["example"],
          tools: [tool.name],
        });
        const added = await saveAgent(first, {
          extensions: { add: ["missing-add"] },
        });
        await fixture.close(first);
        registry.uninstall(defineExtension({ name: "example" }));
        const reopened = await fixture.open(registry);
        await expect(
          assertRecoveryCompatible(reopened, registry, context),
        ).rejects.toThrow(`Conversation ${id}: missing extension "example"`);
        await expect(
          assertRecoveryCompatible(reopened, registry, context),
        ).rejects.toThrow(`Conversation ${id}: missing tool "${tool.name}"`);
        await expect(
          assertRecoveryCompatible(reopened, registry, context),
        ).rejects.toThrow(
          `Conversation ${added}: missing extension "missing-add"`,
        );
        expect((await reopened.inspect(context)).scheduling).toBe("paused");
      });
    });

    it.each([
      { saved: 1, installed: undefined, reason: "missing_task" },
      { saved: 2, installed: 1, reason: "task_too_old" },
      { saved: 1, installed: 2, reason: "migration_failed" },
    ])(
      "rejects $reason with task and conversation IDs",
      async ({ saved, installed, reason }) => {
        await withStorage(backend, async (fixture) => {
          const calls = { tasks: 0, migrations: 0 };
          const original = taskDefinition(saved, calls);
          const registry = createRegistry();
          const extension = defineExtension({
            name: "example",
            tasks: [original],
          });
          registry.install(extension);
          const first = await fixture.open(registry);
          const conversation = await first.createConversation(
            { ownership: { kind: "ownerless" } },
            context,
          );
          const taskId = await first.commit(
            (tx) =>
              tx.createTask(original, null, {
                ownership: { kind: "conversation" },
                conversationId: conversation.id,
              }),
            context,
          );
          await fixture.close(first);
          registry.uninstall(extension);
          if (installed !== undefined) {
            registry.install(
              defineExtension({
                name: "example",
                tasks: [taskDefinition(installed, calls)],
              }),
            );
          }
          const reopened = await fixture.open(registry);
          const before = await reopened.inspect(context);
          await expect(
            assertRecoveryCompatible(reopened, registry, context),
          ).rejects.toThrow(
            `Task ${taskId} in conversation ${conversation.id}: ${reason}`,
          );
          expect(await reopened.inspect(context)).toEqual(before);
          expect(calls).toEqual({ tasks: 0, migrations: 0 });
        });
      },
    );

    it("accepts compatible saved bindings and deferred migrations without executing code or writing", async () => {
      await withStorage(backend, async (fixture) => {
        const calls = { tasks: 0, migrations: 0 };
        let wrappers = 0;
        const tool = defineTool({
          name: "startup_example_tool",
          description: "example",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => {
            throw new Error("preflight must not execute tools");
          },
        });
        const original = taskDefinition(1, calls);
        const registry = createRegistry();
        registry.install(
          defineExtension({
            name: "example",
            tasks: [original],
            tools: [tool],
          }),
        );
        const first = await fixture.open(registry);
        const id = await saveAgent(first, {
          extensions: ["example"],
          tools: [tool.name],
        });
        await first.commit(
          (tx) =>
            tx.createTask(original, null, {
              ownership: { kind: "conversation" },
              conversationId: id,
            }),
          context,
        );
        // Removal-only references need no installed implementation.
        await saveAgent(first, {
          extensions: { add: ["example"], remove: ["retired"] },
          tools: { remove: ["retired_tool"] },
        });
        await fixture.close(first);
        registry.install(
          defineExtension({
            name: "example",
            tasks: [taskDefinition(2, calls, true)],
            tools: [tool],
            wraps: [
              {
                tool: tool.name,
                wrap: (target: typeof tool) => {
                  wrappers++;
                  return target;
                },
              },
            ],
          }),
        );
        const reopened = await fixture.open(registry);
        const before = await reopened.inspect(context);
        const savedAgent = await reopened.snapshot(AgentDoc, id, context);
        const publications: unknown[] = [];
        const unsubscribe = reopened.subscribeCommits((publication) =>
          publications.push(publication),
        );
        try {
          await assertRecoveryCompatible(reopened, registry, context);
          await assertRecoveryCompatible(reopened, registry, context);
        } finally {
          unsubscribe();
        }
        expect(await reopened.inspect(context)).toEqual(before);
        expect((await reopened.inspect(context)).scheduling).toBe("paused");
        expect(await reopened.snapshot(AgentDoc, id, context)).toEqual(
          savedAgent,
        );
        expect(publications).toEqual([]);
        expect(calls).toEqual({ tasks: 0, migrations: 0 });
        expect(wrappers).toBe(0);
      });
    });

    it("checks tools in their selected extension scope, not any installed extension", async () => {
      await withStorage(backend, async (fixture) => {
        const registry = createRegistry();
        const tool = defineTool({
          name: "not_selected",
          description: "example",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => ({ content: [] }),
        });
        registry.install(defineExtension({ name: "other", tools: [tool] }));
        registry.install(defineExtension({ name: "selected" }));
        const harness = await fixture.open(registry);
        const id = await saveAgent(harness, {
          extensions: ["selected"],
          tools: [tool.name],
        });
        await expect(
          assertRecoveryCompatible(harness, registry, context),
        ).rejects.toThrow(`Conversation ${id}: missing tool "not_selected"`);
      });
    });

    it("honors extension defaults, additions, and removals without requiring retired code", async () => {
      await withStorage(backend, async (fixture) => {
        const registry = createRegistry();
        const tool = defineTool({
          name: "default_tool",
          description: "example",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => ({ content: [] }),
        });
        const extension = defineExtension({ name: "example", tools: [tool] });
        registry.install(extension);
        const settings = { extensions: [] };
        const harness = await fixture.open(registry, settings);
        await saveAgent(harness, {
          extensions: { add: ["example", "retired"], remove: ["retired"] },
          tools: [tool.name],
        });
        await expect(
          assertRecoveryCompatible(harness, registry, context, settings),
        ).resolves.toBeUndefined();
        const id = await saveAgent(harness, { tools: [tool.name] });
        // Installed extensions are the default only when no override is supplied.
        await expect(
          assertRecoveryCompatible(harness, registry, context),
        ).resolves.toBeUndefined();
        await expect(
          assertRecoveryCompatible(harness, registry, context, settings),
        ).rejects.toThrow(`Conversation ${id}: missing tool "${tool.name}"`);
      });
    });

    it("scans more than one page of saved conversations", async () => {
      await withStorage(backend, async (fixture) => {
        const registry = createRegistry();
        const harness = await fixture.open(registry);
        for (let index = 0; index < 100; index++) {
          await saveAgent(harness, {});
        }
        const id = await saveAgent(harness, { extensions: ["last-page"] });
        await expect(
          assertRecoveryCompatible(harness, registry, context),
        ).rejects.toThrow(`Conversation ${id}: missing extension "last-page"`);
      });
    });

    it("rejects calls made after scheduling has been enabled", async () => {
      await withStorage(backend, async (fixture) => {
        const registry = createRegistry();
        const harness = await fixture.open(registry);
        harness.resume();
        await expect(
          assertRecoveryCompatible(harness, registry, context),
        ).rejects.toThrow("before scheduling or accepting input");
      });
    });
  },
);
