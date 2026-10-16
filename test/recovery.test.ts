import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTask } from "@earendil-works/pi-durable";
import { openWorkspace } from "../src/index.ts";

it("rejects missing definitions even for waiting parents with live children", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kaeno-waiting-"));
  const options = {
    database: join(dir, "session.sqlite"),
    models: createModels(),
  };
  const child = defineTask<{}, { phase: "hold" }, null>({
    name: "test.child",
    version: 1,
    initial: () => ({ phase: "hold" }),
    phases: {
      hold: async (_task, runtime, context) => {
        await runtime.sleep(runtime.now() + 3600000, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });
  const parent = defineTask<{}, { phase: "start" | "finish" }, null>({
    name: "test.parent",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (task, runtime, context) => {
        await runtime.commit(async (tx) => {
          const id = await tx.createTask(
            child,
            {},
            { ownership: { kind: "task", taskId: task.id } },
          );
          return {
            status: "waiting",
            checkpoint: { phase: "finish" },
            on: [id],
            policy: "allSettled",
          };
        }, context);
      },
      finish: async (_task, runtime, context) => {
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
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
  const workspace = await openWorkspace({
    ...options,
    extensions: [
      { definition: defineExtension({ name: "all", tasks: [parent, child] }) },
    ],
  });
  try {
    await (
      await workspace.conversation("main")
    ).commit(
      (tx) =>
        tx.createTask(parent, {}, { ownership: { kind: "conversation" } }),
      BACKGROUND_CONTEXT,
    );
    await expect
      .poll(
        async () =>
          (await workspace.harness.inspect(BACKGROUND_CONTEXT)).tasks.find(
            ({ record }) => record.kind === "test.parent",
          )?.record.state.status,
      )
      .toBe("waiting");
    await workspace.close();
    await expect(
      openWorkspace({
        ...options,
        extensions: [
          {
            definition: defineExtension({ name: "child-only", tasks: [child] }),
          },
        ],
      }),
    ).rejects.toThrow("test.parent");
  } finally {
    await workspace.close();
    await rm(dir, { recursive: true, force: true });
  }
});
