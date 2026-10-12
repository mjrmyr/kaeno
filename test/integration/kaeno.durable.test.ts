import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import { AgentFactory } from "../../src/agents/index.ts";
import {
  HarnessReference,
  parseConversationId,
} from "../../src/durable/index.ts";
import { defineTurn } from "../../src/turns/index.ts";
import {
  createAgents,
  createEnvServer,
  createThreadFixture,
  createWork,
  refreshThreads,
  thread,
} from "./composition.ts";
import { FixtureReference } from "./reference.ts";
import { messageText, readObject, required, serverPort } from "./values.ts";
// End to end without cloud or cluster: kaeno (faux model) delegates to a sandboxed worker whose tools run through a
// real envd; the process "crashes" while the worker's command runs, and a new Harness on the same SQLite file
// finishes the job in the same sandbox, then deletes it.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  Harness,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config/index.ts";
import {
  copySkillTree,
  inspectSkill,
  INSTALLER,
  materializeSkillSelection,
  openSkillCatalog,
  type SkillManifest,
} from "../../src/skills/index.ts";
import { admitTurn, TurnLedger } from "../../src/turns/index.ts";
const listen = (server: ReturnType<typeof createServer>) =>
  new Promise<string>((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok(`http://127.0.0.1:${serverPort(server)}`),
    ),
  );
describe("kaeno durable delegation", () => {
  it.each([
    { recreate: false, background: false },
    { recreate: true, background: false },
    { recreate: false, background: true },
    { recreate: true, background: true },
  ])(
    "loads assigned skills and resumes frozen images (recreate=$recreate, background=$background)",
    async ({ recreate, background }) => {
      const dir = await mkdtemp(join(tmpdir(), "kaeno-durable-"));
      const workspace = await mkdtemp(join(tmpdir(), "kaeno-pod-"));
      const store = join(dir, "catalogue");
      const cache = join(dir, "persistent-skill-cache");
      const rootSkill = join(store, "demo/root/guide");
      const workerSkill = join(store, "demo/worker/probe");
      await mkdir(rootSkill, { recursive: true });
      await mkdir(join(workerSkill, "references"), { recursive: true });
      await mkdir(join(workerSkill, "scripts"));
      await writeFile(
        join(rootSkill, "SKILL.md"),
        "---\nname: guide\ndescription: Orchestrate work.\n---\nDelegate real work and check results.\n",
      );
      await writeFile(
        join(workerSkill, "SKILL.md"),
        "---\nname: probe\ndescription: Print skill-probe-ok with a script.\n---\nRead references/guide.md then run scripts/probe.sh.\n",
      );
      await writeFile(
        join(workerSkill, "references/guide.md"),
        "Run the assigned script, not unrelated skills.\n",
      );
      await writeFile(
        join(workerSkill, "scripts/probe.sh"),
        "#!/bin/sh\nprintf 'skill-probe-ok\\n'\n",
      );
      await chmod(join(workerSkill, "scripts/probe.sh"), 0o755);
      const manifest: SkillManifest = {
        schema: 1,
        installer: INSTALLER,
        repositories: [
          { id: "demo/root", commit: "a".repeat(40) },
          { id: "demo/worker", commit: "b".repeat(40) },
        ],
        entries: [
          {
            id: "demo/root:guide",
            treeHash: (await inspectSkill(rootSkill)).treeHash,
          },
          {
            id: "demo/worker:probe",
            treeHash: (await inspectSkill(workerSkill)).treeHash,
          },
        ],
      };
      await writeFile(join(store, "manifest.json"), JSON.stringify(manifest));
      for (const entry of manifest.entries) {
        await copySkillTree(
          join(store, entry.id.replace(":", "/")),
          join(cache, "trees", entry.treeHash),
        );
      }
      // A fake Kubernetes API: pods are created, always Ready, and deleted.
      const calls: string[] = [];
      const environmentSchema = z.array(
        z.object({ name: z.string(), value: z.string().optional() }),
      );
      const podSchema = z.object({
        metadata: z.object({
          name: z.string(),
          annotations: z.record(z.string(), z.string()),
        }),
        spec: z.object({
          containers: z.array(
            z.object({ image: z.string(), env: environmentSchema }),
          ),
          initContainers: z.array(
            z.object({ image: z.string(), env: environmentSchema }),
          ),
          volumes: z.array(
            z.object({
              name: z.string(),
              persistentVolumeClaim: z
                .object({ claimName: z.string() })
                .optional(),
            }),
          ),
        }),
      });
      const pods = new Map<string, z.infer<typeof podSchema>>();
      let podToken = "";
      const kube = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
        }
        const name = required(
          required(required(req.url).split("?")[0]).split("/").pop(),
        );
        calls.push(
          `${req.method} ${req.method === "POST" ? podSchema.parse(JSON.parse(raw)).metadata.name : name}`,
        );
        if (req.method === "POST") {
          const pod = podSchema.parse(JSON.parse(raw));
          if (pods.has(pod.metadata.name)) {
            res.writeHead(409).end("{}");
            return;
          }
          podToken = z
            .string()
            .parse(
              pod.spec.containers[0].env.find(
                (environment) => environment.name === "KAENO_ENV_TOKEN",
              )?.value,
            ); // as the pod would get it
          expect(pod.spec.containers[0].image).toBe("execution-v1");
          expect(pod.spec.initContainers[0].image).toBe("execution-v1");
          expect(
            pod.spec.volumes.find((volume) => volume.name === "skill-cache")
              ?.persistentVolumeClaim?.claimName,
          ).toBe("skill-cache-v1");
          const plan = z
            .array(z.object({ id: z.string(), treeHash: z.string() }))
            .parse(
              JSON.parse(
                z.string().parse(pod.spec.initContainers[0].env[0].value),
              ),
            );
          await materializeSkillSelection(
            cache,
            plan,
            join(workspace, ".agents/skills"),
          );
          expect(await readdir(join(workspace, ".agents/skills/demo"))).toEqual(
            ["worker"],
          );
          pods.set(pod.metadata.name, pod);
          res.writeHead(201).end(raw);
          return;
        }
        if (req.method === "DELETE") {
          pods.delete(name);
          res.writeHead(200).end("{}");
          return;
        }
        if (name === "pods") {
          res.writeHead(200).end(JSON.stringify({ items: [...pods.values()] }));
          return;
        }
        res.writeHead(pods.has(name) ? 200 : 404).end(
          JSON.stringify({
            metadata: { name },
            status: { conditions: [{ type: "Ready", status: "True" }] },
          }),
        );
      });
      process.env.KUBERNETES_API = await listen(kube);
      process.env.KUBERNETES_TOKEN_FILE = join(dir, "token");
      await writeFile(process.env.KUBERNETES_TOKEN_FILE, "fake");
      const envd = createEnvServer({ token: () => podToken, root: workspace });
      const envdUrl = await listen(envd);
      const { AgentState } = await import("../../src/agents/index.ts");
      const { answerText } = await import("../../src/threads/index.ts");
      const config: Config = {
        agent: "kaeno",
        skillRepositories: [{ id: "demo/root" }, { id: "demo/worker" }],
        templates: {
          kaeno: {
            name: "kaeno",
            description: "orchestrator",
            model: { provider: "anthropic", modelId: "faux-1" },
            instructions: "ORCHESTRATOR",
            sandbox: false,
            tools: [],
            delegates: ["worker"],
            skills: [recreate ? "demo/root:*" : "demo/root:guide"],
          },
          worker: {
            name: "worker",
            description: "worker",
            model: { provider: "anthropic", modelId: "faux-1" },
            instructions: "WORKER",
            sandbox: true,
            tools: ["read", "write", "edit", "bash"],
            delegates: [],
            skills: [recreate ? "demo/worker:*" : "demo/worker:probe"],
          },
        },
        telegram: { allowedChatIds: [] },
      };
      // One scripted model for both agents, routed by role (system prompt) and the latest message.
      const faux = fauxProvider({ provider: "anthropic" });
      const models = createModels();
      models.setProvider(faux.provider);
      let commandStarted: () => void;
      const started = new Promise<void>((ok) => (commandStarted = ok));
      faux.setResponses(
        Array.from({ length: 30 }, () => (request: TranscriptContext) => {
          const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
          );
          const last = required(
            request.messages.findLast((message) => message.role !== "system"),
          );
          const text = messageText(required(last));
          if (system.includes("Kaeno CHAT")) {
            if (last.role === "toolResult") {
              return fauxAssistantMessage([fauxText("ACK: work accepted")]);
            }
            if (text.startsWith("Work #")) {
              return fauxAssistantMessage([
                fauxText(text.split("\n\n").slice(1).join("\n\n")),
              ]);
            }
            return fauxAssistantMessage(
              [
                fauxToolCall(
                  "start_work",
                  {
                    agent: "kaeno",
                    title: "Write file",
                    brief: "Please get hello.txt written.",
                  },
                  { id: "start" },
                ),
              ],
              { stopReason: "toolUse" },
            );
          }
          if (system.includes("ORCHESTRATOR")) {
            expect(system).not.toContain(
              "Run the assigned script, not unrelated skills.",
            );
            if (last.role === "toolResult" && last.toolName === "delegate") {
              return fauxAssistantMessage([
                fauxText(`Worker reports: ${text}`),
              ]);
            }
            if (last.role === "toolResult" && last.toolName === "read_skill") {
              expect(text).toContain("Delegate real work");
              return fauxAssistantMessage(
                [
                  fauxToolCall(
                    "delegate",
                    {
                      agent: "worker",
                      task: "Write hello.txt, then run the slow check.",
                    },
                    { id: "d1" },
                  ),
                ],
                { stopReason: "toolUse" },
              );
            }
            return fauxAssistantMessage(
              [
                fauxToolCall(
                  "read_skill",
                  { skill: "demo/root:guide" },
                  { id: "r-root" },
                ),
              ],
              { stopReason: "toolUse" },
            );
          }
          expect(system).not.toContain("demo/root:guide");
          if (last.role === "user") {
            return fauxAssistantMessage(
              [
                fauxToolCall(
                  "read_skill",
                  { skill: "demo/worker:probe" },
                  { id: "r-worker" },
                ),
              ],
              { stopReason: "toolUse" },
            );
          }
          if (last.role === "toolResult" && last.toolName === "read_skill") {
            expect(text).toContain("Read references/guide.md");
            return fauxAssistantMessage(
              [
                fauxToolCall(
                  "read",
                  {
                    path: ".agents/skills/demo/worker/probe/references/guide.md",
                  },
                  { id: "r-ref" },
                ),
              ],
              { stopReason: "toolUse" },
            );
          }
          if (last.role === "toolResult" && last.toolName === "read") {
            expect(text).toContain("Run the assigned script");
            return fauxAssistantMessage(
              [
                fauxToolCall(
                  "write",
                  { path: "hello.txt", content: "from the sandbox" },
                  { id: "w1" },
                ),
              ],
              { stopReason: "toolUse" },
            );
          }
          if (last.role === "toolResult" && last.toolName === "write") {
            return fauxAssistantMessage(
              [
                fauxToolCall(
                  "bash",
                  {
                    command:
                      ".agents/skills/demo/worker/probe/scripts/probe.sh",
                  },
                  { id: "b-script" },
                ),
              ],
              { stopReason: "toolUse" },
            );
          }
          if (last.role === "toolResult" && last.toolCallId === "b-script") {
            expect(text).toContain("skill-probe-ok");
            commandStarted();
            return fauxAssistantMessage(
              [
                fauxToolCall(
                  "bash",
                  { command: "sleep 10 && echo checked" },
                  { id: "b1" },
                ),
              ],
              { stopReason: "toolUse" },
            );
          }
          const scriptResult = request.messages.find(
            (message) =>
              message.role === "toolResult" &&
              message.toolCallId === "b-script",
          );
          expect(JSON.stringify(scriptResult)).toContain("skill-probe-ok");
          return fauxAssistantMessage([
            fauxText(
              `hello.txt written; script=skill-probe-ok; last tool said: ${text.replace(/\s+/g, " ")}`,
            ),
          ]);
        }),
      );
      let harnessReference = new HarnessReference();
      const agentsReference = new FixtureReference<
        ReturnType<typeof createAgents>
      >();
      let factory: AgentFactory;
      const Turn = defineTurn(() => ({
        send: async () => {},
        typing: async () => {},
      }));
      let version = 0;
      const open = async () => {
        harnessReference = new HarnessReference();
        version++;
        const catalog = await openSkillCatalog(
          store,
          config.skillRepositories,
          {},
        );
        const work = background
          ? createWork({
              harness: () => harnessReference.getHarness(),
              Turn,
              config,
              capture: (agent) =>
                agentsReference.getValue().captureWorkBlueprint(agent),
              configure: (tx, child, right, workId) =>
                agentsReference
                  .getValue()
                  .configureWorkConversation(tx, child, right, workId),
              clean: (id) => agentsReference.getValue().isWorkClean(id),
            })
          : undefined;
        factory = new AgentFactory(config, catalog, work, workspace);
        agentsReference.setValue(
          createAgents({
            images: { execution: `execution-v${version}` },
            skillCacheClaim: `skill-cache-v${version}`,
            harness: () => harnessReference.getHarness(),
            sandboxUrl: () => envdUrl,
            factory,
          }),
        );
        const registry = createRegistry();
        registry.install(CodingTools);
        registry.install(agentsReference.getValue().extension);
        registry.install(
          defineExtension({ name: "kaeno-channels", tasks: [Turn] }),
        );
        if (work) {
          registry.install(work.extension);
        }
        harnessReference.setHarness(
          await Harness.open(
            await openNodeSqliteStorage(join(dir, "kaeno.sqlite")),
            {
              models,
              registry,
              env: agentsReference.getValue().getExecutionEnvironment,
              settings: {
                extensions: [CodingTools, agentsReference.getValue().extension],
                toolExecution: "parallel",
              },
            },
            BACKGROUND_CONTEXT,
          ),
        );
        if (background) {
          harnessReference.getHarness().resume();
        }
        return harnessReference.getHarness();
      };
      const deps = createThreadFixture(() => harnessReference.getHarness(), {
        role: background ? ("chat" as const) : undefined,
        configure: (tx: Tx, id: ConversationId) =>
          factory.configureAgent(
            tx,
            id,
            background
              ? { role: "chat" }
              : { role: "legacy", agent: config.agent },
            agentsReference.getValue().extension,
          ),
      });
      await open();
      const id = await thread(deps, "test:1");
      const conversation = required(
        await harnessReference
          .getHarness()
          .conversation(id, BACKGROUND_CONTEXT),
      );
      if (background) {
        await harnessReference.getHarness().commit(
          (tx) =>
            admitTurn(tx, Turn, {
              conversationId: id,
              content: "Please get hello.txt written.",
              requestId: "req-00001",
            }),
          BACKGROUND_CONTEXT,
        );
      } else {
        await conversation.submit(
          {
            type: "input",
            content: "Please get hello.txt written.",
            requestId: "req-00001",
          },
          BACKGROUND_CONTEXT,
        );
      }
      await started; // worker verified the script and is about to run its slow command
      const childId = parseConversationId(
        Number(
          readObject(
            readObject(readObject(Array.from(pods.values())[0]).metadata)
              .annotations,
          )["kaeno.io/conversation"],
        ),
      );
      let running = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          (
            await harnessReference
              .getHarness()
              .snapshot(LiveDoc, childId, BACKGROUND_CONTEXT)
          )?.tools?.some(
            (template) =>
              template.callId === "b1" && template.status === "running",
          )
        ) {
          running = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(running).toBe(true); // crash at a committed running tool, not an arbitrary timer
      expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe(
        "from the sandbox",
      ); // written via envd
      expect(
        calls.filter((content) => content.startsWith("POST")),
      ).toHaveLength(1);
      agentsReference.getValue().shutdown(); // the process is stopped mid-delegation (SIGTERM)…
      await harnessReference.getHarness().close(BACKGROUND_CONTEXT);
      expect(pods.size).toBe(1); // …and the paused delegation keeps its sandbox
      if (recreate) {
        pods.clear();
        for (const name of await readdir(workspace)) {
          await rm(join(workspace, name), { recursive: true, force: true });
        } // new pod loses workspace
      }
      required(config.templates.worker).skills = []; // current selections changed; active conversations keep bindings
      required(
        // current selections changed; active conversations keep bindings
        config.templates.kaeno,
      ).skills = [];
      // The current catalogue no longer even contains these skills. Only immutable retained cache + SQLite bindings do.
      await rm(store, { recursive: true, force: true });
      await mkdir(store);
      await writeFile(
        join(store, "manifest.json"),
        JSON.stringify({ ...manifest, entries: [] }),
      );
      await open(); // new process, same storage
      await refreshThreads(deps); // busy root must keep its binding too
      expect(
        (
          await harnessReference
            .getHarness()
            .snapshot(AgentState, id, BACKGROUND_CONTEXT)
        )?.skills?.map((state) => state.id),
      ).toEqual(background ? [] : ["demo/root:guide"]);
      harnessReference.getHarness().resume();
      const again = required(
        await harnessReference
          .getHarness()
          .conversation(id, BACKGROUND_CONTEXT),
      );
      let answer: string;
      if (background) {
        let result: string | undefined;
        for (
          const end = Date.now() + 10000;
          Date.now() < end && !result;
          await new Promise((resolve) => setTimeout(resolve, 20))
        ) {
          result = (
            await harnessReference
              .getHarness()
              .snapshot(TurnLedger, id, BACKGROUND_CONTEXT)
          )?.replies.find((value) => value.source.kind === "work-result")?.text;
        }
        expect(result).toBeDefined();
        answer = required(result);
      } else {
        const settled = await (
          await again.submit(
            {
              type: "input",
              content: "Please get hello.txt written.",
              requestId: "req-00001",
            },
            BACKGROUND_CONTEXT,
          )
        ).wait(BACKGROUND_CONTEXT);
        expect(settled.status).toBe("done");
        answer = await answerText(
          harnessReference.getHarness(),
          required(settled.answer),
        );
      }
      expect(answer).toMatch(/^Worker reports: hello.txt written/);
      // The non-replay-safe bash call that the crash cut off is reported to the worker as interrupted, not rerun.
      expect(answer).toMatch(/interrupted/i);
      expect(answer).toContain("skill-probe-ok");
      // Resumed in the same sandbox: the rerun's create hit 409 (no second pod), and the file is still there.
      const creates = calls.filter((content) => content.startsWith("POST"));
      expect(creates).toHaveLength(2);
      expect(new Set(creates).size).toBe(1);
      if (!recreate) {
        expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe(
          "from the sandbox",
        );
      } else {
        await expect(readFile(join(workspace, "hello.txt"))).rejects.toThrow(
          /ENOENT/,
        );
        expect(
          await readFile(
            join(
              workspace,
              ".agents/skills/demo/worker/probe/scripts/probe.sh",
            ),
            "utf8",
          ),
        ).toContain("skill-probe-ok");
      }
      // The delegation then completed and deleted its sandbox.
      expect(
        calls.some((content) => content.startsWith("DELETE kaeno-sb-")),
      ).toBe(true);
      expect(pods.size).toBe(0);
      await thread(deps, "test:1"); // next idle admission applies the new root selection
      expect(
        (
          await harnessReference
            .getHarness()
            .snapshot(AgentState, id, BACKGROUND_CONTEXT)
        )?.skills,
      ).toEqual([]);
      await harnessReference.getHarness().close(BACKGROUND_CONTEXT);
      await new Promise<void>((ok) => envd.close(() => ok()));
      await new Promise<void>((ok) => kube.close(() => ok()));
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
    60000,
  );
});
