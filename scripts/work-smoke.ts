import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkExtensions, openKaeno } from "../src/application/index.ts";
import { ApiServer } from "../src/api/index.ts";
import { RemoteExecutionEnv } from "../src/execution/index.ts";
import { DockerSandboxProvider } from "../src/sandbox/index.ts";
import type { WorkConfig } from "../src/work/index.ts";

const directory = await mkdtemp(join(tmpdir(), "kaeno-work-smoke-"));
const faux = fauxProvider({ provider: "openai" });
const models = createModels();
models.setProvider(faux.provider);
let workerRanShell = false;
let workerShellResult = "";
faux.setResponses(
  Array.from({ length: 20 }, () => async (request) => {
    const last = request.messages.findLast(
      (message) => message.role !== "system",
    );
    const system = JSON.stringify(
      request.messages.filter((message) => message.role === "system"),
    );
    const isWork = system.includes("You are Kaeno WORK");
    if (isWork && last?.role === "user") {
      return fauxAssistantMessage(
        [fauxToolCall("bash", { command: "echo WORK_CONTAINER_OK" })],
        { stopReason: "toolUse" },
      );
    }
    if (isWork && last?.role === "toolResult" && last.toolName === "bash") {
      workerRanShell = true;
      workerShellResult = JSON.stringify(last);
      return fauxAssistantMessage([
        fauxText("Verified command ran in the Docker sandbox."),
      ]);
    }
    if (last?.role === "user" && String(last.content).includes("Work #")) {
      return fauxAssistantMessage([
        fauxText("Worker report received and summarized."),
      ]);
    }
    if (last?.role === "toolResult" && last.toolName === "start_work") {
      return fauxAssistantMessage([fauxText("Started the worker.")]);
    }
    if (
      last?.role === "user" &&
      String(last.content).includes("delegate-smoke")
    ) {
      return fauxAssistantMessage(
        [
          fauxToolCall("start_work", {
            agent: "worker",
            title: "Docker smoke test",
            brief: "Run echo WORK_CONTAINER_OK and report the exact output.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage([fauxText("Unexpected model step")]);
  }),
);
const config: WorkConfig = {
  maxDepth: 1,
  templates: {
    worker: {
      name: "worker",
      description: "Local sandbox worker",
      model: { provider: "openai", modelId: "faux-1" },
      instructions:
        "Complete the requested task and report its verified result.",
      delegates: [],
      skills: [],
    },
  },
};
const core = await openKaeno({
  storage: await openNodeSqliteStorage(join(directory, "core.sqlite")),
  models,
  assistant: {
    model: { provider: "openai", modelId: "faux-1" },
    instructions: "Be helpful.",
  },
  extensions: createWorkExtensions({
    config,
    sandbox: new DockerSandboxProvider({
      createEnvironment: ({ url, token, id, cwd, fetch }) =>
        new RemoteExecutionEnv(url, token, id, cwd, fetch),
    }),
    sandboxImage: "kaeno-sandbox:dev",
    sandboxLimits: { cpus: 1, memoryBytes: 536870912 },
    maxConcurrent: 2,
  }),
});
const server = new ApiServer(core).server;
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const thread = await core.threads.getOrCreateConversation("smoke");
  const task = await core.harness.commit(
    (tx) =>
      core.turns.admitUserTurn(tx, thread, "delegate-smoke", "request-smoke"),
    BACKGROUND_CONTEXT,
  );
  await core.harness.waitForTask(task, BACKGROUND_CONTEXT);
  const end = Date.now() + 45_000;
  let replies = await core.turns.readReplies(thread, 0);
  while (
    !replies.replies.some((reply) =>
      reply.text.includes("Worker report received"),
    ) &&
    Date.now() < end
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    replies = await core.turns.readReplies(thread, 0);
  }
  const output = replies.replies.map((reply) => reply.text).join("\n---\n");
  console.log(output);
  if (!output.includes("Worker report received")) {
    throw new Error("Timed out waiting for the worker report");
  }
  if (!workerRanShell || !workerShellResult.includes("WORK_CONTAINER_OK")) {
    throw new Error(
      "The worker did not successfully run the command in Docker",
    );
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await core.close();
  await rm(directory, { recursive: true, force: true });
}
