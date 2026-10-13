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
import { messageText, required, serverPort } from "./values.ts";
// End to end without cloud or cluster: CHAT (faux model) starts an orchestrating WORK, which starts a worker WORK; both
// run in sandboxes whose tools go through a real envd. The process "crashes" while the worker's command runs, and a
// new Harness on the same SQLite file finishes the tree in the same sandboxes, reports up to CHAT, and deletes them.
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
import { createServer, type Server } from "node:http";
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
describe("kaeno durable work tree", () => {
  it.each([{ recreate: false }, { recreate: true }])(
    "loads assigned skills and resumes nested sandboxed WORK after a crash (recreate=$recreate)",
    async ({ recreate }) => {
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
          labels: z.record(z.string(), z.string()),
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
      const tokens = new Set<string>();
      // One envd per pod, all on the shared workspace, each accepting only its own pod's token.
      const envds = new Map<string, { server: Server; url: string }>();
      const plans: Record<string, string[]> = {};
      let materializing = Promise.resolve();
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
          const token = z
            .string()
            .parse(
              pod.spec.containers[0].env.find(
                (environment) => environment.name === "KAENO_ENV_TOKEN",
              )?.value,
            ); // as the pod would get it
          tokens.add(token);
          if (!envds.has(pod.metadata.name)) {
            const server = createEnvServer({ token, root: workspace });
            envds.set(pod.metadata.name, { server, url: await listen(server) });
          }
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
          plans[required(pod.metadata.labels["kaeno.io/template"])] = plan.map(
            (entry) => entry.id,
          );
          // Real pods materialize into their own filesystems; this shared workspace needs one copy at a time.
          materializing = materializing.then(() =>
            materializeSkillSelection(
              cache,
              plan,
              join(workspace, ".agents/skills"),
            ),
          );
          await materializing;
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
      const config: Config = {
        agent: "kaeno",
        maxDepth: 2,
        sandboxCapacity: 4,
        skillRepositories: [{ id: "demo/root" }, { id: "demo/worker" }],
        templates: {
          kaeno: {
            name: "kaeno",
            description: "front desk",
            model: { provider: "anthropic", modelId: "faux-1" },
            instructions: "FRONT DESK",
            delegates: ["orchestrator"],
            skills: [],
          },
          orchestrator: {
            name: "orchestrator",
            description: "orchestrator",
            model: { provider: "anthropic", modelId: "faux-1" },
            instructions: "ORCHESTRATOR",
            delegates: ["worker"],
            skills: [recreate ? "demo/root:*" : "demo/root:guide"],
          },
          worker: {
            name: "worker",
            description: "worker",
            model: { provider: "anthropic", modelId: "faux-1" },
            instructions: "WORKER",
            delegates: [],
            skills: [recreate ? "demo/worker:*" : "demo/worker:probe"],
          },
        },
        telegram: { allowedChatIds: [] },
      };
      // One scripted model for every agent, routed by role (system prompt) and the latest message.
      const faux = fauxProvider({ provider: "anthropic" });
      const models = createModels();
      models.setProvider(faux.provider);
      let commandStarted: () => void;
      const started = new Promise<void>((ok) => (commandStarted = ok));
      faux.setResponses(
        Array.from({ length: 40 }, () => (request: TranscriptContext) => {
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
                    agent: "orchestrator",
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
            if (text.startsWith("Child Work #")) {
              return fauxAssistantMessage([
                fauxText(
                  `Worker reports: ${text.split("\n\n").slice(1).join("\n\n")}`,
                ),
              ]);
            }
            if (last.role === "toolResult" && last.toolName === "start_work") {
              expect(text).toContain("Started work #");
              return fauxAssistantMessage([
                fauxText("Waiting for the worker."),
              ]);
            }
            if (last.role === "toolResult" && last.toolName === "read_skill") {
              expect(text).toContain("Delegate real work");
              return fauxAssistantMessage(
                [
                  fauxToolCall(
                    "start_work",
                    {
                      agent: "worker",
                      title: "Hello",
                      brief: "Write hello.txt, then run the slow check.",
                    },
                    { id: "child" },
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
          expect(system).toContain("WORKER");
          expect(system).not.toContain("demo/root:guide");
          expect(system).not.toContain("Child work templates");
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
        const work = createWork({
          harness: () => harnessReference.getHarness(),
          Turn,
          config,
          agents: () => agentsReference.getValue(),
        });
        factory = new AgentFactory(config, catalog, work, workspace);
        agentsReference.setValue(
          createAgents({
            images: { execution: `execution-v${version}` },
            skillCacheClaim: `skill-cache-v${version}`,
            harness: () => harnessReference.getHarness(),
            sandboxUrl: (pod) => required(envds.get(pod)).url,
            factory,
          }),
        );
        const registry = createRegistry();
        registry.install(CodingTools);
        registry.install(agentsReference.getValue().extension);
        registry.install(
          defineExtension({ name: "kaeno-channels", tasks: [Turn] }),
        );
        registry.install(work.extension);
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
        harnessReference.getHarness().resume();
        return harnessReference.getHarness();
      };
      const deps = createThreadFixture(() => harnessReference.getHarness(), {
        role: "chat",
        configure: (tx: Tx, id: ConversationId) =>
          factory.configureAgent(
            tx,
            id,
            { role: "chat" },
            agentsReference.getValue().extension,
          ),
      });
      await open();
      const id = await thread(deps, "test:1");
      await harnessReference.getHarness().commit(
        (tx) =>
          admitTurn(tx, Turn, {
            conversationId: id,
            content: "Please get hello.txt written.",
            requestId: "req-00001",
          }),
        BACKGROUND_CONTEXT,
      );
      await started; // worker verified the script and is about to run its slow command
      expect(plans).toEqual({
        orchestrator: ["demo/root:guide"],
        worker: ["demo/worker:probe"],
      });
      const workerPod = required(
        [...pods.values()].find(
          (pod) => pod.metadata.labels["kaeno.io/template"] === "worker",
        ),
      );
      const childId = parseConversationId(
        Number(workerPod.metadata.annotations["kaeno.io/conversation"]),
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
      expect(tokens.size).toBe(2);
      // Each supervisor entry converges on its pod; repeats are 409 adoptions of the same two pods.
      expect(
        new Set(calls.filter((content) => content.startsWith("POST"))).size,
      ).toBe(2);
      await harnessReference.getHarness().close(BACKGROUND_CONTEXT); // the process is stopped (SIGTERM)…
      expect(pods.size).toBe(2); // …and the paused tree keeps both sandboxes
      if (recreate) {
        pods.clear();
        for (const name of await readdir(workspace)) {
          await rm(join(workspace, name), { recursive: true, force: true });
        } // new pods lose the workspace
      }
      required(config.templates.worker).skills = []; // current selections changed; active work keeps bindings
      required(config.templates.orchestrator).skills = [];
      // The current catalogue no longer even contains these skills. Only immutable retained cache + SQLite bindings do.
      await rm(store, { recursive: true, force: true });
      await mkdir(store);
      await writeFile(
        join(store, "manifest.json"),
        JSON.stringify({ ...manifest, entries: [] }),
      );
      await open(); // new process, same storage
      await refreshThreads(deps);
      let answer: string | undefined;
      for (
        const end = Date.now() + 15000;
        Date.now() < end && !answer;
        await new Promise((resolve) => setTimeout(resolve, 20))
      ) {
        answer = (
          await harnessReference
            .getHarness()
            .snapshot(TurnLedger, id, BACKGROUND_CONTEXT)
        )?.replies.find((value) => value.source.kind === "work-result")?.text;
      }
      expect(answer).toMatch(/^Worker reports: hello.txt written/);
      // The non-replay-safe bash call that the crash cut off is reported to the worker as interrupted, not rerun.
      expect(answer).toMatch(/interrupted/i);
      expect(answer).toContain("skill-probe-ok");
      // Resumed in the same sandboxes: re-creates either hit 409 or replace a lost pod; never a third pod.
      const creates = calls.filter((content) => content.startsWith("POST"));
      expect(new Set(creates).size).toBe(2);
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
      // Every finished WORK deleted its sandbox.
      for (let attempt = 0; attempt < 100 && pods.size > 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(pods.size).toBe(0);
      await harnessReference.getHarness().close(BACKGROUND_CONTEXT);
      for (const { server } of envds.values()) {
        await new Promise<void>((ok) => server.close(() => ok()));
      }
      await new Promise<void>((ok) => kube.close(() => ok()));
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
    60000,
  );
});
