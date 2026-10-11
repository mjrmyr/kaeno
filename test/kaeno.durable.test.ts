// End to end without cloud or cluster: kaeno (faux model) delegates to a sandboxed worker whose tools run through a
// real envd; the process "crashes" while the worker's command runs, and a new Harness on the same SQLite file
// finishes the job in the same sandbox, then deletes it.
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Config } from "../src/config.ts";
import { createWork } from "../src/work.ts";
import { admitTurn, TurnLedger } from "../src/turns.ts";
import { copySkillTree, inspectSkill, INSTALLER, materializeSkillSelection, openSkillCatalog, type SkillManifest } from "../src/skills.ts";

const listen = (server: ReturnType<typeof createServer>) =>
  new Promise<string>(ok => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

describe("kaeno durable delegation", () => {
  it.each([
    { recreate: false, background: false }, { recreate: true, background: false },
    { recreate: false, background: true }, { recreate: true, background: true },
  ])("loads assigned skills and resumes frozen images (recreate=$recreate, background=$background)", async ({ recreate, background }) => {
    const dir = await mkdtemp(join(tmpdir(), "kaeno-durable-"));
    const workspace = await mkdtemp(join(tmpdir(), "kaeno-pod-"));
    const store = join(dir, "catalogue");
    const cache = join(dir, "persistent-skill-cache");
    const rootSkill = join(store, "demo/root/guide");
    const workerSkill = join(store, "demo/worker/probe");
    await mkdir(rootSkill, { recursive: true }); await mkdir(join(workerSkill, "references"), { recursive: true }); await mkdir(join(workerSkill, "scripts"));
    await writeFile(join(rootSkill, "SKILL.md"), "---\nname: guide\ndescription: Orchestrate work.\n---\nDelegate real work and check results.\n");
    await writeFile(join(workerSkill, "SKILL.md"), "---\nname: probe\ndescription: Print skill-probe-ok with a script.\n---\nRead references/guide.md then run scripts/probe.sh.\n");
    await writeFile(join(workerSkill, "references/guide.md"), "Run the assigned script, not unrelated skills.\n");
    await writeFile(join(workerSkill, "scripts/probe.sh"), "#!/bin/sh\nprintf 'skill-probe-ok\\n'\n");
    await chmod(join(workerSkill, "scripts/probe.sh"), 0o755);
    const manifest: SkillManifest = { schema: 1, installer: INSTALLER,
      repositories: [{ id: "demo/root", commit: "a".repeat(40) }, { id: "demo/worker", commit: "b".repeat(40) }],
      entries: [{ id: "demo/root:guide", treeHash: (await inspectSkill(rootSkill)).treeHash }, { id: "demo/worker:probe", treeHash: (await inspectSkill(workerSkill)).treeHash }] };
    await writeFile(join(store, "manifest.json"), JSON.stringify(manifest));
    for (const entry of manifest.entries) await copySkillTree(join(store, entry.id.replace(":", "/")), join(cache, "trees", entry.treeHash));
    // A fake Kubernetes API: pods are created, always Ready, and deleted.
    const calls: string[] = [];
    const pods = new Map<string, unknown>();
    let podToken = "";
    const kube = createServer(async (req, res) => {
      let raw = ""; for await (const c of req) raw += c;
      const name = req.url!.split("?")[0]!.split("/").pop()!;
      calls.push(`${req.method} ${req.method === "POST" ? JSON.parse(raw).metadata.name : name}`);
      if (req.method === "POST") {
        const pod = JSON.parse(raw);
        if (pods.has(pod.metadata.name)) { res.writeHead(409).end("{}"); return; }
        podToken = pod.spec.containers[0].env.find((e: any) => e.name === "KAENO_ENV_TOKEN").value; // as the pod would get it
        expect(pod.spec.containers[0].image).toBe("execution-v1");
        expect(pod.spec.initContainers[0].image).toBe("execution-v1");
        expect(pod.spec.volumes.find((v: any) => v.name === "skill-cache").persistentVolumeClaim.claimName).toBe("skill-cache-v1");
        const plan = JSON.parse(pod.spec.initContainers[0].env[0].value);
        await materializeSkillSelection(cache, plan, join(workspace, ".agents/skills"));
        expect(await readdir(join(workspace, ".agents/skills/demo"))).toEqual(["worker"]);
        pods.set(pod.metadata.name, pod); res.writeHead(201).end(raw); return;
      }
      if (req.method === "DELETE") { pods.delete(name); res.writeHead(200).end("{}"); return; }
      if (name === "pods") { res.writeHead(200).end(JSON.stringify({ items: [...pods.values()] })); return; }
      res.writeHead(pods.has(name) ? 200 : 404).end(JSON.stringify({ status: { conditions: [{ type: "Ready", status: "True" }] } }));
    });
    process.env.KUBERNETES_API = await listen(kube);
    process.env.KUBERNETES_TOKEN_FILE = join(dir, "token");
    await writeFile(process.env.KUBERNETES_TOKEN_FILE, "fake");
    const { createEnvServer } = await import("../src/envd.ts");
    const envd = createEnvServer({ token: () => podToken, root: workspace });
    const envdUrl = await listen(envd);
    const { createAgents, AgentState } = await import("../src/agents.ts");
    const { defineTurn, thread, answerText, refreshThreads } = await import("../src/threads.ts");

    const config: Config = {
      agent: "kaeno", skillRepositories: [{ id: "demo/root" }, { id: "demo/worker" }],
      templates: {
        kaeno: { name: "kaeno", description: "orchestrator", model: { provider: "faux" as any, modelId: "faux-1" }, instructions: "ORCHESTRATOR", sandbox: false, tools: [], delegates: ["worker"], skills: [recreate ? "demo/root:*" : "demo/root:guide"] },
        worker: { name: "worker", description: "worker", model: { provider: "faux" as any, modelId: "faux-1" }, instructions: "WORKER", sandbox: true, tools: ["read", "write", "edit", "bash"], delegates: [], skills: [recreate ? "demo/worker:*" : "demo/worker:probe"] },
      },
      telegram: { allowedChatIds: [] },
    };

    // One scripted model for both agents, routed by role (system prompt) and the latest message.
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    let commandStarted!: () => void;
    const started = new Promise<void>(ok => (commandStarted = ok));
    faux.setResponses(Array.from({ length: 30 }, () => (request: any) => {
      const system = JSON.stringify(request.messages.filter((m: any) => m.role === "system"));
      const last = request.messages.findLast((m: any) => m.role !== "system");
      const text = typeof last.content === "string" ? last.content : last.content.map((p: any) => p.text ?? "").join("");
      if (system.includes("Kaeno CHAT")) {
        if (last.role === "toolResult") return fauxAssistantMessage([fauxText("ACK: work accepted")]);
        if (text.startsWith("Work #")) return fauxAssistantMessage([fauxText(text.split("\n\n").slice(1).join("\n\n"))]);
        return fauxAssistantMessage([fauxToolCall("start_work", { agent: "kaeno", title: "Write file", brief: "Please get hello.txt written." }, { id: "start" })], { stopReason: "toolUse" });
      }
      if (system.includes("ORCHESTRATOR")) {
        expect(system).not.toContain("Run the assigned script, not unrelated skills.");
        if (last.role === "toolResult" && last.toolName === "delegate") return fauxAssistantMessage([fauxText(`Worker reports: ${text}`)]);
        if (last.role === "toolResult" && last.toolName === "read_skill") {
          expect(text).toContain("Delegate real work");
          return fauxAssistantMessage([fauxToolCall("delegate", { agent: "worker", task: "Write hello.txt, then run the slow check." }, { id: "d1" })], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage([fauxToolCall("read_skill", { skill: "demo/root:guide" }, { id: "r-root" })], { stopReason: "toolUse" });
      }
      expect(system).not.toContain("demo/root:guide");
      if (last.role === "user") return fauxAssistantMessage([fauxToolCall("read_skill", { skill: "demo/worker:probe" }, { id: "r-worker" })], { stopReason: "toolUse" });
      if (last.role === "toolResult" && last.toolName === "read_skill") {
        expect(text).toContain("Read references/guide.md");
        return fauxAssistantMessage([fauxToolCall("read", { path: ".agents/skills/demo/worker/probe/references/guide.md" }, { id: "r-ref" })], { stopReason: "toolUse" });
      }
      if (last.role === "toolResult" && last.toolName === "read") {
        expect(text).toContain("Run the assigned script");
        return fauxAssistantMessage([fauxToolCall("write", { path: "hello.txt", content: "from the sandbox" }, { id: "w1" })], { stopReason: "toolUse" });
      }
      if (last.role === "toolResult" && last.toolName === "write") {
        return fauxAssistantMessage([fauxToolCall("bash", { command: ".agents/skills/demo/worker/probe/scripts/probe.sh" }, { id: "b-script" })], { stopReason: "toolUse" });
      }
      if (last.role === "toolResult" && last.toolCallId === "b-script") {
        expect(text).toContain("skill-probe-ok");
        commandStarted();
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 10 && echo checked" }, { id: "b1" })], { stopReason: "toolUse" });
      }
      const scriptResult = request.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === "b-script");
      expect(JSON.stringify(scriptResult)).toContain("skill-probe-ok");
      return fauxAssistantMessage([fauxText(`hello.txt written; script=skill-probe-ok; last tool said: ${text.replace(/\s+/g, " ")}`)]);
    }));

    let harness!: Harness;
    let agents!: ReturnType<typeof createAgents>;
    const Turn = defineTurn(() => ({ send: async () => {}, typing: async () => {} }));
    let version = 0;
    const open = async () => { // a fresh process: new agents, same storage; different current images on reopen
      version++;
      const catalog = await openSkillCatalog(store, config.skillRepositories, {});
      const work = background ? createWork({ harness: () => harness, Turn, config, capture: agent => agents.captureWork(agent), configure: (tx, child, b, workId) => agents.configureWork(tx, child, b, workId), clean: id => agents.workClean(id) }) : undefined;
      agents = createAgents({ config, images: { execution: `execution-v${version}` }, skillCacheClaim: `skill-cache-v${version}`, skills: catalog, harness: () => harness, sandboxUrl: () => envdUrl, sandboxCwd: workspace, work });
      const registry = createRegistry();
      registry.install(CodingTools); registry.install(agents.Kaeno); registry.install(defineExtension({ name: "kaeno-channels", tasks: [Turn] }));
      if (work) registry.install(work.extension);
      harness = await Harness.open(await openNodeSqliteStorage(join(dir, "kaeno.sqlite")), {
        models, registry, env: agents.env, settings: { extensions: [CodingTools, agents.Kaeno], toolExecution: "parallel" },
      }, BACKGROUND_CONTEXT);
      if (background) harness.resume();
      return harness;
    };
    const deps = { harness: () => harness, agent: { template: "kaeno", role: background ? "chat" as const : undefined, change: () => agents.agentChange(config.templates.kaeno!), skills: () => agents.bindSkills(config.templates.kaeno!) } };

    await open();
    const id = await thread(deps, "test:1");
    const conversation = (await harness.conversation(id, BACKGROUND_CONTEXT))!;
    if (background) await harness.commit(tx => admitTurn(tx, Turn, { conversationId: id, content: "Please get hello.txt written.", requestId: "req-00001" }), BACKGROUND_CONTEXT);
    else await conversation.submit({ type: "input", content: "Please get hello.txt written.", requestId: "req-00001" }, BACKGROUND_CONTEXT);
    await started;                                  // worker verified the script and is about to run its slow command
    const childId = Number((Array.from(pods.values())[0] as any).metadata.annotations["kaeno.io/conversation"]) as any;
    let running = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await harness.snapshot(LiveDoc, childId, BACKGROUND_CONTEXT))?.tools?.some(t => t.callId === "b1" && t.status === "running")) { running = true; break; }
      await new Promise(r => setTimeout(r, 20));
    }
    expect(running).toBe(true); // crash at a committed running tool, not an arbitrary timer
    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("from the sandbox"); // written via envd
    expect(calls.filter(c => c.startsWith("POST"))).toHaveLength(1);
    agents.shutdown();                              // the process is stopped mid-delegation (SIGTERM)…
    await harness.close(BACKGROUND_CONTEXT);
    expect(pods.size).toBe(1);                      // …and the paused delegation keeps its sandbox

    if (recreate) {
      pods.clear();
      for (const name of await readdir(workspace)) await rm(join(workspace, name), { recursive: true, force: true }); // new pod loses workspace
    }
    config.templates.worker!.skills = []; // current selections changed; active conversations keep bindings
    config.templates.kaeno!.skills = [];
    // The current catalogue no longer even contains these skills. Only immutable retained cache + SQLite bindings do.
    await rm(store, { recursive: true, force: true }); await mkdir(store);
    await writeFile(join(store, "manifest.json"), JSON.stringify({ ...manifest, entries: [] }));
    await open();                                   // new process, same storage
    await refreshThreads(deps);                      // busy root must keep its binding too
    expect((await harness.snapshot(AgentState, id, BACKGROUND_CONTEXT))?.skills?.map(s => s.id)).toEqual(background ? [] : ["demo/root:guide"]);
    harness.resume();
    const again = (await harness.conversation(id, BACKGROUND_CONTEXT))!;
    let answer: string;
    if (background) {
      let result: string | undefined;
      for (const end = Date.now() + 10_000; Date.now() < end && !result; await new Promise(r => setTimeout(r, 20))) {
        result = (await harness.snapshot(TurnLedger, id, BACKGROUND_CONTEXT))?.replies.find(r => r.source.kind === "work-result")?.text;
      }
      expect(result).toBeDefined(); answer = result!;
    } else {
      const settled = await (await again.submit({ type: "input", content: "Please get hello.txt written.", requestId: "req-00001" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
      expect(settled.status).toBe("done");
      answer = await answerText(harness, (settled as any).answer);
    }
    expect(answer).toMatch(/^Worker reports: hello.txt written/);
    // The non-replay-safe bash call that the crash cut off is reported to the worker as interrupted, not rerun.
    expect(answer).toMatch(/interrupted/i);
    expect(answer).toContain("skill-probe-ok");
    // Resumed in the same sandbox: the rerun's create hit 409 (no second pod), and the file is still there.
    const creates = calls.filter(c => c.startsWith("POST"));
    expect(creates).toHaveLength(2);
    expect(new Set(creates).size).toBe(1);
    if (!recreate) expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("from the sandbox");
    else {
      await expect(readFile(join(workspace, "hello.txt"))).rejects.toThrow(/ENOENT/);
      expect(await readFile(join(workspace, ".agents/skills/demo/worker/probe/scripts/probe.sh"), "utf8")).toContain("skill-probe-ok");
    }
    // The delegation then completed and deleted its sandbox.
    expect(calls.some(c => c.startsWith("DELETE kaeno-sb-"))).toBe(true);
    expect(pods.size).toBe(0);
    await thread(deps, "test:1"); // next idle admission applies the new root selection
    expect((await harness.snapshot(AgentState, id, BACKGROUND_CONTEXT))?.skills).toEqual([]);

    await harness.close(BACKGROUND_CONTEXT);
    await new Promise<void>(ok => envd.close(() => ok())); await new Promise<void>(ok => kube.close(() => ok()));
    await rm(dir, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true });
  }, 60_000);
});
