import { afterEach, expect, it, vi } from "vitest";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Draft } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import { AgentDoc, configure, createRegistry, defineTask, Harness, MemoryStorage, type Tx } from "@earendil-works/pi-durable";
import { AgentFactory, type AgentSelection } from "../src/agent-factory.ts";
import { AgentState, createAgents } from "../src/agents.ts";
import { parseConfig } from "../src/config.ts";
import { thread } from "../src/threads.ts";
import { frozenEntry, readBlueprint, sealBlueprint, workRoot, type WorkBlueprint } from "../src/work-blueprint.ts";
import type { BoundSkill } from "../src/skills.ts";

const opened: Harness[] = [];
afterEach(async () => { for (const h of opened.splice(0)) await h.close(ctx); vi.restoreAllMocks(); });
const binding: BoundSkill[] = [{ id: "demo/skills:guide", description: "Frozen guide", disableModelInvocation: false,
  repositoryCommit: "a".repeat(40), treeHash: "b".repeat(64), sandboxRoot: "/workspace/.agents/skills/demo/skills/guide", documents: { "SKILL.md": "FROZEN CONTENT" } }];
function setup() {
  const config = parseConfig({ agent: "chat", skillRepositories: ["demo/skills"], templates: {
    chat: { description: "primary", model: "anthropic/chat", instructions: "CHAT PROFILE", delegates: ["swe", "leaf"] },
    swe: { description: "engineer", model: "openai/swe", instructions: "SWE PROFILE", thinkingLevel: "high",
      sandbox: true, tools: ["bash", "read", "write", "edit"], delegates: ["swe", "leaf"], skills: ["demo/skills:guide"] },
    leaf: { description: "reasoning", model: "openai/leaf", instructions: "LEAF PROFILE" },
  } });
  const catalog = { bind: vi.fn((ids: readonly string[]) => ids.length ? structuredClone(binding) : []) };
  const workTools = ["start_work", "list_work", "cancel_work"].map(name => ({ name }));
  const work = { extension: { name: "work", tools: workTools }, tools: workTools } as any;
  const factory = new AgentFactory({ config, skills: catalog, work, sandboxCwd: "/custom-workspace" });
  const agents = createAgents({ factory, harness: () => { throw new Error("unexpected harness access"); },
    images: { execution: "frozen-image" }, skillCacheClaim: "frozen-cache" });
  return { config, catalog, work, factory, agents };
}
async function open() {
  const h = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
  opened.push(h); return h;
}

const matrix: { role: AgentSelection["role"]; agent: string; tools: string[]; cwd?: string }[] = [
  { role: "chat", agent: "chat", tools: ["start_work", "list_work", "cancel_work"] },
  { role: "work", agent: "chat", tools: ["delegate"] },
  { role: "work", agent: "swe", tools: ["read_skill", "delegate"] },
  { role: "work", agent: "leaf", tools: [] },
  { role: "worker", agent: "chat", tools: [] },
  { role: "worker", agent: "swe", tools: ["bash", "read", "write", "edit", "read_skill"], cwd: "/custom-workspace" },
  { role: "worker", agent: "leaf", tools: [] },
  { role: "legacy", agent: "chat", tools: ["delegate"] },
  { role: "legacy", agent: "swe", tools: ["bash", "read", "write", "edit", "read_skill", "delegate"], cwd: "/custom-workspace" },
  { role: "legacy", agent: "leaf", tools: [] },
];
it.each(matrix)("configures exact $role/$agent policy, order, profile and explicit clearing", async ({ role, agent, tools, cwd }) => {
  const { config, factory, agents } = setup(), h = await open();
  const blueprint = agents.captureWork(agent);
  const selection: AgentSelection = role === "chat" ? { role } : role === "work" ? { role, blueprint } : { role, agent };
  const id = await h.commit(async tx => {
    const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, c.id, { tools: agents.Kaeno.tools!, extensions: [{ name: "inherited" }], cwd: "/inherited", thinkingLevel: "xhigh" });
    const bound = await factory.configure(tx, c.id, selection, agents.Kaeno);
    expect(bound.template).toEqual(config.templates[agent]);
    expect(bound.skills).toEqual(agent === "swe" ? binding : []);
    return c.id;
  }, ctx);
  const stored = (await h.snapshot(AgentDoc, id, ctx))!;
  expect(stored.model).toEqual(config.templates[agent]!.model);
  expect(stored.tools).toEqual(tools);
  expect(stored.extensions).toEqual(["coding-tools", "kaeno", "work"]);
  expect(stored.cwd).toBe(cwd);
  expect(stored.thinkingLevel).toBe(agent === "swe" ? "high" : undefined);
  expect(stored.instructions).toContain(config.templates[agent]!.instructions);
  expect(stored.instructions?.includes("Kaeno CHAT")).toBe(role === "chat");
  expect(stored.instructions?.includes("Kaeno WORK")).toBe(role === "work");
  expect(stored.instructions?.includes("Foreground delegate targets")).toBe((role === "work" || role === "legacy") && agent !== "leaf");
});

it("uses frozen root, worker and delegate descriptions without touching live config/catalog", async () => {
  const { config, catalog, factory, agents } = setup(), blueprint = agents.captureWork("swe"), h = await open();
  const root = blueprint.templates.swe!;
  expect(root.template).not.toBe(config.templates.swe);
  expect(root.template.delegates).toEqual(["swe", "leaf"]); // capture terminates self-cycle
  config.templates = {};
  catalog.bind.mockImplementation(() => { throw new Error("LIVE CATALOG FORBIDDEN"); });
  expect(factory.bind("swe", blueprint)).toEqual(root);
  await h.commit(async tx => {
    const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
    expect(await factory.configure(tx, c.id, { role: "work", blueprint }, agents.Kaeno)).toEqual(root);
    expect((await tx.doc(AgentDoc, c.id)).instructions).toContain("skill demo/skills:guide: Frozen guide");
    expect(await factory.configure(tx, c.id, { role: "worker", agent: "swe", blueprint }, agents.Kaeno)).toEqual(root);
  }, ctx);
  const damaged = editable(blueprint);
  delete damaged.templates.swe;
  expect(() => factory.bind("swe", reseal(damaged))).toThrow(/Missing frozen/);
  expect(() => factory.bind("leaf", null as unknown as WorkBlueprint)).toThrow(/supported frozen policy/);
});

it("reports unknown live templates, missing frozen entries, and unavailable CHAT tools", async () => {
  const { config, catalog, factory, agents } = setup(), h = await open();
  for (const name of ["missing", "toString", "__proto__"]) expect(() => factory.bind(name)).toThrow(/Unknown agent/);
  expect(catalog.bind).not.toHaveBeenCalled();
  const blueprint = agents.captureWork("leaf");
  expect(() => factory.bind("swe", blueprint)).toThrow(/Missing frozen/);
  const noWork = new AgentFactory({ config, skills: catalog });
  await expect(h.commit(async tx => {
    const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
    return noWork.configure(tx, c.id, { role: "chat" }, agents.Kaeno);
  }, ctx)).rejects.toThrow(/requires WORK tools/);
});

const editable = (blueprint: WorkBlueprint): Draft<WorkBlueprint> => JSON.parse(JSON.stringify(blueprint));
const reseal = (blueprint: WorkBlueprint) => {
  const { digest: _, ...content } = blueprint;
  return sealBlueprint(content);
};
const malformed: { name: string; mutate: (entry: Draft<WorkBlueprint>["templates"][string]) => void }[] = [
  { name: "identity", mutate: e => { e.template.name = "other"; } },
  { name: "tools without sandbox", mutate: e => { e.template.sandbox = false; } },
  { name: "unknown coding tool", mutate: e => { (e.template.tools as string[]).push("network"); } },
  { name: "model representation", mutate: e => { e.template.model.modelId = 42 as any; } },
  { name: "description representation", mutate: e => { e.template.description = null as any; } },
  { name: "thinking representation", mutate: e => { e.template.thinkingLevel = "invalid" as any; } },
  { name: "delegates representation", mutate: e => { e.template.delegates = [42] as any; } },
  { name: "skills representation", mutate: e => { e.skills = ["unbound"] as any; } },
  { name: "skill document representation", mutate: e => { e.skills[0]!.documents["SKILL.md"] = 42 as any; } },
];
it.each(malformed)("rejects malformed frozen root/delegate $name at every selected-entry boundary", async ({ mutate }) => {
  const { factory, agents } = setup(), raw = editable(agents.captureWork("swe"));
  mutate(raw.templates.swe!);
  const blueprint = reseal(raw); // Exercise representation guards separately from checksum guards.
  expect(() => workRoot(blueprint)).toThrow(/Invalid frozen/);
  expect(() => factory.bind("swe", blueprint)).toThrow(/Invalid frozen/);
  const outerRaw = editable(agents.captureWork("chat"));
  mutate(outerRaw.templates.swe!);
  const outer = reseal(outerRaw);
  expect(() => workRoot(outer)).not.toThrow(); // representation validation is still selected-entry only
  expect(() => frozenEntry(outer, "swe")).toThrow(/Invalid frozen/);
  const h = await open();
  await expect(h.commit(async tx => {
    const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
    return factory.configure(tx, c.id, { role: "worker", agent: "swe", blueprint: outer }, agents.Kaeno);
  }, ctx)).rejects.toThrow(/Invalid frozen/); // selected worker uses the same guard
  const delegate = agents.Kaeno.tools!.find(t => t.name === "delegate")!;
  const commit = vi.fn(() => { throw new Error("child adoption must not happen"); });
  await expect(delegate.execute({ agent: "swe", task: "execute" }, {
    conversationId: 1, snapshot: async () => ({ role: "work", blueprint: outer }), commit,
  } as any, ctx)).rejects.toThrow(/Invalid frozen/);
  expect(commit).not.toHaveBeenCalled();
});

it("clears task-child inherited capabilities and persists the exact WORK and CHAT binding once", async () => {
  const { factory, agents, catalog } = setup(), h = await open();
  const Task = defineTask({ name: "test.owner", version: 1, initial: () => ({ phase: "hold" }), phases: { hold: async () => {} }, abort: async () => {} });
  const blueprint: WorkBlueprint = JSON.parse(JSON.stringify(agents.captureWork("swe")));
  const { child, work } = await h.commit(async tx => {
    const parent = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, parent.id, { tools: [agents.Kaeno.tools!.find(t => t.name === "delegate")!], cwd: "/inherited", thinkingLevel: "xhigh" });
    const task = await tx.createTask(Task, {}, { ownership: { kind: "conversation" }, conversationId: parent.id });
    const child = await tx.createConversation({ ownership: { kind: "task", taskId: task } });
    expect((await tx.doc(AgentDoc, child.id)).tools).toEqual(["delegate"]);
    await factory.configure(tx, child.id, { role: "worker", agent: "leaf" }, agents.Kaeno);
    const work = await tx.createConversation({ ownership: { kind: "task", taskId: task } });
    await agents.configureWork(tx, work.id, blueprint);
    return { child: child.id, work: work.id };
  }, ctx);
  const childConfig = (await h.snapshot(AgentDoc, child, ctx))!;
  expect(childConfig.tools).toEqual([]); expect(childConfig.cwd).toBeUndefined(); expect(childConfig.thinkingLevel).toBeUndefined();
  const state = (await h.snapshot(AgentState, work, ctx))!;
  expect(state.skills).toEqual(blueprint.templates.swe!.skills);
  expect((await h.snapshot(AgentDoc, work, ctx))?.tools).toEqual(["read_skill", "delegate"]);
  catalog.bind.mockClear();
  const deps = { harness: () => h, agent: { role: "chat" as const, configure: (tx: Tx, id: Parameters<AgentFactory["configure"]>[1]) => factory.configure(tx, id, { role: "chat" }, agents.Kaeno) } };
  const id = await thread(deps, "chat:binding");
  expect(catalog.bind).toHaveBeenCalledTimes(1);
  expect((await h.snapshot(AgentState, id, ctx))?.skills).toEqual(catalog.bind.mock.results[0]!.value);
  expect((await h.snapshot(AgentState, id, ctx))?.template).toBe("chat");
});

it.each([true, false])("persists worker binding from one configure and adopts without reconfiguring (frozen=%s)", async frozen => {
  const { config, catalog, factory, agents } = setup(), h = await open();
  // Reasoning worker with a skill and self-delegate; no pod is involved in this composition test.
  config.templates.swe!.sandbox = false; config.templates.swe!.tools = [];
  const blueprint: WorkBlueprint | undefined = frozen ? JSON.parse(JSON.stringify(agents.captureWork("swe"))) : undefined;
  const Task = defineTask({ name: "test.delegate-owner", version: 1, initial: () => ({ phase: "hold" }), phases: { hold: async () => {} }, abort: async () => {} });
  const { parent, task } = await h.commit(async tx => {
    const parent = await tx.createConversation({ ownership: { kind: "ownerless" } });
    const task = await tx.createTask(Task, {}, { ownership: { kind: "conversation" }, conversationId: parent.id });
    return { parent: parent.id, task };
  }, ctx);
  catalog.bind.mockClear();
  if (frozen) catalog.bind.mockImplementation(() => { throw new Error("LIVE CATALOG FORBIDDEN"); });
  const configured = vi.spyOn(factory, "configure");
  const delegate = agents.Kaeno.tools!.find(t => t.name === "delegate")!;
  const api = { conversationId: parent, taskId: task,
    snapshot: async () => ({ template: "swe", ...(frozen ? { role: "work", blueprint } : {}) }),
    commit: (fn: (tx: Tx) => Promise<any>) => h.commit(fn, ctx), details: async () => {},
    conversation: async () => ({ submit: async () => ({ wait: async () => ({ status: "aborted", reason: "test completed" }) }) }),
  };
  await delegate.execute({ agent: "swe", task: "read skill" }, api as any, ctx);
  expect(configured).toHaveBeenCalledTimes(1);
  expect(catalog.bind).toHaveBeenCalledTimes(frozen ? 0 : 1);
  const id = (await h.commit(tx => tx.scanConversations({ ownerTaskId: task }, 1), ctx)).items[0]!.id;
  const state = (await h.snapshot(AgentState, id, ctx))!;
  expect(state.role).toBe("worker"); expect(state.skills).toEqual(binding);
  expect((await h.snapshot(AgentDoc, id, ctx))?.tools).toEqual(["read_skill"]);
  configured.mockImplementation(() => { throw new Error("ADOPTION MUST NOT CONFIGURE"); });
  catalog.bind.mockImplementation(() => { throw new Error("ADOPTION MUST NOT BIND"); });
  await delegate.execute({ agent: "swe", task: "read skill" }, api as any, ctx);
  expect(configured).toHaveBeenCalledTimes(1);
  expect((await h.snapshot(AgentState, id, ctx))?.skills).toEqual(state.skills);
});

it("deep-freezes captured and restored snapshots without freezing live inputs or retaining aliases", () => {
  const { config, factory, agents } = setup(), blueprint = agents.captureWork("swe");
  expect(Object.isFrozen(config.templates.swe)).toBe(false);
  expect(Object.isFrozen(blueprint)).toBe(true);
  expect(() => (blueprint.templates.swe!.template.tools as string[]).push("bash")).toThrow(TypeError);
  expect(() => { (blueprint.templates.swe!.skills[0]!.documents as Record<string, string>)["SKILL.md"] = "CHANGED"; }).toThrow(TypeError);
  expect(() => (blueprint.templates.swe!.settings.worker.tools as string[]).push("delegate")).toThrow(TypeError);
  const raw = editable(blueprint), restored = readBlueprint(raw), bound = factory.bind("swe", raw);
  raw.templates.swe!.template.instructions = "CHANGED";
  expect(restored.templates.swe!.template.instructions).toBe("SWE PROFILE");
  expect(bound.template.instructions).toBe("SWE PROFILE");
  expect(Object.isFrozen(bound.template.delegates)).toBe(true);
  expect(Object.isFrozen(bound.skills[0]!.documents)).toBe(true);
  expect(() => readBlueprint(raw)).toThrow(/integrity/);
});

it("verifies the same checksum after storage reorders object keys", () => {
  const { agents } = setup(), blueprint = agents.captureWork("swe");
  const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)])) : value;
  expect(readBlueprint(reorder(blueprint) as WorkBlueprint)).toEqual(blueprint);
});

it.each(["instructions", "tools", "delegates", "documents", "images", "policy", "cwd"])("rejects a stored %s edit before configuration or adoption", async field => {
  const { agents, factory } = setup(), raw = editable(agents.captureWork("swe")), entry = raw.templates.swe!;
  if (field === "instructions") entry.template.instructions = "changed";
  if (field === "tools") entry.template.tools = [];
  if (field === "delegates") entry.template.delegates = [];
  if (field === "documents") entry.skills[0]!.documents["SKILL.md"] = "changed";
  if (field === "images") raw.images.execution = "changed";
  if (field === "policy") entry.settings.worker.tools.push("delegate");
  if (field === "cwd") entry.settings.worker.cwd = "/other";
  const h = await open();
  await expect(h.commit(async tx => {
    const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
    return factory.configure(tx, c.id, { role: "work", blueprint: raw }, agents.Kaeno);
  }, ctx)).rejects.toThrow(/integrity/);
  const commit = vi.fn();
  await expect(agents.Kaeno.tools!.find(t => t.name === "delegate")!.execute({ agent: "swe", task: "execute" }, {
    conversationId: 1, snapshot: async () => ({ role: "work", blueprint: raw }), commit,
  } as any, ctx)).rejects.toThrow(/integrity/);
  expect(commit).not.toHaveBeenCalled();
});

it.each([undefined, 2])("rejects absent/unknown policy schema %s instead of choosing current rules", async schema => {
  const { factory, agents } = setup(), raw = editable(agents.captureWork("swe"));
  if (schema === undefined) delete (raw as any).schema;
  else (raw as any).schema = schema;
  const h = await open();
  await expect(h.commit(async tx => {
    const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
    return factory.configure(tx, c.id, { role: "worker", agent: "swe", blueprint: raw }, agents.Kaeno);
  }, ctx)).rejects.toThrow(/supported frozen policy/);
});

it("uses saved policy for newly created children even when the current policy implementation and cwd change", async () => {
  const { config, catalog, work, agents } = setup(), blueprint = JSON.parse(JSON.stringify(agents.captureWork("swe"))), h = await open();
  const later = new AgentFactory({ config, skills: catalog, work, sandboxCwd: "/new-workspace" });
  const laterAgents = createAgents({ factory: later, images: { execution: "new-image" }, skillCacheClaim: "new-cache", harness: () => h });
  const changedPolicy = vi.spyOn(later as any, "settings").mockImplementation(() => { throw new Error("CURRENT POLICY FORBIDDEN"); });
  catalog.bind.mockImplementation(() => { throw new Error("CURRENT CATALOG FORBIDDEN"); });
  config.templates = {};
  for (const role of ["work", "worker", "legacy"] as const) {
    const id = await h.commit(async tx => {
      const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await later.configure(tx, c.id, role === "work" ? { role, blueprint } : { role, agent: "swe", blueprint }, agents.Kaeno);
      return c.id;
    }, ctx);
    const stored = (await h.snapshot(AgentDoc, id, ctx))!, saved = blueprint.templates.swe.settings[role];
    expect(stored.tools).toEqual(saved.tools); expect(stored.extensions).toEqual(saved.extensions);
    expect(stored.instructions).toBe(saved.instructions); expect(stored.model).toEqual(saved.model);
    expect(stored.thinkingLevel).toBe(saved.thinkingLevel ?? undefined); expect(stored.cwd).toBe(saved.cwd ?? undefined);
    if (role === "worker") {
      await h.commit(async tx => { (await tx.doc(AgentState, id)).sandbox = { pod: "test-pod", token: "test-token" }; }, ctx);
      const env = await laterAgents.env({ conversationId: id, cwd: stored.cwd, read: h }, ctx);
      expect(env).toMatchObject({ cwd: "/custom-workspace" }); // SDK and remote tools share the saved cwd.
    }
  }
  expect(changedPolicy).not.toHaveBeenCalled();
});

it("fails closed when a saved extension or tool is no longer available", async () => {
  const { config, catalog, factory, agents } = setup(), blueprint = agents.captureWork("swe"), h = await open();
  const noWork = new AgentFactory({ config, skills: catalog });
  await expect(h.commit(async tx => {
    const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
    return noWork.configure(tx, c.id, { role: "work", blueprint }, agents.Kaeno);
  }, ctx)).rejects.toThrow(/Frozen extension/);
  const withoutSkill = { ...agents.Kaeno, tools: agents.Kaeno.tools!.filter(t => t.name !== "read_skill") };
  await expect(h.commit(async tx => {
    const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
    return factory.configure(tx, c.id, { role: "worker", agent: "swe", blueprint }, withoutSkill);
  }, ctx)).rejects.toThrow(/Frozen tool/);
});

it("distinguishes omitted settings, explicit clearing, and an empty tool allowlist", async () => {
  const { agents } = setup(), h = await open();
  const id = await h.commit(async tx => {
    const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, c.id, { extensions: [CodingTools, agents.Kaeno], tools: [agents.Kaeno.tools![0]!], cwd: "/inherited", thinkingLevel: "high" });
    await configure(tx, c.id, {});
    expect((await tx.doc(AgentDoc, c.id)).cwd).toBe("/inherited");
    expect((await tx.doc(AgentDoc, c.id)).tools).toEqual(["delegate"]);
    await configure(tx, c.id, { cwd: null, thinkingLevel: null, tools: [] });
    expect((await tx.doc(AgentDoc, c.id)).tools).toEqual([]);
    await configure(tx, c.id, { tools: null });
    // null removes the filter; it does NOT mean no tools.
    expect((await tx.doc(AgentDoc, c.id)).tools).toBeUndefined();
    return c.id;
  }, ctx);
  expect((await h.snapshot(AgentDoc, id, ctx))?.cwd).toBeUndefined();
  expect((await h.snapshot(AgentDoc, id, ctx))?.thinkingLevel).toBeUndefined();
});

// Compile-time regression checks; this function is intentionally never called.
function typeContracts(blueprint: WorkBlueprint, factory: AgentFactory) {
  // @ts-expect-error Captured template lists cannot be edited.
  blueprint.templates.swe!.template.tools.push("bash");
  // @ts-expect-error Captured skill documents cannot be edited.
  blueprint.templates.swe!.skills[0]!.documents["SKILL.md"] = "changed";
  // @ts-expect-error Saved executable-policy settings cannot be replaced.
  blueprint.templates.swe!.settings.worker.cwd = "/other";
  // @ts-expect-error Agents cannot receive a conflicting config.
  createAgents({ factory, config: factory.config, images: { execution: "image" }, skillCacheClaim: "cache", harness: () => { throw new Error(); } });
  // @ts-expect-error Agents cannot receive a conflicting catalog.
  createAgents({ factory, skills: { bind: () => [] }, images: { execution: "image" }, skillCacheClaim: "cache", harness: () => { throw new Error(); } });
  // @ts-expect-error Agents cannot receive a conflicting cwd.
  createAgents({ factory, sandboxCwd: "/other", images: { execution: "image" }, skillCacheClaim: "cache", harness: () => { throw new Error(); } });
}
void typeContracts;
