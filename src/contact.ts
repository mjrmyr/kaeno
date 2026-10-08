import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { Harness, createRegistry, LiveDoc, type TaskId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createJobExtension, jobCards, loadProfiles, verifyJobRuntime } from "./jobs.ts";

export type ContactState = {
  messages: { id: string | number; role: "user" | "assistant" | "job"; text: string }[];
  busy: boolean;
  jobs: Awaited<ReturnType<typeof jobCards>>;
  error?: string;
};

export async function openContact(options: {
  stateDir: string;
  apiKey?: string;
  // Injectable catalog and model allow offline tests; the interactive app always uses OpenAI.
  testing?: { models: Models; model: { provider: string; modelId: string } };
}) {
  const context = BACKGROUND_CONTEXT;
  if (!options.testing && !options.apiKey) throw new Error("Configure an OpenAI API key in the TUI first.");
  if (options.apiKey) process.env.OPENAI_API_KEY = options.apiKey;
  const catalog = createModels();
  if (!options.testing) catalog.setProvider(openaiProvider());
  const models = options.testing?.models ?? catalog;
  const model = options.testing?.model ?? { provider: "openai", modelId: "gpt-4o-mini" };
  await mkdir(resolve(options.stateDir), { recursive: true, mode: 0o700 });
  const stateDir = await realpath(resolve(options.stateDir));
  const profiles = await loadProfiles(join(stateDir, "agents"), model.modelId);
  // A loopback binding is a local single-process gate, not a cross-host store lock.
  // Unlike a PID file, it is released by the OS if the process crashes.
  const owner = createServer();
  try {
    await new Promise<void>((ok, fail) => {
      owner.once("error", fail);
      owner.listen(4317, "127.0.0.1", () => { owner.removeListener("error", fail); ok(); });
    });
  } catch (error) {
    throw new Error("Another Kaeno instance (or service on 127.0.0.1:4317) is running. Close it before opening this store.", { cause: error });
  }
  const release = () => new Promise<void>((done) => owner.close(() => done()));
  const registry = createRegistry();
  const { JobExtension, ReadExtension } = createJobExtension(profiles, model.provider, stateDir);
  registry.install(JobExtension);
  registry.install(ReadExtension);
  let harness: Harness;
  try {
    harness = await Harness.open(
      await openNodeSqliteStorage(join(stateDir, "state.sqlite")),
      { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) }, context,
    );
  } catch (error) { await release(); throw error; }
  try {
    const instructions = "You are kaeno, a helpful personal assistant. You can delegate bounded file-reading objectives to the listed specialist using delegate, then keep talking to the user while it works. Refer to saved results via job_status. Do not delegate a specialist completion notice. Be honest about tool and job failures.";
    const root = await harness.root(context, { agent: { model, instructions, extensions: [JobExtension] } });
    const savedModel = (await root.agent(context)).model;
    if (savedModel?.provider === "faux" && savedModel.modelId === "faux-1" && !options.testing) {
      // Old echo-only contact state is retained but its model is replaced explicitly.
      await root.configure({ model, extensions: [JobExtension], instructions }, context);
    } else if (savedModel?.provider !== model.provider || savedModel.modelId !== model.modelId) {
      throw new Error(`Saved contact model ${savedModel?.provider}/${savedModel?.modelId} differs from ${model.provider}/${model.modelId}; use the original model or a fresh state directory.`);
    } else {
      await root.configure({ extensions: [JobExtension], instructions }, context);
    }
    await verifyJobRuntime(harness, root.id, context);
    harness.resume();
    let lastError: string | undefined;
    let shuttingDown = false;
    return {
      async state(): Promise<ContactState> {
        const [view, live, jobs] = await Promise.all([root.context(context), harness.snapshot(LiveDoc, root.id, context), jobCards(harness, root.id, context)]);
        const messages = view.entries.flatMap((entry) => {
          const message = entry.model?.[0];
          if (message?.role !== "user" && message?.role !== "assistant") return [];
          const text = typeof message.content === "string" ? message.content
            : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
          const role: "user" | "assistant" | "job" = message.role === "user" && text.startsWith("[Specialist ") ? "job" : message.role;
          return text ? [{ id: entry.id, role, text }] : [];
        });
        return { messages, busy: live?.run !== undefined, jobs, error: lastError };
      },
      async send(text: string, requestId: string) {
        if (!text.trim() || text.length > 4000) throw new Error("Message must be 1–4000 characters.");
        const submission = await root.submit({ type: "input", content: text, requestId, whenBusy: "followUp" }, context);
        lastError = undefined;
        void submission.wait(context).then((settled) => {
          if (!shuttingDown && settled.status === "unanswered") lastError = `Contact input unanswered: ${settled.reason}`;
        }).catch((error: unknown) => {
          if (!shuttingDown) lastError = `Contact request failed (${error instanceof Error ? error.name : "error"}).`;
        });
        return submission.id;
      },
      async cancelContact() { await root.abort(context); },
      async cancelJob(id: number) {
        const cards = await jobCards(harness, root.id, context);
        if (!cards.some(card => card.id === id)) throw new Error("Unknown job ID");
        await harness.abortTask(id as TaskId, context);
      },
      async close() { shuttingDown = true; try { await harness.close(context); } finally { await release(); } },
    };
  } catch (error) {
    try { await harness.close(context); } finally { await release(); }
    throw error;
  }
}
