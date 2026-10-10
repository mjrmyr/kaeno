import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const base = process.env.KAENO_URL ?? "http://127.0.0.1:4318";
const token = process.env.KAENO_TOKEN ?? (await readFile(resolve(process.env.KAENO_STATE_DIR ?? ".kaeno-next", "token"),"utf8")).trim();
async function request(path: string, data?: object) {
  const response = await fetch(new URL(path,base),{
    method: data ? "POST" : "GET",headers:{Authorization:`Bearer ${token}`,"content-type":"application/json"},
    body:data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
const [command,...args] = process.argv.slice(2);
try {
  if (command === "agents") console.log(await request("/api/agents"));
  else if (command === "list") console.log(await request("/api/assignments"));
  else if (command === "assign" && args.length > 1) console.log(await request("/api/assignments",{requestId:randomUUID(),agent:args[0],objective:args.slice(1).join(" ")}));
  else if (command === "steer" && args.length > 1) console.log(await request(`/api/assignments/${encodeURIComponent(args[0]!)}/steer`,{requestId:randomUUID(),text:args.slice(1).join(" ")}));
  else if (command === "watch" && args.length === 1) {
    let after=0;
    console.log("Watching assignment; Ctrl+C detaches without stopping the worker.");
    while (true) {
      for (const event of await request(`/api/events?after=${after}`) as {seq:number;assignmentId:string;kind:string;detail:string}[]) {
        after=event.seq;
        if (event.assignmentId===args[0]) console.log(`[${event.kind}] ${event.detail}`);
      }
      const job = await request(`/api/assignments/${encodeURIComponent(args[0]!)}`) as {state:string;result?:string;error?:string};
      if (job.state === "completed" || job.state === "blocked") {console.log(job.result ?? job.error ?? job.state);break;}
      await new Promise(done=>setTimeout(done,800));
    }
  } else throw new Error("Usage: npm run client -- agents | list | assign AGENT TEXT | steer ID TEXT | watch ID");
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode=1; }
