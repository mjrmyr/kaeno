import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";

export type Agent = { name: string; instructions: string; skills: string[]; knowledge: string[]; tools: "read"[] };
export type Assignment = { id: string; requestId: string; agent: string; revision: string; objective: string; profile: Agent; state: "queued" | "starting" | "running" | "completed" | "blocked"; result?: string; error?: string };
const decode = (row: { data: string } | undefined) => row ? JSON.parse(row.data) as Assignment : undefined;
export class Ledger {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`pragma journal_mode=WAL; create table if not exists assignments(id text primary key, request_id text not null unique, data text not null);
      create table if not exists events(seq integer primary key autoincrement, assignment_id text not null, kind text not null, detail text not null);
      create table if not exists commands(assignment_id text not null, request_id text not null, text text not null, primary key(assignment_id, request_id));`);
  }
  close() { this.db.close(); }
  get(id: string) { return decode(this.db.prepare("select data from assignments where id=?").get(id) as {data:string}|undefined); }
  byRequest(id: string) { return decode(this.db.prepare("select data from assignments where request_id=?").get(id) as {data:string}|undefined); }
  list() { return (this.db.prepare("select data from assignments order by rowid desc").all() as {data:string}[]).map(row => decode(row)!); }
  events(after: number) { return this.db.prepare("select seq,assignment_id as assignmentId,kind,detail from events where seq>? order by seq limit 100").all(after); }
  accept(requestId: string, agent: Agent, objective: string) {
    const revision = createHash("sha256").update(JSON.stringify(agent)).digest("hex");
    const prior = this.byRequest(requestId);
    if (prior) {
      if (prior.objective !== objective || prior.agent !== agent.name) throw new Error("Request ID reused with different assignment");
      return prior;
    }
    const job: Assignment = { id: randomUUID(), requestId, agent: agent.name, revision, profile: agent, objective, state: "queued" };
    // Single writer; uniqueness is enforced by SQLite even if callers overlap.
    this.db.exec("begin immediate");
    try {
      const already = this.byRequest(requestId);
      if (already) { this.db.exec("rollback"); return already; }
      this.db.prepare("insert into assignments values (?,?,?)").run(job.id, requestId, JSON.stringify(job));
      this.db.prepare("insert into events(assignment_id,kind,detail) values (?,?,?)").run(job.id, "queued", "Assignment accepted");
      this.db.exec("commit");
    } catch (error) { this.db.exec("rollback"); throw error; }
    return job;
  }
  transition(id: string, state: Assignment["state"], detail: string, result?: string) {
    this.db.exec("begin immediate");
    try {
      const job = this.get(id);
      if (!job) throw new Error("Unknown assignment");
      if (job.state === state) { this.db.exec("rollback"); return job; }
      const allowed: Record<Assignment["state"], Assignment["state"][]> = {
        queued: ["starting", "blocked"], starting: ["running", "blocked"],
        running: ["completed", "blocked"], completed: [], blocked: [],
      };
      if (!allowed[job.state].includes(state)) throw new Error(`Invalid assignment transition: ${job.state} → ${state}`);
      const next = { ...job, state, ...(result === undefined ? {} : { result }), ...(state === "blocked" ? { error: detail } : {}) };
      this.db.prepare("update assignments set data=? where id=?").run(JSON.stringify(next), id);
      this.db.prepare("insert into events(assignment_id,kind,detail) values (?,?,?)").run(id, state, detail);
      this.db.exec("commit");
      return next;
    } catch (error) { this.db.exec("rollback"); throw error; }
  }
  command(id: string, requestId: string, text: string) {
    const old = this.db.prepare("select text from commands where assignment_id=? and request_id=?").get(id, requestId) as {text:string}|undefined;
    if (old) { if (old.text !== text) throw new Error("Request ID reused with different steering"); return false; }
    const job = this.get(id);
    if (!job || job.state !== "running") throw new Error("Assignment is not running");
    this.db.exec("begin immediate");
    try {
      this.db.prepare("insert into commands values (?,?,?)").run(id, requestId, text);
      this.db.prepare("insert into events(assignment_id,kind,detail) values (?,?,?)").run(id, "steer", text);
      this.db.exec("commit");
    } catch (error) { this.db.exec("rollback"); throw error; }
    return true;
  }
  commands(id: string) { return this.db.prepare("select request_id as requestId,text from commands where assignment_id=? order by rowid").all(id) as {requestId:string;text:string}[]; }
}
