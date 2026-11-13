import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  openKaeno,
  type WorkEnvironment,
} from "../../src/core/application/index.ts";
import { ROUTER_ASSISTANT_TOOLS, startTicket } from "../mocks/router.ts";

it.each([
  { environment: undefined, reason: "no execution environment identity" },
  { environment: "old:backend", reason: "Execution environment changed" },
])(
  "rejects incompatible pending WORK before its conversation or environment exists ($reason)",
  async ({ environment, reason }) => {
    const directory = await mkdtemp(
      join(tmpdir(), "kaeno-pending-environment-"),
    );
    const databaseFile = join(directory, "db.sqlite");
    const models = createModels();
    const model = { provider: "faux", modelId: "faux-1" };
    const task = defineTask<object, { phase: "start" }, null>({
      name: "kaeno.work",
      version: 4,
      initial: () => ({ phase: "start" }),
      phases: {
        start: async () => {
          throw new Error("Must remain paused");
        },
      },
      abort: async () => {
        throw new Error("Must not cancel during preflight");
      },
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "kaeno-work", tasks: [task] }));
    const original = await Harness.open(
      await openNodeSqliteStorage(databaseFile),
      { registry, models },
      context,
    );
    try {
      const parent = await original.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
      );
      const workId = await original.commit(
        (tx) =>
          tx.createTask(
            task,
            {
              ...(environment === undefined ? {} : { environment }),
              plan: {
                root: "worker",
                participants: {
                  worker: {
                    id: "worker",
                    description: "Worker",
                    setup: { model, instructions: "WORKER", tools: [] },
                  },
                },
              },
            },
            {
              ownership: { kind: "conversation" },
              conversationId: parent.id,
              background: true,
            },
          ),
        context,
      );
      await original.close(context);
      await expect(
        openKaeno({
          storage: await openNodeSqliteStorage(databaseFile),
          models,
          assistant: { model, instructions: "CHAT" },
          work: {
            setup: { model: { provider: "faux", modelId: "faux-1" }, instructions: "WORKER", tools: [] },
            tools: [],
            environment: {
              identity: "new:backend",
              cwd: "/workspace",
              ensure: async () => {
                throw new Error("Must not provision");
              },
              release: async () => {
                throw new Error("Must not release");
              },
              reconcile: async () => {
                throw new Error("Must not reconcile");
              },
              executionEnvironment: async () => {
                throw new Error("Must not execute");
              },
            },
          },
        }),
      ).rejects.toThrow(reason);
      const reopened = await Harness.open(
        await openNodeSqliteStorage(databaseFile),
        { registry, models },
        context,
      );
      try {
        expect((await reopened.getTask(workId, context))?.state.status).toBe(
          "pending",
        );
        expect(
          (
            await reopened.commit(
              (tx) => tx.scanConversations({ ownerTaskId: workId }, 1),
              context,
            )
          ).items,
        ).toEqual([]);
      } finally {
        await reopened.close(context);
      }
    } finally {
      await original.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(["test:docker", "test:microsandbox", undefined])(
  "checks the admitted environment before recovery, including work with no environment (%s)",
  async (identity) => {
    const directory = await mkdtemp(join(tmpdir(), "kaeno-work-environment-"));
    const databaseFile = join(directory, "db.sqlite");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = { provider: "faux", modelId: "faux-1" };
    let reconciliations = 0;
    let provisions = 0;
    function environmentFor(target: string): WorkEnvironment {
      return {
        identity: target,
        cwd: "/workspace",
        ensure: async () => {
          provisions++;
        },
        release: async () => {},
        reconcile: async () => {
          reconciliations++;
        },
        executionEnvironment: async () => undefined,
      };
    }
    faux.setResponses(
      Array.from({ length: 30 }, () => async (request) => {
        const system = getCurrentSystemPrompt(request.messages);
        if (system.includes("You are Kaeno WORK")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("message_parent", {
                text: "Waiting for a decision.",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage("ACK");
      }),
    );
    async function open(target: string | undefined) {
      return openKaeno({
        storage: await openNodeSqliteStorage(databaseFile),
        models,
        assistant: {
          model,
          instructions: "ROUTER",
          tools: [...ROUTER_ASSISTANT_TOOLS],
        },
        work: {
          setup: {
                model,
                instructions: "WORKER",
                tools: ["message_parent"],
              },
      tools: ["message_parent"],
          environment:
            target === undefined ? undefined : environmentFor(target),
        },
      });
    }
    const core = await open(identity);
    try {
      await startTicket(core, {
        title: "Pending",
        content: "Ask for input",
      });
      await vi.waitFor(async () => {
        const tasks = (await core.harness.inspect(context)).tasks;
        expect(
          tasks.some(
            ({ record }) =>
              record.kind === "kaeno.work" &&
              record.state.status === "running" &&
              z
                .object({ awaiting: z.string().optional() })
                .parse(record.state.checkpoint).awaiting === "reply",
          ),
        ).toBe(true);
      });
      const work = (await core.harness.inspect(context)).tasks.find(
        ({ record }) => record.kind === "kaeno.work",
      );
      expect(work).toBeDefined();
      if (!work) {
        throw new Error("Missing work");
      }
      expect(
        z
          .object({ environment: z.string().nullable() })
          .parse(work.record.input).environment,
      ).toBe(identity ?? null);
      await core.close();
      const before = { reconciliations, provisions };
      for (const replacement of [
        "test:docker",
        "test:microsandbox",
        "test:kubernetes",
        undefined,
      ].filter((target) => target !== identity)) {
        await expect(open(replacement)).rejects.toThrow(
          "Execution environment changed",
        );
        expect({ reconciliations, provisions }).toEqual(before);
      }
      // Failed startup must not rewrite the admission identity. The original backend can resume.
      const restored = await open(identity);
      try {
        await restored.harness.abortTask(work.record.id, context);
        await restored.harness.waitForTask(work.record.id, context);
      } finally {
        await restored.close();
      }
      // Once the old backend has cleaned up the work, selecting another one is safe.
      const switched = await open("test:kubernetes");
      await switched.close();
    } finally {
      await core.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
