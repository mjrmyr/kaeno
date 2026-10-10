import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { Ledger, type Agent, type Assignment } from "./ledger.ts";
import { launch } from "./sandbox.ts";

const bad = (response: import("node:http").ServerResponse, status: number, message: string) => reply(response,status,{error:message});
const reply = (response: import("node:http").ServerResponse, status: number, data: unknown) => {
  response.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}); response.end(JSON.stringify(data));
};
async function body(request: import("node:http").IncomingMessage) {
  let raw = "";
  for await (const chunk of request) { raw += chunk; if (raw.length > 20000) throw new Error("Body too large"); }
  return JSON.parse(raw) as Record<string, unknown>;
}
const id = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{4,100}$/.test(value);
function validateAgents(raw: unknown): Agent[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error("Agent registry must be a nonempty array");
  const names = new Set<string>();
  return raw.map((a: unknown) => {
    if (!a || typeof a !== "object") throw new Error("Invalid agent");
    const agent = a as Agent;
    if (typeof agent.name !== "string" || !/^[a-z][a-z0-9_-]{1,31}$/.test(agent.name) || names.has(agent.name) ||
      typeof agent.instructions !== "string" || !agent.instructions.trim() || agent.instructions.length > 4000 ||
      !Array.isArray(agent.skills) || !agent.skills.every(x => typeof x === "string" && x.length < 200) ||
      !Array.isArray(agent.knowledge) || !agent.knowledge.every(x => typeof x === "string" && x.length < 200) ||
      !Array.isArray(agent.tools) || agent.tools.some(x => x !== "read")) throw new Error("Invalid agent profile");
    names.add(agent.name); return agent;
  });
}
export async function createService(options: { dir: string; port?: number; mode?: "faux"|"openai" }) {
  const dir = resolve(options.dir);
  await mkdir(dir,{recursive:true,mode:0o700});
  const tokenFile = join(dir,"token");
  try { await writeFile(tokenFile,randomBytes(32).toString("hex")+"\n",{flag:"wx",mode:0o600}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const token = (await readFile(tokenFile,"utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid service token");
  const registryFile = join(dir,"agents.json");
  try { await writeFile(registryFile,JSON.stringify([
    {name:"researcher",instructions:"You are a careful researcher. Cite evidence from the workspace when present.",skills:["research"],knowledge:[],tools:["read"]},
    {name:"planner",instructions:"You are a planner. Produce concise actionable plans.",skills:["planning"],knowledge:[],tools:[]}
  ],null,2)+"\n",{flag:"wx",mode:0o600}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const agents = validateAgents(JSON.parse(await readFile(registryFile,"utf8")));
  const ledger = new Ledger(join(dir,"ledger.sqlite"));
  // Old owner may still be alive. A previous running cell is never auto-duplicated.
  for (const job of ledger.list()) if (job.state === "starting" || job.state === "running") ledger.transition(job.id,"blocked","Restart: exclusive worker shutdown has not been proven");
  const active = new Map<string,ChildProcess>();
  const starting = new Set<string>();
  const dispatches = new Set<Promise<void>>();
  const mode = options.mode ?? "faux";
  let stopping = false;
  async function dispatch(job: Assignment) {
    if (active.has(job.id) || starting.has(job.id) || stopping) return;
    starting.add(job.id);
    try {
      ledger.transition(job.id,"starting","Preparing isolated worker");
      const cell = join(dir,"cells",job.id);
      await mkdir(join(cell,"workspace"),{recursive:true,mode:0o700});
      await mkdir(join(cell,"tmp"),{recursive:true,mode:0o700});
      const worker = await launch(job,cell,mode);
      active.set(job.id,worker);
      let completed = false;
      worker.on("message",(message: {type:string; text?:string; error?:string}) => {
        if (message.type === "ready" && ledger.get(job.id)?.state === "starting") {
          ledger.transition(job.id,"running","Sandboxed Pi Durable worker started");
          for (const command of ledger.commands(job.id)) worker.send({type:"steer",...command});
        } else if (message.type === "completed" && ledger.get(job.id)?.state === "running") {
          completed = true;
          ledger.transition(job.id,"completed","Agent returned a saved answer",message.text ?? "");
        } else if (message.type === "failed" && ["starting", "running"].includes(ledger.get(job.id)?.state ?? "")) {
          ledger.transition(job.id,"blocked",message.error ?? "Worker failed; effect status unknown");
          worker.kill();
        }
      });
      worker.once("exit",(code,signal) => {
        active.delete(job.id);
        if (!completed && ["starting", "running"].includes(ledger.get(job.id)?.state ?? "")) ledger.transition(job.id,"blocked",`Worker exited (${code ?? signal}); effects may be uncertain`);
      });
      worker.once("error",error => {
        active.delete(job.id);
        if (["starting", "running"].includes(ledger.get(job.id)?.state ?? "")) ledger.transition(job.id,"blocked",`Worker launch failed: ${error.message}`);
      });
      worker.send({type:"start",job,cell,mode});
    } catch (error) {
      if (ledger.get(job.id)?.state === "starting") ledger.transition(job.id,"blocked",`Cannot start sandbox: ${String(error)}`);
    } finally { starting.delete(job.id); }
  }
  function schedule(job: Assignment) {
    const pending = dispatch(job);
    dispatches.add(pending);
    void pending.finally(() => dispatches.delete(pending));
  }
  const server: Server = createServer((request,response) => { void (async () => {
    const path = new URL(request.url ?? "/","http://localhost").pathname;
    if (path === "/" && request.method === "GET") {
      response.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});
      response.end(await readFile(resolve(import.meta.dirname,"../public/client.html"))); return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) return bad(response,401,"Unauthorized");
    if (path === "/api/agents" && request.method === "GET") return reply(response,200,agents.map(({name,skills,knowledge,tools}) => ({name,skills,knowledge,tools})));
    if (path === "/api/assignments" && request.method === "GET") return reply(response,200,ledger.list());
    if (path === "/api/assignments" && request.method === "POST") {
      const data = await body(request);
      if (!id(data.requestId) || typeof data.agent !== "string" || typeof data.objective !== "string" || !data.objective.trim() || data.objective.length > 4000) throw new Error("Invalid assignment");
      const agent = agents.find(a => a.name === data.agent);
      if (!agent) return bad(response,404,"Unknown agent");
      const job = ledger.accept(data.requestId as string,agent,data.objective);
      reply(response,202,job);
      if (job.state === "queued") schedule(job);
      return;
    }
    if (path === "/api/events" && request.method === "GET") {
      const after = Number(new URL(request.url ?? "", "http://localhost").searchParams.get("after") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid cursor");
      return reply(response,200,ledger.events(after));
    }
    const match = /^\/api\/assignments\/([a-f0-9-]{36})(\/steer)?$/.exec(path);
    if (match && request.method === "GET" && !match[2]) {
      const job = ledger.get(match[1]!); return job ? reply(response,200,job) : bad(response,404,"Unknown assignment");
    }
    if (match && request.method === "POST" && match[2]) {
      const data = await body(request);
      if (!id(data.requestId) || typeof data.text !== "string" || !data.text.trim() || data.text.length > 2000) throw new Error("Invalid steering command");
      const fresh = ledger.command(match[1]!,data.requestId as string,data.text);
      if (fresh) active.get(match[1]!)?.send({type:"steer",requestId:data.requestId,text:data.text});
      return reply(response,202,{accepted:true});
    }
    return bad(response,404,"Not found");
  })().catch(error => bad(response,400,error instanceof Error ? error.message : "Invalid request")); });
  try { await new Promise<void>((ok,fail) => { server.once("error",fail); server.listen(options.port ?? 4318,"127.0.0.1",ok); }); }
  catch (error) { ledger.close(); throw error; }
  for (const job of ledger.list()) if (job.state === "queued") schedule(job);
  return {
    url: `http://127.0.0.1:${(server.address() as {port:number}).port}`,
    tokenFile,
    async close() {
      stopping = true;
      await new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.all([...dispatches]);
      const stopped = [...active.values()].map(worker => new Promise<void>(resolve => {
        if (worker.exitCode !== null || worker.signalCode !== null) { resolve(); return; }
        worker.once("exit",() => resolve());
        worker.kill();
      }));
      await Promise.all(stopped);
      ledger.close();
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  createService({dir:process.env.KAENO_STATE_DIR ?? ".kaeno-next",mode:process.env.KAENO_OPENAI_API_KEY ? "openai":"faux"})
    .then(service => console.log(`Kaeno service: ${service.url} · token: ${service.tokenFile} · mode: ${process.env.KAENO_OPENAI_API_KEY ? "OpenAI" : "offline prototype"}`))
    .catch(error => {console.error(error);process.exitCode=1;});
}
