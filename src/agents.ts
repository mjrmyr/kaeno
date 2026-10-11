// Agents: templates → pi-durable agents, the `delegate` tool (sub-agent per task), and sandbox pods as the
// execution environment of sandboxed conversations.
import { createHash, randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, type Usage } from "@earendil-works/pi-ai";
import {
  AssistantEntry, configure, defineDoc, defineExtension, defineTool, section, UsageDoc,
  type AgentChange, type ConversationId, type EnvTarget, type Harness, type TaskId, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Config, Template } from "./config.ts";
import * as k8s from "./k8s.ts";
import { RemoteExecutionEnv } from "./remote-env.ts";
import { readSkillDocument, skillPrompt, type SkillBinding, type SkillCatalog, type SandboxImages } from "./skills.ts";

/** Which template a conversation runs, and its sandbox pod if it has one. */
export const AgentState = defineDoc<{ template?: string; skills?: SkillBinding; sandbox?: { pod: string; token: string; images?: SandboxImages; skillCacheClaim?: string } }>({
  kind: "kaeno.agent", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({}),
});

export const textOf = (message: any): string =>
  (message?.content ?? []).flatMap((c: any) => (c.type === "text" ? [c.text] : [])).join("").trim();

const sumUsage = (models: Record<string, any>): Usage => {
  const u: any = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (const m of Object.values(models)) {
    for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) u[k] += m[k] ?? 0;
    for (const k of Object.keys(u.cost)) u.cost[k] += m.cost?.[k] ?? 0;
  }
  return u;
};

export const podName = (conversationId: ConversationId) => `kaeno-sb-${createHash("sha256").update(String(conversationId)).digest("hex").slice(0, 12)}`;

export type AgentsDeps = { config: Config; images: SandboxImages; skillCacheClaim: string; skills: SkillCatalog; harness: () => Harness; sandboxUrl?: (pod: string) => string; sandboxCwd?: string };

export function createAgents({ config, images, skillCacheClaim, skills, harness, sandboxCwd = "/workspace", sandboxUrl = pod => `http://${pod}.kaeno-sandbox.${k8s.namespace}.svc.cluster.local:7070` }: AgentsDeps) {
  const coding = new Map(CodingTools.tools!.map(t => [t.name, t as ToolRegistration]));
  const envs = new Map<string, RemoteExecutionEnv>();
  // While the process shuts down, running delegations are paused, not over: they keep their sandbox and are resumed
  // (replay-safe) by the next process. Only a delegation that really ended deletes its sandbox.
  let closing = false;

  const describe = (t: Template) => `- ${t.name}: ${t.description}${t.sandbox ? " (own isolated container with internet access and git over SSH to GitHub)" : ""}` +
    skills.bind(t.skills).filter(s => !s.disableModelInvocation).map(s => `\n  skill ${s.id}: ${s.description}`).join("");
  const instructions = (t: Template) => t.delegates.length === 0 ? t.instructions
    : `${t.instructions}\n\nYou can delegate work with the \`delegate\` tool to these agent templates:\n${t.delegates.map(d => describe(config.templates[d]!)).join("\n")}\n` +
      "Each delegation starts a fresh sub-agent that sees only the task you write, so make it complete and self-contained. " +
      "Independent tasks can be delegated in parallel by calling the tool several times in one turn.";

  /** What a conversation created from `template` runs with. Re-applied to user threads on every start. */
  const agentChange = (t: Template): AgentChange => ({
    model: t.model,
    thinkingLevel: t.thinkingLevel ?? null,
    extensions: [CodingTools, Kaeno],
    tools: [...t.tools.map(n => coding.get(n)!), ...(t.skills.length ? [readSkill] : []), ...(t.delegates.length ? [delegate] : [])],
    instructions: instructions(t),
    cwd: t.sandbox ? sandboxCwd : null,
  });

  async function waitForSandbox(name: string, context: Context) {
    for (let i = 0; i < 240; i++) {
      if (context.abortSignal?.aborted) throw new Error("aborted");
      const pod = await k8s.getPod(name);
      if (k8s.isReady(pod)) return;
      const failed = k8s.failedReason(pod);
      if (failed) throw new Error(`Sandbox ${name} failed to start: ${failed}`);
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`Sandbox ${name} not ready after 4 minutes`);
  }

  const delegate = defineTool({
    name: "delegate",
    description: "Delegate a self-contained task to a new sub-agent created from an agent template and get its final report back. " +
      "Sandboxed templates get their own isolated container, which is deleted when the task ends.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent template to use" }),
      task: Type.String({ description: "Complete, self-contained instructions; the sub-agent sees nothing else" }),
    }),
    // A rerun after a crash finds the child conversation, its pod and its submission instead of starting over.
    replay: "safe",
    execute: async ({ agent, task }, api, context) => {
      const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
      const caller = config.templates[(await api.snapshot(AgentState, api.conversationId, context))?.template ?? config.agent];
      if (!caller?.delegates.includes(agent)) return fail(`Unknown agent template "${agent}". Available: ${caller?.delegates.join(", ") || "none"}`);
      const template = config.templates[agent]!;

      const child = await api.commit(async tx => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing) {
          const state = await tx.doc(AgentState, existing.id);
          return { id: existing.id, sandbox: state.sandbox ? { ...state.sandbox, images: state.sandbox.images ? { ...state.sandbox.images } : undefined } : undefined,
            selection: (state.skills ?? []).map(s => ({ id: s.id, treeHash: s.treeHash })) };
        }
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        await configure(tx, created.id, agentChange(template));
        const state = await tx.doc(AgentState, created.id);
        state.template = agent;
        state.skills = skills.bind(template.skills);
        if (template.sandbox) state.sandbox = { pod: podName(created.id), token: randomBytes(24).toString("hex"), images: { execution: images.execution }, skillCacheClaim };
        return { id: created.id, sandbox: state.sandbox ? { ...state.sandbox, images: { execution: images.execution } } : undefined,
          selection: state.skills.map(s => ({ id: s.id, treeHash: s.treeHash })) };
      }, context);
      const details = { conversationId: child.id, agent, ...(child.sandbox ? { pod: child.sandbox.pod } : {}) };
      await api.details(details, context); // lets UIs attach to the sub-agent's conversation

      try {
        if (child.sandbox) {
          if (!child.sandbox.images) {
            // Legacy child has no skills. Adopt a surviving old image, otherwise use the new bundle-free runtime.
            const existing = await k8s.getPod(child.sandbox.pod);
            child.sandbox.images = { execution: existing?.spec?.containers?.[0]?.image ?? images.execution };
            await api.commit(async tx => { (await tx.doc(AgentState, child.id)).sandbox!.images = child.sandbox!.images!; }, context);
          }
          await k8s.createPod(k8s.sandboxPod({
            name: child.sandbox.pod, images: child.sandbox.images, skillCacheClaim: child.sandbox.skillCacheClaim ?? skillCacheClaim,
            skills: child.selection, token: child.sandbox.token,
            conversationId: String(child.id), taskId: String(api.taskId), template: agent,
          }));
          await waitForSandbox(child.sandbox.pod, context);
        }
        const handle = (await api.conversation(child.id, context))!;
        const submission = await handle.submit({ type: "input", content: task, requestId: `delegate:${api.taskId}` }, context);
        const settled = await submission.wait(context);
        const usage = sumUsage((await api.snapshot(UsageDoc, child.id, context))?.models ?? {});
        if (settled.status !== "done" || settled.type !== "input") return { ...fail(`Sub-agent ${agent} did not finish: ${settled.reason}`), details, usage };
        const answer = await api.commit(tx => tx.entry(AssistantEntry, settled.answer), context);
        return { content: [{ type: "text" as const, text: textOf(answer?.model?.[0]) || "(empty answer)" }], details, usage };
      } catch (error) {
        if (closing) throw error; // interrupted by shutdown: no result, so the next process replays this call
        return { ...fail(`Sub-agent ${agent} failed: ${error instanceof Error ? error.message : String(error)}`), details };
      } finally {
        if (child.sandbox && !closing) await removeSandbox(child.sandbox.pod);
      }
    },
  });

  const readSkill = defineTool({
    name: "read_skill", description: "Load instructions or a referenced text file from a skill assigned to this agent. Does not grant new tools.",
    parameters: Type.Object({ skill: Type.String({ description: "Qualified owner/repo:skill-name" }), file: Type.Optional(Type.String({ description: "Relative text file, defaults to SKILL.md" })) }),
    replay: "safe",
    execute: async (args, api, context) => {
      const binding = (await api.snapshot(AgentState, api.conversationId, context))?.skills ?? [];
      const loaded = readSkillDocument(binding, args);
      return { content: [{ type: "text", text: `Skill directory: ${loaded.sandboxRoot}\n\n${loaded.text}` }] };
    },
  });
  const Kaeno = defineExtension({
    name: "kaeno", tools: [delegate, readSkill],
    sections: [section("skills", async ({ conversationId, read }, context) =>
      skillPrompt((await read.snapshot(AgentState, conversationId, context))?.skills ?? []))],
  });

  async function removeSandbox(pod: string) {
    const env = envs.get(pod);
    envs.delete(pod);
    await env?.cleanup(BACKGROUND_CONTEXT).catch(() => {});
    await k8s.deletePod(pod).catch(() => {});
  }

  /** pi-durable's env hook: sandboxed conversations run every file and shell operation in their pod. */
  async function env({ conversationId, read }: EnvTarget, context: Context): Promise<ExecutionEnv | undefined> {
    const sandbox = (await read.snapshot(AgentState, conversationId, context))?.sandbox;
    if (!sandbox) return undefined;
    let remote = envs.get(sandbox.pod);
    if (!remote) {
      remote = new RemoteExecutionEnv({
        url: sandboxUrl(sandbox.pod),
        token: sandbox.token, id: `pod:${sandbox.pod}`, cwd: sandboxCwd,
      });
      envs.set(sandbox.pod, remote);
    }
    return remote;
  }

  /** Delete sandbox pods whose owning delegate call is over (a crash can skip the tool's own cleanup). */
  async function sweep() {
    for (const pod of await k8s.listSandboxPods()) {
      const annotated = pod.metadata?.annotations?.["kaeno.io/task"];
      const taskId = annotated !== undefined && /^\d+$/.test(annotated) ? Number(annotated) as TaskId : undefined;
      const task = taskId ? await harness().getTask(taskId, BACKGROUND_CONTEXT) : undefined;
      if (!task || task.state.status === "terminal") {
        console.log(`sweeper: removing ${pod.metadata.name} (owner ${taskId ?? "?"} ${task?.state.status ?? "missing"})`);
        await removeSandbox(pod.metadata.name);
      }
    }
  }

  return { Kaeno, agentChange, bindSkills: (t: Template) => skills.bind(t.skills), env, sweep, shutdown: () => { closing = true; } };
}

export type { ConversationId };
