import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import {
  AssistantEntry, configure, defineDoc, defineExtension, defineTask, defineTool,
  type ConversationId, type Harness, type TaskId,
} from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";

const REVISION = "kaeno-job-v2-scoped-list-v1";
const LIMIT = 1000;
type Profile = {
  name: string; description: string; instructions: string; workspace: string;
  modelId: string; tools: "read"[]; revision: string; runtimeRevision: string;
};
type Result = { type: "completed" | "failed" | "cancelled" | "outcome_unknown"; text: string };
type JobRecord = { id: number; taskId: number; childId: number; agent: string; objective: string;
  result?: Result; notice?: { status: "attempted" | "deferred"; submissionId?: number } };
type State = { origins: Record<string, { digest: string; id: number }>; jobs: Record<string, JobRecord> };
export const Jobs = defineDoc<State>({ kind: "kaeno.jobs", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ origins: {}, jobs: {} }) });

export async function loadProfiles(dir: string, modelId: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const starter = join(dir, "reader.json");
  try {
    await writeFile(starter, JSON.stringify({
      name: "reader", description: "List and read files in an approved workspace", modelId,
      workspace: process.cwd(), tools: ["read"],
      instructions: "You are a read-only specialist. Use list to discover files under your approved workspace, then read specific files. Relative paths start in that workspace. If a path is refused, report the workspace limit; do not guess. Cite the paths you read. Do not claim to have edited files."
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const profiles = new Map<string, Profile>();
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".json")) continue;
    const raw: unknown = JSON.parse(await readFile(join(dir, file), "utf8"));
    if (!raw || typeof raw !== "object") throw new Error(`Invalid agent file: ${file}`);
    const value = raw as Record<string, unknown>;
    const { name, description, instructions, workspace, tools } = value;
    if (typeof name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(name) ||
      typeof description !== "string" || !description.trim() || description.length > 300 ||
      typeof instructions !== "string" || !instructions.trim() || instructions.length > 4000 ||
      typeof workspace !== "string" || !isAbsolute(workspace) ||
      !Array.isArray(tools) || tools.some((tool) => tool !== "read") ||
      value.modelId !== modelId || profiles.has(name)) {
      throw new Error(`Invalid or incompatible agent file: ${file} (model must be ${modelId}, tools only read)`);
    }
    const resolved = await realpath(workspace);
    const effective = { name, description, instructions, workspace: resolved, modelId, tools: tools as "read"[] };
    profiles.set(name, { ...effective, revision: createHash("sha256").update(JSON.stringify(effective)).digest("hex"), runtimeRevision: REVISION });
  }
  return profiles;
}

const Worker = defineTask<{
  agent: string; objective: string; brief: string; profile: Profile;
}, { phase: "start" } | { phase: "wait" } | { phase: "report" }, null>({
  name: "kaeno.job", version: 1, initial: () => ({ phase: "start" }),
  phases: {
    start: async (task, runtime, context) => {
      const state = await runtime.snapshot(Jobs, runtime.conversationId, context);
      const record = state?.jobs[task.id];
      if (!record || task.input.profile.runtimeRevision !== REVISION) throw new Error("Cannot resume job with missing record or incompatible runtime");
      try {
        const child = await runtime.conversation(record.childId as ConversationId, context);
        if (!child) throw new Error("Missing job child conversation");
        await child.submit({ type: "input", content: `Objective: ${task.input.objective}\nBrief: ${task.input.brief}`, requestId: `kaeno:work:${task.id}` }, context);
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait" } }), context);
      } catch (error) {
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(Jobs, runtime.conversationId);
          doc.jobs[task.id]!.result = { type: "failed", text: `Could not start child work (${error instanceof Error ? error.name : "error"}).` };
          return { status: "running", checkpoint: { phase: "report" } };
        }, context);
      }
    },
    wait: async (task, runtime, context) => {
      const state = await runtime.snapshot(Jobs, runtime.conversationId, context);
      const record = state?.jobs[task.id];
      if (!record) throw new Error("Missing job record");
      const child = await runtime.conversation(record.childId as ConversationId, context);
      if (!child) throw new Error("Missing job child conversation");
      const submission = await child.submit({ type: "input", content: `Objective: ${task.input.objective}\nBrief: ${task.input.brief}`, requestId: `kaeno:work:${task.id}` }, context);
      const settled = await submission.wait(context);
      await runtime.commit(async (tx) => {
        const answer = settled.status === "done" && settled.type === "input"
          ? await tx.entry(AssistantEntry, settled.answer) : undefined;
        const content = answer?.model?.[0]?.content;
        const text = typeof content === "string" ? content : content?.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? "";
        const doc = await tx.doc(Jobs, runtime.conversationId);
        doc.jobs[task.id]!.result = text
          ? { type: "completed", text: text.slice(0, 12000) }
          : { type: "failed", text: settled.status === "unanswered" ? `Child unanswered: ${settled.reason}` : "Child returned no text" };
        return { status: "running", checkpoint: { phase: "report" } };
      }, context);
    },
    report: async (task, runtime, context) => {
      const state = await runtime.snapshot(Jobs, runtime.conversationId, context);
      const result = state?.jobs[task.id]?.result;
      if (!result) throw new Error("Missing result card");
      let notice: JobRecord["notice"];
      try {
        const root = await runtime.conversation(runtime.conversationId, context);
        if (!root) throw new Error("Missing contact");
        const content = `[Specialist ${task.input.agent}, job ${task.id}: ${result.type}. Saved result follows; tell the user briefly if relevant. Do not delegate this notification.]\n${result.text}`;
        const submission = await root.submit({ type: "input", content, requestId: `kaeno:notice:${task.id}`, whenBusy: "followUp" }, context);
        const status = await submission.status(context);
        notice = status.status === "unanswered" ? { status: "deferred" } : { status: "attempted", submissionId: submission.id };
      } catch { notice = { status: "deferred" }; }
      await runtime.commit(async (tx) => {
        (await tx.doc(Jobs, runtime.conversationId)).jobs[task.id]!.notice = notice;
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
    },
  },
  abort: async (task, runtime, context) => {
    await runtime.commit(async (tx) => {
      const record = (await tx.doc(Jobs, runtime.conversationId)).jobs[task.id];
      if (record) {
        record.result ??= { type: task.state.checkpoint.phase === "start" ? "cancelled" : "outcome_unknown", text: "Job stopped; external effects cannot be ruled out." };
        record.notice ??= { status: "deferred" };
      }
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  },
});

export function createJobExtension(profiles: Map<string, Profile>, provider: string, stateDir: string) {
  const delegate = defineTool({
    name: "delegate", description: `Start a read-only specialist background job. Available agents and approved workspaces: ${[...profiles.values()].map(p => `${p.name} (${p.description}; workspace ${p.workspace})`).join(", ")}. A requested path outside an agent's workspace requires updating its trusted profile and restarting Kaeno; do not imply the worker can read it. Return the job ID without waiting; you may answer other user requests while it runs.`,
    parameters: Type.Object({ agent: Type.String(), objective: Type.String(), brief: Type.String() }), replay: "safe",
    execute: async (args, api, context) => {
      const digest = createHash("sha256").update(JSON.stringify(args)).digest("hex");
      const receipt = await api.commit(async (tx) => {
        const state = await tx.doc(Jobs, api.conversationId);
        const prior = state.origins[api.taskId];
        if (prior) {
          if (prior.digest !== digest) throw new Error("Changed delegation arguments for same tool task");
          return prior.id;
        }
        // Replay lookup precedes profile resolution: the template may have changed or disappeared.
        const profile = profiles.get(args.agent);
        if (!profile || !args.objective.trim() || args.objective.length > 2000 || args.brief.length > 4000)
          throw new Error("Invalid agent, objective or brief");
        const all = Object.values(state.jobs);
        if (all.length >= LIMIT) throw new Error("Retained job limit reached; no cards evicted");
        let active = 0, same = 0;
        // All native reads must precede task/conversation creation.
        for (const record of all) {
          const task = await tx.task(record.taskId as TaskId);
          if (task?.state.status !== "terminal") {
            active++; if (record.agent === profile.name) same++;
          }
        }
        if (active >= 4 || same >= 2) throw new Error("Specialist capacity reached");
        const id = await tx.createTask(Worker, { agent: profile.name, objective: args.objective, brief: args.brief, profile },
          { ownership: { kind: "conversation" }, background: true });
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: id } });
        await configure(tx, child.id, {
          model: { provider, modelId: profile.modelId }, cwd: profile.workspace,
          extensions: { remove: [JobExtension], add: [ReadExtension] },
          tools: profile.tools.length ? [read, list] : [],
          instructions: `${profile.instructions}\nApproved workspace: ${profile.workspace}. Relative paths start there; use list to discover files in a directory, then read individual files. A requested path outside this workspace cannot be accessed; report the restriction rather than guessing.`,
        });
        state.jobs[id] = { id, taskId: id, childId: child.id, agent: profile.name, objective: args.objective };
        state.origins[api.taskId] = { digest, id };
        return id;
      }, context);
      return { content: [{ type: "text" as const, text: `Job ${receipt} started. Continue the conversation; the result will be saved and reported when ready.` }] };
    },
  });
  const status = defineTool({
    name: "job_status", description: "Inspect stored specialist jobs and saved result cards; no new job is created.",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }), replay: "safe",
    execute: async (args, api, context) => {
      const jobs = (await api.snapshot(Jobs, api.conversationId, context))?.jobs ?? {};
      const selected = args.id ? [jobs[args.id]].filter((record): record is JobRecord => !!record) : Object.values(jobs).slice(-20);
      return { content: [{ type: "text" as const, text: selected.length ? selected.map(j => `${j.id} (${j.agent}): ${j.objective}\n${j.result ? `${j.result.type}: ${j.result.text}` : "running"}`).join("\n\n") : "No matching jobs." }] };
    },
  });
  const within = (path: string, directory: string) => path === directory || path.startsWith(directory + sep);
  async function approved(cwd: string | undefined, path: string): Promise<{ file: string } | { error: string }> {
    let workspace: string;
    try { workspace = cwd ? await realpath(cwd) : ""; }
    catch { return { error: "Reader workspace is no longer accessible; check its profile and restart Kaeno." }; }
    if (!workspace || ![...profiles.values()].some(profile => profile.workspace === workspace))
      return { error: "Reader has no approved workspace; check its profile and restart Kaeno." };
    if (!path || path.length > 4096) return { error: "Provide a path of at most 4096 characters." };
    const requested = path === "~" ? homedir() : path.startsWith("~/")
      ? resolve(homedir(), path.slice(2)) : resolve(workspace, path);
    const outside = `Path is outside the reader workspace (${workspace}). To read it, change .kaeno/agents/reader.json workspace to an approved absolute directory and restart Kaeno.`;
    if (!within(requested, workspace)) return { error: outside };
    let file: string;
    try { file = await realpath(requested); }
    catch { return { error: `Path not found: ${requested}. Relative paths start in ${workspace}; use list to discover filenames.` }; }
    if (within(file, stateDir)) return { error: "Private Kaeno state cannot be read or listed." };
    if (!within(file, workspace)) return { error: outside }; // Symlinks cannot escape the workspace.
    return { file };
  }
  const refused = (error: string) => ({ content: [{ type: "text" as const, text: error }], isError: true });
  const baseRead = createReadTool();
  const read = defineTool({
    ...baseRead,
    description: `${baseRead.description} Only files inside the configured reader workspace are allowed. Use list for directories. Paths beginning ~/ refer to the user's home directory, but still require workspace approval.`,
    execute: async (args, api, context) => {
      const target = await approved((await api.agent(context)).cwd, args.path);
      if ("error" in target) return refused(target.error);
      if ((await stat(target.file)).isDirectory()) return refused(`Path is a directory: ${target.file}. Use list to discover its files, then read a file.`);
      return baseRead.execute({ ...args, path: target.file }, api, context);
    },
  });
  const list = defineTool({
    name: "list", description: "List filenames in a directory inside the reader workspace. Use this before reading files when given a folder. Paths beginning ~/ expand to your home directory but remain subject to workspace approval. Up to 100 names per call; use offset for more.",
    parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()) }), replay: "safe",
    execute: async (args, api, context) => {
      const target = await approved((await api.agent(context)).cwd, args.path);
      if ("error" in target) return refused(target.error);
      if (!(await stat(target.file)).isDirectory()) return refused(`Not a directory: ${target.file}. Use read for a file.`);
      const offset = args.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) return refused("Offset must be a non-negative integer.");
      const entries = (await readdir(target.file, { withFileTypes: true }))
        .filter(entry => resolve(target.file, entry.name) !== stateDir)
        .sort((a, b) => a.name.localeCompare(b.name));
      const visible = entries.slice(offset, offset + 100).map(entry => `${entry.name}${entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : ""}`);
      const next = offset + visible.length < entries.length ? `\nMore entries: use offset=${offset + visible.length}.` : "";
      return { content: [{ type: "text" as const, text: `${target.file}: ${entries.length} entries\n${visible.join("\n")}${next}` }] };
    },
  });
  const ReadExtension = defineExtension({ name: "kaeno.read", tools: [read, list] });
  const JobExtension = defineExtension({ name: "kaeno.jobs", tasks: [Worker], tools: [delegate, status] });
  return { JobExtension, ReadExtension };
}

export async function verifyJobRuntime(harness: Harness, rootId: ConversationId, context: Context) {
  const state = await harness.snapshot(Jobs, rootId, context);
  for (const job of Object.values(state?.jobs ?? {})) {
    const native = await harness.getTask(job.taskId as TaskId, context);
    if (native?.state.status === "terminal") continue;
    const input = native?.input;
    const profile = input && typeof input === "object" && !Array.isArray(input) ? input.profile : undefined;
    if (!profile || typeof profile !== "object" || Array.isArray(profile) || profile.runtimeRevision !== REVISION)
      throw new Error(`Job #${job.id} cannot resume: installed job runtime differs from pinned revision`);
  }
}

export async function jobCards(harness: Harness, rootId: ConversationId, context: Context) {
  const state = await harness.snapshot(Jobs, rootId, context);
  return Promise.all(Object.values(state?.jobs ?? {}).map(async (record) => {
    const native = await harness.getTask(record.taskId as TaskId, context);
    const notice = record.notice?.submissionId !== undefined
      ? await (await harness.submission(record.notice.submissionId as import("@earendil-works/pi-durable").SubmissionId, context))?.status(context)
      : undefined;
    return {
      ...record,
      result: record.result ?? (native?.state.status === "terminal"
        ? { type: "outcome_unknown" as const, text: "Native job ended without a saved result card." } : undefined),
      notice: notice?.status === "unanswered" ? { status: "deferred" as const } : record.notice,
      nativeStatus: native?.state.status ?? "missing",
    };
  }));
}
