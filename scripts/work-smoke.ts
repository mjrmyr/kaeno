import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKaeno } from "../src/core/application/index.ts";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { resolveAgents, parseAgent } from "../src/extensions/agents/index.ts";
import {
  SkillCatalog,
  skillBinder,
  skillsExtension,
  SKILL_TOOLS,
} from "../src/extensions/skills/index.ts";
import { loadKubernetesConfiguration } from "../src/extensions/kubernetes/index.ts";
import { ApiServer } from "../src/extensions/api/index.ts";
import { RemoteExecutionEnv } from "../src/extensions/execution/index.ts";
import {
  DockerSandboxProvider,
  SandboxWorkEnvironment,
} from "../src/extensions/docker/index.ts";

const directory =
  process.env.KAENO_SMOKE_DIRECTORY ??
  (await mkdtemp(join(tmpdir(), "kaeno-work-smoke-")));
await mkdir(directory, { recursive: true });
const namespace =
  process.env.KAENO_SANDBOX_NAMESPACE ??
  createHash("sha256").update(directory).digest("hex").slice(0, 16);
const kubernetes = process.env.KAENO_KUBERNETES_CONFIG
  ? await loadKubernetesConfiguration(
      process.env.KAENO_KUBERNETES_CONFIG,
      ({ url, token, id, cwd }) =>
        new RemoteExecutionEnv(url, token, id, cwd, fetch),
    )
  : undefined;
const faux = fauxProvider({ provider: "openai" });
const models = createModels();
models.setProvider(faux.provider);
let workerListedSkills = false;
let workerRanShell = false;
let workerShellResult = "";
let workerWroteFile = false;
let workerReadFile = false;
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
      return fauxAssistantMessage([fauxToolCall("list_skills", {})], {
        stopReason: "toolUse",
      });
    }
    if (
      isWork &&
      last?.role === "toolResult" &&
      last.toolName === "list_skills"
    ) {
      workerListedSkills =
        !last.isError &&
        last.content.some((item) => item.type === "text" && item.text === "[]");
      return fauxAssistantMessage(
        [
          fauxToolCall("bash", {
            command:
              "test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token && printf WORK_CONTAINER_OK > /workspace/smoke.txt && cat /workspace/smoke.txt",
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    if (isWork && last?.role === "toolResult" && last.toolName === "bash") {
      workerRanShell = !last.isError;
      workerShellResult = JSON.stringify(last);
      return fauxAssistantMessage(
        [
          fauxToolCall("write", {
            path: "/workspace/tool-roundtrip.txt",
            content: "WORK_FILE_OK",
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    if (isWork && last?.role === "toolResult" && last.toolName === "write") {
      workerWroteFile = !last.isError;
      return fauxAssistantMessage(
        [fauxToolCall("read", { path: "/workspace/tool-roundtrip.txt" })],
        { stopReason: "toolUse" },
      );
    }
    if (isWork && last?.role === "toolResult" && last.toolName === "read") {
      workerReadFile =
        !last.isError &&
        last.content.some(
          (item) => item.type === "text" && item.text === "WORK_FILE_OK",
        );
      const gate = process.env.KAENO_SMOKE_OBSERVE_GATE;
      if (gate) {
        const deadline = Date.now() + 60_000;
        while (
          await access(gate).then(
            () => false,
            () => true,
          )
        ) {
          if (Date.now() >= deadline) {
            throw new Error("Worker observation gate timed out");
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      return fauxAssistantMessage([
        fauxText("Verified shell and file tools in the sandbox."),
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
            title: "Real sandbox smoke test",
            brief:
              "Write WORK_CONTAINER_OK to /workspace/smoke.txt with the shell, read it back, and report the exact output.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage([fauxText("Unexpected model step")]);
  }),
);
const skills = skillBinder(new SkillCatalog([]));
const agents = resolveAgents({
  agents: [
    parseAgent(
      "---\nname: worker\ndescription: Local sandbox worker\nmodel: openai/faux-1\n---\nComplete the task and verify it.",
      "local",
      "smoke",
    ),
  ],
  defaults: { tools: ["bash", "read", "write", ...SKILL_TOOLS] },
  skills: () => skills,
});
const options = {
  models,
  assistant: {
    model: { provider: "openai", modelId: "faux-1" },
    instructions: "Be helpful.",
    tools: ["start_work"],
  },
  extensions: [
    { durable: CodingTools },
    skillsExtension(),
    ...(kubernetes ? [kubernetes.extension] : []),
  ],
  work: {
    agents,
    tools: ["bash", "read", "write", ...SKILL_TOOLS],
    maxDepth: 1,
    maxConcurrent: 2,
    environment:
      kubernetes?.environment ??
      new SandboxWorkEnvironment({
        sandbox: new DockerSandboxProvider({
          namespace,
          createEnvironment: ({ url, token, id, cwd, fetch }) =>
            new RemoteExecutionEnv(url, token, id, cwd, fetch),
        }),
        image: process.env.KAENO_SANDBOX_IMAGE ?? "kaeno-sandbox:dev",
        limits: { cpus: 1, memoryBytes: 536870912 },
      }),
  },
} satisfies Omit<Parameters<typeof openKaeno>[0], "storage">;
let core = await openKaeno({
  ...options,
  storage: await openNodeSqliteStorage(join(directory, "core.sqlite")),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void core.close().finally(() => process.exit(1));
  });
}
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
  const end = Date.now() + (kubernetes ? 240_000 : 90_000);
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
  if (
    replies.replies.filter((reply) =>
      reply.text.includes("Worker report received"),
    ).length !== 1
  ) {
    throw new Error("Expected exactly one delivered worker report");
  }
  if (!output.includes("Worker report received")) {
    throw new Error("Timed out waiting for the worker report");
  }
  if (!workerListedSkills) {
    throw new Error(
      "The worker did not successfully discover its empty skill list",
    );
  }
  if (!workerRanShell || !workerShellResult.includes("WORK_CONTAINER_OK")) {
    throw new Error(
      "The worker did not successfully run the command in Docker",
    );
  }
  if (!workerWroteFile || !workerReadFile) {
    throw new Error(
      "Worker write/read tool roundtrip did not return exact file content",
    );
  }
  // Reopen the actual SQLite database: delivery and thread identity must survive.
  const before = JSON.stringify(replies);
  await core.close();
  core = await openKaeno({
    ...options,
    storage: await openNodeSqliteStorage(join(directory, "core.sqlite")),
  });
  const restoredThread = await core.threads.getOrCreateConversation("smoke");
  if (
    restoredThread !== thread ||
    JSON.stringify(await core.turns.readReplies(thread, 0)) !== before
  ) {
    throw new Error("SQLite restart lost or duplicated durable replies");
  }
  console.log(
    "PASS: real worker shell/file roundtrip, report delivery, SQLite reopen",
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await core.close();
  if (!process.env.KAENO_SMOKE_DIRECTORY) {
    await rm(directory, { recursive: true, force: true });
  }
}
