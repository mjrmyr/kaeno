import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage as answer,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openKaeno } from "../src/core/application/index.ts";
import {
  DockerCli,
  dockerExecutionProvider,
} from "../src/extensions/docker/index.ts";
import {
  MicrosandboxEngine,
  microsandboxExecutionProvider,
} from "../src/extensions/microsandbox/index.ts";
import {
  loadEnvironment,
  loadExecution,
} from "../src/host/composition/index.ts";

// Usage: node scripts/ticket-smoke.ts [docker|microsandbox]
// Real sandboxes and real process kills, scripted models. Each phase is a separate process.
const backend = process.argv[2] ?? "docker";
const phase = process.argv[3];
const directoryArgument = process.argv[4];
const TIMEOUT_MS = 180_000;

interface Saved {
  before: string[];
  shell: Record<string, string>;
  a?: string;
  b?: string;
  checks: { name: string; ok: boolean; detail?: string }[];
}

const STEPS: Record<string, string> = {
  "TASK-A":
    "echo from-run-1 > /workspace/marker; echo temp > /tmp/marker; (sleep 3000 >/dev/null 2>&1 &) ; sleep 0.2; grep -al '^sleep' /proc/[0-9]*/cmdline >/dev/null 2>&1 && echo PROC_ALIVE || echo PROC_NOT_STARTED; echo HOST=$(hostname); echo WROTE",
  "ANSWER-A":
    "cat /workspace/marker; test -e /tmp/marker && echo TMP_KEPT || echo TMP_GONE; grep -al '^sleep' /proc/[0-9]*/cmdline >/dev/null 2>&1 && echo PROC_KEPT || echo PROC_GONE; echo HOST=$(hostname); echo from-run-2 >> /workspace/marker",
  "SLOW-A":
    "echo from-killed-run >> /workspace/marker; sleep 15; echo SLOW_DONE",
  "CHECK-A": "cat /workspace/marker; echo HOST=$(hostname)",
  "TASK-B": "ls -A /workspace; echo B_LISTED",
};

async function vms(): Promise<{ name: string; running: boolean }[]> {
  return backend === "microsandbox"
    ? new MicrosandboxEngine().managed()
    : new DockerCli().managed();
}

async function driver(): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-ticket-smoke-"));
  await mkdir(join(directory, "agents"), { recursive: true });
  await writeFile(
    join(directory, "agents/router.md"),
    "---\nname: router\ndescription: Router\nmodel: openai/faux-1\ntools: [route, reply]\n---\nRouter.",
  );
  await writeFile(
    join(directory, "agents/worker.md"),
    "---\nname: worker\ndescription: Worker\nmodel: openai/faux-1\n---\nWorker.",
  );
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      sourceDirectory: join(directory, "sources"),
      kaeno: "local:router",
      workers: ["local:worker"],
      localDefinitions: { agents: [{ alias: "local", directory: "./agents" }] },
      execution: {
        provider: backend,
        configFile: resolve(`${backend}.config.example.json`),
      },
    }),
  );
  const saved: Saved = {
    before: (await vms()).map((vm) => vm.name),
    shell: {},
    checks: [],
  };
  await writeFile(join(directory, "saved.json"), JSON.stringify(saved));
  function run(name: string) {
    return spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), backend, name, directory],
      { stdio: "inherit" },
    );
  }
  let completed = true;
  for (const name of [
    "killed-while-stopped",
    "killed-mid-run",
    "killed-after-end",
  ]) {
    const result = run(name);
    if (result.signal !== "SIGKILL") {
      console.error(
        `Phase ${name} ended without being killed: ${result.status}`,
      );
      completed = false;
      break;
    }
  }
  completed &&= run("after-end").status === 0;
  run("cleanup");
  const final: Saved = JSON.parse(
    await readFile(join(directory, "saved.json"), "utf8"),
  );
  const failed = final.checks.filter((check) => !check.ok);
  const left = (await vms()).filter((vm) => !final.before.includes(vm.name));
  console.log(
    `\n${final.checks.length - failed.length}/${final.checks.length} checks passed; leftover sandboxes: ${left.length}`,
  );
  await rm(directory, { recursive: true, force: true });
  return completed && failed.length === 0 && left.length === 0 ? 0 : 1;
}

function stepOf(request: ModelContext): string | undefined {
  const user = request.messages.findLast((message) => message.role === "user");
  const text = JSON.stringify(user?.content ?? "");
  return Object.keys(STEPS).find((step) => text.includes(step));
}

async function runPhase(name: string, directory: string): Promise<void> {
  const savedFile = join(directory, "saved.json");
  const saved: Saved = JSON.parse(await readFile(savedFile, "utf8"));
  function persist() {
    return writeFile(savedFile, JSON.stringify(saved));
  }
  async function check(label: string, ok: boolean, detail?: string) {
    saved.checks.push({ name: label, ok, ...(detail ? { detail } : {}) });
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`,
    );
    await persist();
  }
  async function until(test: () => boolean | Promise<boolean>, what: string) {
    const end = Date.now() + TIMEOUT_MS;
    while (!(await test())) {
      if (Date.now() > end) {
        throw new Error(`Timed out waiting for ${what}`);
      }
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  const started = new Set<string>();
  const faux = fauxProvider({ provider: "openai" });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 200 }, () => async (request: ModelContext) => {
      const system = JSON.stringify(
        request.messages.filter((message) => message.role === "system"),
      );
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      if (system.includes("You are Kaeno WORK")) {
        const step = stepOf(request);
        if (last?.role === "user") {
          started.add(step ?? "?");
          return answer(
            [
              fauxToolCall("bash", {
                command: STEPS[step ?? ""] ?? "echo NONE",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (last?.role === "toolResult" && last.toolName === "bash") {
          saved.shell[step ?? "?"] =
            JSON.stringify(last.content) + (last.isError ? " ERROR" : "");
          await persist();
          return step === "TASK-A"
            ? answer(
                [fauxToolCall("report", { state: "waiting", text: "Which?" })],
                { stopReason: "toolUse" },
              )
            : answer(`finished ${step}`);
        }
        return answer("waiting for the owner");
      }
      if (last?.role === "toolResult") {
        return answer("ok");
      }
      const start = request.messages.findLastIndex(
        (message) => message.role === "assistant",
      );
      const batch = JSON.stringify(request.messages.slice(start + 1));
      const trigger = /<trigger id=\\"(t[0-9]+)\\"/.exec(batch)?.[1];
      return trigger
        ? answer(
            [
              fauxToolCall("route", {
                items: [
                  {
                    trigger,
                    kind: "accept",
                    agent: "worker",
                    title: trigger,
                    ack: "On it.",
                  },
                ],
              }),
            ],
            { stopReason: "toolUse" },
          )
        : answer("noted");
    }),
  );
  const database = join(directory, "core.sqlite");
  const configuration = await loadEnvironment({
    configFile: join(directory, "config.json"),
    extensions: [],
    maxDepth: 1,
    maxConcurrent: 1,
    policy: (base) => base,
  });
  const execution = await loadExecution(configuration.execution, database, [
    dockerExecutionProvider,
    microsandboxExecutionProvider,
  ]);
  const core = await openKaeno({
    storage: await openNodeSqliteStorage(database),
    models,
    assistant: configuration.assistant,
    extensions: [...configuration.extensions, ...execution.extensions],
    channels: [
      {
        delivery: {
          channel: "smoke",
          send: async () => {},
          openThread: async (_route, title) => ({
            key: `smoke:${title}`,
            route: { channel: "smoke", address: title },
          }),
        },
      },
    ],
    work: { ...configuration.work, environment: execution.environment },
    onReport: (error) => console.error("REPORT", error),
  });
  function say(text: string, thread: string) {
    return core.harness.commit(
      (tx) =>
        core.router.receive(tx, {
          key: `smoke:${text}`,
          source: "smoke",
          threads: [thread],
          actor: "owner",
          authority: "owner",
          content: text,
          route: { channel: "smoke", address: thread, replyTo: text },
        }),
      context,
    );
  }
  async function ticket(id: string) {
    return (await core.router.listTickets(context, true)).find(
      (value) => value.id === id,
    );
  }
  async function reported(id: string) {
    return (await ticket(id))?.reports.at(-1)?.state;
  }
  async function created() {
    return (await vms()).filter((vm) => !saved.before.includes(vm.name));
  }
  async function running(vm: string | undefined) {
    return (await vms()).find((value) => value.name === vm)?.running;
  }
  async function exists(vm: string | undefined) {
    return (await vms()).some((value) => value.name === vm);
  }
  function host(text: string | undefined) {
    return /HOST=([^\\]+)/.exec(text ?? "")?.[1];
  }
  function die() {
    process.kill(process.pid, "SIGKILL");
  }

  if (name === "killed-while-stopped") {
    await say("TASK-A", "smoke:main");
    await until(
      async () => (await reported("k1")) === "waiting",
      "k1's question",
    );
    await until(
      async () => (await ticket("k1"))?.status === "idle",
      "k1 to hand off",
    );
    saved.a = (await created())[0]?.name;
    await until(
      async () => (await running(saved.a)) === false,
      "k1's sandbox to stop",
    );
    await check(
      "question stopped the sandbox and kept it",
      await exists(saved.a),
      saved.a,
    );

    await say("TASK-B", "smoke:other");
    await until(
      async () => (await reported("k2")) === "ready",
      "k2 to use the freed slot",
    );
    saved.b = (await created()).find((vm) => vm.name !== saved.a)?.name;
    await check(
      "second ticket ran in the freed slot, in its own sandbox",
      saved.b !== undefined,
    );
    await check(
      "second ticket cannot see the first ticket's files",
      saved.shell["TASK-B"]?.includes("B_LISTED") === true &&
        !saved.shell["TASK-B"].includes("marker"),
    );
    await until(
      async () => (await running(saved.b)) === false,
      "k2's sandbox to stop",
    );
    console.log("killing the host while both tickets' sandboxes are stopped");
    die();
    return;
  }
  if (name === "killed-mid-run") {
    await check(
      "restart kept the waiting ticket's stopped sandbox",
      (await running(saved.a)) === false,
    );
    await check(
      "restart kept the finished ticket's stopped sandbox",
      (await running(saved.b)) === false,
    );
    await check(
      "waiting ticket is still open after restart",
      (await reported("k1")) === "waiting",
    );

    const thread = (await ticket("k1"))?.ownThread ?? "";
    const passed = await say("ANSWER-A", thread);
    await check(
      "answer after restart went straight to the ticket",
      passed.path === "tickets",
      passed.path,
    );
    await until(
      () => saved.shell["ANSWER-A"] !== undefined,
      "the resumed run's command",
    );
    const resumed = saved.shell["ANSWER-A"];
    await check(
      "resumed run's tools reached the restarted sandbox",
      !resumed.includes("ERROR"),
      resumed,
    );
    await check(
      "file from before the restart survived",
      resumed.includes("from-run-1"),
    );
    await check(
      "same sandbox as before the restart",
      host(resumed) === host(saved.shell["TASK-A"]),
      host(resumed),
    );
    await check(
      `/tmp ${backend === "docker" ? "is lost" : "is kept"} across a stop on ${backend}`,
      resumed.includes(backend === "docker" ? "TMP_GONE" : "TMP_KEPT"),
    );
    await check(
      "background process ran in the first run and did not survive the stop",
      saved.shell["TASK-A"]?.includes("PROC_ALIVE") === true &&
        resumed.includes("PROC_GONE"),
    );
    await until(
      async () => (await reported("k1")) === "ready",
      "the resumed run's result",
    );
    await until(
      async () => (await running(saved.a)) === false,
      "the stop after that run",
    );

    await say("SLOW-A", thread);
    await until(() => started.has("SLOW-A"), "the slow run to start");
    await until(
      async () => (await running(saved.a)) === true,
      "the slow run's sandbox",
    );
    await new Promise((done) => setTimeout(done, 3000));
    console.log("killing the host in the middle of a worker's command");
    die();
    return;
  }
  if (name === "killed-after-end") {
    await until(
      async () => (await ticket("k1"))?.status === "idle",
      "the interrupted run to settle",
    );
    const current = await ticket("k1");
    await check(
      "interrupted run settled after restart",
      current?.status === "idle",
      `last report: ${current?.reports.at(-1)?.state}; ${saved.shell["SLOW-A"] ?? "no command result"}`,
    );
    await until(
      async () => (await running(saved.a)) === false,
      "the stop after the interrupted run",
    );
    await check("interrupted run's sandbox stopped", true);

    await say("CHECK-A", current?.ownThread ?? "");
    await until(
      () => saved.shell["CHECK-A"] !== undefined,
      "the check run's command",
    );
    const final = saved.shell["CHECK-A"];
    await check(
      "files from every run survived the mid-run kill",
      ["from-run-1", "from-run-2", "from-killed-run"].every((text) =>
        final.includes(text),
      ),
      final,
    );
    await check(
      "still the same sandbox",
      host(final) === host(saved.shell["TASK-A"]),
      host(final),
    );
    await until(async () => {
      const value = await ticket("k1");
      return value?.status === "idle" && (await running(saved.a)) === false;
    }, "the check run to end");
    await core.harness.commit(
      (tx) => core.router.stopTicket(tx, "k1", "owner", "done"),
      context,
    );
    console.log(
      "killing the host right after ending a ticket, before cleanup runs",
    );
    die();
    return;
  }
  if (name === "after-end") {
    await check(
      "startup removed the sandbox of a ticket that ended before the kill",
      !(await exists(saved.a)),
    );
    await check(
      "startup kept the other open ticket's sandbox",
      await exists(saved.b),
    );
    await core.close();
    return;
  }
  await execution.environment.reconcile([], core.harness, []);
  await core.close();
}

if (phase && directoryArgument) {
  await runPhase(phase, directoryArgument);
  process.exit(0);
}
process.exit(await driver());
