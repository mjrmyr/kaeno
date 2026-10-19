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
import { join, resolve } from "node:path";
import { openKaeno } from "../src/core/application/index.ts";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { resolveAgents, parseAgent } from "../src/extensions/agents/index.ts";
import {
  SkillCatalog,
  skillBinder,
  skillsExtension,
  SKILL_TOOLS,
} from "../src/extensions/skills/index.ts";
import { ApiServer } from "../src/extensions/api/index.ts";
import {
  loadExecution,
  parseEnvironmentConfiguration,
} from "../src/host/composition/index.ts";

// Usage: node scripts/work-smoke.ts [docker|microsandbox|kubernetes] [backend-config-file]
// Use a dedicated backend file; never reuse an active application's explicit namespace/owner.
const directory = await mkdtemp(join(tmpdir(), "kaeno-work-smoke-"));
const provider = process.argv[2] ?? "docker";
const selection = parseEnvironmentConfiguration(
  {
    sourceDirectory: directory,
    kaeno: "local:smoke",
    execution: {
      provider,
      configFile: resolve(process.argv[3] ?? `${provider}.config.example.json`),
    },
  },
  join(directory, "config.json"),
).execution;
const backend = await loadExecution(selection, join(directory, "core.sqlite"));
const faux = fauxProvider({ provider: "openai" });
const models = createModels();
models.setProvider(faux.provider);
let workerListedSkills = false;
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
            command: "echo WORK_SANDBOX_OK; uname -s; id -u; pwd",
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    if (isWork && last?.role === "toolResult" && last.toolName === "bash") {
      workerRanShell = !last.isError;
      workerShellResult = JSON.stringify(last);
      return fauxAssistantMessage([
        fauxText(`Verified command ran in the ${provider} sandbox.`),
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
            title: `${provider} smoke test`,
            brief: "Run the verification command and report the exact output.",
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
  defaults: { tools: ["bash", ...SKILL_TOOLS] },
  skills: () => skills,
});
const core = await openKaeno({
  storage: await openNodeSqliteStorage(join(directory, "core.sqlite")),
  models,
  assistant: {
    model: { provider: "openai", modelId: "faux-1" },
    instructions: "Be helpful.",
    tools: ["start_work"],
  },
  extensions: [
    { durable: CodingTools },
    skillsExtension(),
    ...backend.extensions,
  ],
  work: {
    agents,
    tools: ["bash", ...SKILL_TOOLS],
    maxDepth: 1,
    maxConcurrent: 2,
    environment: backend.environment,
  },
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
  if (!workerListedSkills) {
    throw new Error(
      "The worker did not successfully discover its empty skill list",
    );
  }
  console.log(workerShellResult);
  if (
    !workerRanShell ||
    !["WORK_SANDBOX_OK", "Linux", "1000", "/workspace"].every((expected) =>
      workerShellResult.includes(expected),
    )
  ) {
    throw new Error(
      `The worker did not successfully run the verification command in ${provider}`,
    );
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    for (const { record } of (await core.harness.inspect(BACKGROUND_CONTEXT))
      .tasks) {
      if (
        record.kind === "kaeno.work" &&
        ["pending", "running"].includes(record.state.status)
      ) {
        await core.harness.abortTask(record.id, BACKGROUND_CONTEXT);
        await core.harness.waitForTask(record.id, BACKGROUND_CONTEXT);
      }
    }
    await backend.environment.reconcile([], core.harness);
  } finally {
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
}
