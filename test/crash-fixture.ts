import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTask } from "@earendil-works/pi-durable";
import { openWorkspace } from "../src/index.ts";

const database = process.argv[2];
if (!database) {
  throw new Error("Database path required");
}
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
      process.stdout.write("READY\n");
      await runtime.sleep(runtime.now() + 3600000, context);
    },
  },
});
const workspace = await openWorkspace({
  database,
  models: createModels(),
  extensions: [
    { definition: defineExtension({ name: "crash", tasks: [task] }) },
  ],
});
await (
  await workspace.conversation("crash")
).commit(
  (tx) => tx.createTask(task, {}, { ownership: { kind: "conversation" } }),
  BACKGROUND_CONTEXT,
);
