// End to end without cloud or cluster: kaeno (faux model) delegates to a sandboxed worker whose tools run through a
// real envd; the process "crashes" while the worker's command runs, and a new Harness on the same SQLite file
// finishes the job in the same sandbox, then deletes it.
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Config } from "../src/config.ts";

const listen = (server: ReturnType<typeof createServer>) =>
  new Promise<string>(ok => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

describe("kaeno durable delegation", () => {
  it("delegates to a sandboxed worker, survives a crash mid-command, and cleans up its sandbox", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kaeno-durable-"));
    const workspace = await mkdtemp(join(tmpdir(), "kaeno-pod-"));
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
    const { createAgents } = await import("../src/agents.ts");
    const { defineTurn, thread, answerText } = await import("../src/threads.ts");

    const config: Config = {
      agent: "kaeno",
      templates: {
        kaeno: { name: "kaeno", description: "orchestrator", model: { provider: "faux" as any, modelId: "faux-1" }, instructions: "ORCHESTRATOR", sandbox: false, tools: [], delegates: ["worker"] },
        worker: { name: "worker", description: "worker", model: { provider: "faux" as any, modelId: "faux-1" }, instructions: "WORKER", sandbox: true, tools: ["read", "write", "edit", "bash"], delegates: [] },
      },
      telegram: { allowedChatIds: [] }, schedules: [],
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
      if (system.includes("ORCHESTRATOR")) {
        if (last.role === "toolResult") return fauxAssistantMessage([fauxText(`Worker reports: ${text}`)]);
        return fauxAssistantMessage([fauxToolCall("delegate", { agent: "worker", task: "Write hello.txt, then run the slow check." }, { id: "d1" })], { stopReason: "toolUse" });
      }
      if (last.role === "user") return fauxAssistantMessage([fauxToolCall("write", { path: "hello.txt", content: "from the sandbox" }, { id: "w1" })], { stopReason: "toolUse" });
      if (last.role === "toolResult" && last.toolName === "write") {
        commandStarted();
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 2 && echo checked" }, { id: "b1" })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage([fauxText(`hello.txt written; last tool said: ${text.replace(/\s+/g, " ")}`)]);
    }));

    let harness!: Harness;
    let agents!: ReturnType<typeof createAgents>;
    const Turn = defineTurn(() => ({ send: async () => {}, typing: async () => {} }));
    const open = async () => { // a fresh process: new agents, same storage
      agents = createAgents({ config, image: () => "img", harness: () => harness, sandboxUrl: () => envdUrl, sandboxCwd: workspace });
      const registry = createRegistry();
      registry.install(CodingTools); registry.install(agents.Kaeno); registry.install(defineExtension({ name: "kaeno-channels", tasks: [Turn] }));
      harness = await Harness.open(await openNodeSqliteStorage(join(dir, "kaeno.sqlite")), {
        models, registry, env: agents.env, settings: { extensions: [CodingTools, agents.Kaeno], toolExecution: "parallel" },
      }, BACKGROUND_CONTEXT);
      return harness;
    };
    const deps = { harness: () => harness, agent: { template: "kaeno", change: () => agents.agentChange(config.templates.kaeno!) } };

    await open();
    const id = await thread(deps, "test:1");
    const conversation = (await harness.conversation(id, BACKGROUND_CONTEXT))!;
    await conversation.submit({ type: "input", content: "Please get hello.txt written.", requestId: "req-00001" }, BACKGROUND_CONTEXT);
    await started;                                  // worker wrote the file and is about to run its slow command
    await new Promise(r => setTimeout(r, 300));
    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("from the sandbox"); // written via envd
    expect(calls.filter(c => c.startsWith("POST"))).toHaveLength(1);
    agents.shutdown();                              // the process is stopped mid-delegation (SIGTERM)…
    await harness.close(BACKGROUND_CONTEXT);
    expect(pods.size).toBe(1);                      // …and the paused delegation keeps its sandbox

    await open();                                   // new process, same storage
    harness.resume();
    const again = (await harness.conversation(id, BACKGROUND_CONTEXT))!;
    const settled = await (await again.submit({ type: "input", content: "Please get hello.txt written.", requestId: "req-00001" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe("done");
    const answer = await answerText(harness, (settled as any).answer);
    expect(answer).toMatch(/^Worker reports: hello.txt written/);
    // The non-replay-safe bash call that the crash cut off is reported to the worker as interrupted, not rerun.
    expect(answer).toMatch(/interrupted/i);
    // Resumed in the same sandbox: the rerun's create hit 409 (no second pod), and the file is still there.
    const creates = calls.filter(c => c.startsWith("POST"));
    expect(creates).toHaveLength(2);
    expect(new Set(creates).size).toBe(1);
    expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("from the sandbox");
    // The delegation then completed and deleted its sandbox.
    expect(calls.some(c => c.startsWith("DELETE kaeno-sb-"))).toBe(true);
    expect(pods.size).toBe(0);

    await harness.close(BACKGROUND_CONTEXT);
    await new Promise<void>(ok => envd.close(() => ok())); await new Promise<void>(ok => kube.close(() => ok()));
    await rm(dir, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true });
  }, 60_000);
});
