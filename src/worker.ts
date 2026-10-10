import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { Harness, createRegistry, defineExtension, defineTool, AssistantEntry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import type { Assignment } from "./ledger.ts";

// One process, one Pi store, one sandbox. IPC is the only path to the control plane.
type Start = { type: "start"; job: Assignment; cell: string; mode: "faux" | "openai" };
type Steer = { type: "steer"; requestId: string; text: string };
const send = (value: object) => { if (process.connected) process.send?.(value); };
process.on("disconnect", () => process.exit(70)); // A lost parent must not keep dispatching effects.
process.once("message", (message: Start) => { void start(message).catch(error => {
  send({ type: "failed", error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1;
}); });

async function start({ job, cell, mode }: Start) {
  const workspace = await realpath(resolve(cell, "workspace"));
  const models = createModels();
  if (mode === "openai") models.setProvider(openaiProvider());
  else {
    const faux = fauxProvider();
    const text = (content: unknown) => typeof content === "string" ? content :
      Array.isArray(content) ? content.filter((part): part is {type:string;text:string} => part?.type === "text").map(part => part.text).join("") : "";
    faux.setResponses(Array.from({ length: 100 }, () => (request: {messages: {role:string;content:unknown}[]}) => {
      const last = request.messages.findLast(m => m.role !== "system");
      const body = text(last?.content);
      if (last?.role === "toolResult") return fauxAssistantMessage(`Read result: ${body}`);
      if (body.startsWith("SLOW_TEST:")) return new Promise(resolve => setTimeout(() => resolve(fauxAssistantMessage(`Offline prototype response: ${body}`)),1200));
      if (body.includes("read note.txt")) return fauxAssistantMessage([fauxToolCall("read", {path:"note.txt"})], {stopReason:"toolUse"});
      return fauxAssistantMessage(`Offline prototype response: ${body}`);
    }));
    models.setProvider(faux.provider);
  }
  const base = createReadTool();
  const read = defineTool({ ...base, execute: async (args, api, context) => {
    const requested = resolve(workspace, args.path);
    if (requested !== workspace && !requested.startsWith(workspace + sep))
      return { content: [{type: "text" as const, text: "Outside assignment workspace"}], isError: true };
    let file: string;
    try { file = await realpath(requested); } catch { return {content:[{type:"text" as const,text:"File not found"}],isError:true}; }
    if (file !== workspace && !file.startsWith(workspace + sep))
      return {content:[{type:"text" as const,text:"Outside assignment workspace"}],isError:true};
    return base.execute({...args,path:file}, api, context);
  }});
  const extension = defineExtension({name:"kaeno.assignment.read",tools:[read]});
  const registry = createRegistry(); registry.install(extension);
  const harness = await Harness.open(await openNodeSqliteStorage(resolve(cell,"agent.sqlite")),
    {models,registry,env: () => new NodeExecutionEnv({cwd:workspace})}, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {agent: {
      model: {provider:mode === "openai" ? "openai":"faux",modelId:mode === "openai" ? "gpt-4o-mini":"faux-1"},
      cwd:workspace, instructions: `${job.profile.instructions}\nSkills: ${job.profile.skills.join(", ")}. Knowledge: ${job.profile.knowledge.join(", ")}. Read only the assignment workspace.`,
      extensions:job.profile.tools.length ? [extension] : [],
    }});
    harness.resume();
    let outstanding = 0;
    let initialDone = false;
    let finalizing = false;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    const answers: string[] = [];
    const settle = () => {
      if (!initialDone || outstanding || finalizing) return;
      if (finalTimer) clearTimeout(finalTimer);
      finalTimer = setTimeout(async () => {
        if (outstanding || finalizing) return;
        finalizing = true;
        send({type:"completed",text:answers.join("\n\n").slice(0,12000)});
        await harness.close(BACKGROUND_CONTEXT);
        process.exit(0);
      }, 150);
    };
    const submit = async (content: string, requestId: string) => {
      outstanding++;
      try {
        const submission = await root.submit({type:"input",content,requestId,whenBusy:"followUp"},BACKGROUND_CONTEXT);
        send({type:"admitted",requestId});
        const result = await submission.wait(BACKGROUND_CONTEXT);
        if (result.status !== "done" || result.type !== "input") throw new Error("Agent input unanswered");
        const entry = await root.commit(tx => tx.entry(AssistantEntry, result.answer),BACKGROUND_CONTEXT);
        const body = entry?.model?.[0]?.content;
        answers.push(typeof body === "string" ? body : body?.flatMap(p => p.type === "text" ? [p.text] : []).join("") ?? "");
      } finally { outstanding--; settle(); }
    };
    process.on("message", (message: Steer) => {
      if (message.type === "steer" && !finalizing) void submit(`Supervisor steering: ${message.text}`,`steer:${message.requestId}`).catch(error => send({type:"failed",error:String(error)}));
    });
    send({type:"ready"});
    await submit(job.objective,`assignment:${job.id}`);
    initialDone = true;
    settle();
  } catch (error) { await harness.close(BACKGROUND_CONTEXT); throw error; }
}
