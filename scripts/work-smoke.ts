import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openKaeno } from "../src/core/application/index.ts";
import { browserExtension } from "../src/extensions/browser/index.ts";
import { ApiServer } from "../src/extensions/api/index.ts";
import { MemoryStore } from "../src/extensions/memory/index.ts";
import {
  loadExecution,
  loadEnvironment,
} from "../src/host/composition/index.ts";

import { dockerExecutionProvider } from "../src/extensions/docker/index.ts";
import { kubernetesExecutionProvider } from "../src/extensions/kubernetes/index.ts";
import { microsandboxExecutionProvider } from "../src/extensions/microsandbox/index.ts";

// Usage: node scripts/work-smoke.ts [docker|microsandbox|kubernetes] [backend-config-file]
// Use a dedicated backend file; never reuse an active application's explicit namespace/owner.
const directory = await mkdtemp(join(tmpdir(), "kaeno-work-smoke-"));
const provider = process.argv[2] ?? "docker";
await mkdir(join(directory, "agents/smoke"), { recursive: true });
await mkdir(join(directory, "agents/worker"), { recursive: true });
await writeFile(
  join(directory, "agents/smoke/AGENT.md"),
  "---\nname: smoke\ndescription: Smoke assistant\nmodel: openai/faux-1\ntools: [route, reply]\n---\nBe helpful.",
);
await writeFile(
  join(directory, "agents/worker/AGENT.md"),
  "---\nname: worker\ndescription: Sandbox worker\nmodel: openai/faux-1\n---\nComplete the task and verify it.",
);
const configFile = join(directory, "config.json");
await writeFile(
  configFile,
  JSON.stringify({
    sourceDirectory: join(directory, "sources"),
    kaeno: "local:smoke",
    workers: ["local:worker"],
    localDefinitions: { agents: [{ alias: "local", directory: "./agents" }] },
    execution: {
      provider,
      configFile: resolve(process.argv[3] ?? `${provider}.config.example.json`),
    },
  }),
);
const browser = await browserExtension();
const configuration = await loadEnvironment({
  configFile,
  extensions: [browser.extension],
  maxDepth: 1,
  maxConcurrent: 2,
  policy: (base) => ({
    ...base,
    worker: {
      available: [...base.worker.available, browser.extension],
      defaults: [...base.worker.defaults, browser.live],
    },
  }),
});
const backend = await loadExecution(
  configuration.execution,
  join(directory, "core.sqlite"),
  [
    dockerExecutionProvider,
    kubernetesExecutionProvider,
    microsandboxExecutionProvider,
  ],
);
const faux = fauxProvider({ provider: "openai" });
const models = createModels();
models.setProvider(faux.provider);
let workerListedSkills = false;
let workerHasBrowserTools = false;
let assistantHasBrowserTools = false;
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
    const hasBrowser = system.includes(
      "Browser tools use an isolated Playwright MCP",
    );
    if (isWork) {
      workerHasBrowserTools ||= hasBrowser;
    } else {
      assistantHasBrowserTools ||= hasBrowser;
    }
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
    // The router: everything it was given since its last answer is one batch.
    const batch = JSON.stringify(
      request.messages.slice(
        request.messages.findLastIndex(
          (message) => message.role === "assistant",
        ) + 1,
      ),
    );
    if (last?.role === "toolResult" && last.toolName === "route") {
      return fauxAssistantMessage([fauxText("Accepted the smoke ticket.")]);
    }
    if (last?.role === "toolResult" && last.toolName === "reply") {
      return fauxAssistantMessage([fauxText("Relayed the report.")]);
    }
    const report = /<report ticket=\\"(k[0-9]+)\\"[^>]*state=\\"ready\\"/.exec(
      batch,
    );
    if (report) {
      return fauxAssistantMessage(
        [
          fauxToolCall("reply", {
            to: report[1],
            text: "Worker report received and summarized.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    const trigger = /<trigger id=\\"(t[0-9]+)\\"/.exec(batch);
    if (trigger && batch.includes("delegate-smoke")) {
      return fauxAssistantMessage(
        [
          fauxToolCall("route", {
            items: [
              {
                trigger: trigger[1],
                kind: "accept",
                agent: "worker",
                title: `${provider} smoke test`,
                ack: "Started the worker.",
              },
            ],
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage([fauxText("Unexpected model step")]);
  }),
);
const core = await openKaeno({
  storage: await openNodeSqliteStorage(join(directory, "core.sqlite")),
  models,
  assistant: configuration.assistant,
  extensions: [...configuration.extensions, ...backend.extensions],
  work: { ...configuration.work, environment: backend.environment },
});
const server = new ApiServer(core, {
  memory: new MemoryStore(new DatabaseSync(":memory:")),
}).server;
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const thread = "smoke";
  // The owner's message reaches the router, which accepts it as a ticket; the worker runs it and the router
  // relays the report back to this thread.
  await core.harness.commit(
    (tx) =>
      core.router.receive(tx, {
        key: "smoke:request-smoke",
        source: "http",
        threads: [thread],
        actor: "owner",
        authority: "owner",
        content: "delegate-smoke",
        requestId: "request-smoke",
      }),
    BACKGROUND_CONTEXT,
  );
  const end = Date.now() + 45_000;
  let replies = await core.router.readReplies(thread, 0, BACKGROUND_CONTEXT);
  while (
    !replies.replies.some((reply) =>
      reply.text.includes("Worker report received"),
    ) &&
    Date.now() < end
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    replies = await core.router.readReplies(thread, 0, BACKGROUND_CONTEXT);
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
  if (!workerHasBrowserTools || assistantHasBrowserTools) {
    throw new Error(
      "Browser contributions were not composed exclusively for WORK",
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
