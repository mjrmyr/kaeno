import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  defineExtension,
  defineTool,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, expect, it, vi } from "vitest";
import {
  openKaeno,
  type WorkEnvironment,
} from "../../src/core/application/index.ts";
import type { AgentExtension } from "../../src/extensions/contributions/index.ts";
import { SkillCatalog } from "../../src/extensions/skills/index.ts";
import {
  browserExtension,
  BROWSER_TOOLS,
} from "../../src/extensions/browser/index.ts";
import {
  loadEnvironment,
  type LoadEnvironmentOptions,
} from "../../src/host/composition/index.ts";

const roots: string[] = [];
function manifest(name: string, fields = ""): string {
  return `---\nname: ${name}\ndescription: ${name}\nmodel: faux/faux-1\n${fields}---\n${name} instructions`;
}
async function put(root: string, path: string, text: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), text);
}
async function fixture(assistantFields = "", workerFields = "") {
  const root = await mkdtemp(join(tmpdir(), "kaeno-contributions-"));
  roots.push(root);
  await put(
    root,
    "agents/assistant/AGENT.md",
    manifest("assistant", assistantFields),
  );
  await put(root, "agents/worker/AGENT.md", manifest("worker", workerFields));
  await put(root, "agents/other/AGENT.md", manifest("other"));
  await put(
    root,
    "skills/source/SKILL.md",
    "---\nname: source\ndescription: File guidance\n---\nSOURCE",
  );
  const configFile = join(root, "config.json");
  await put(
    root,
    "config.json",
    JSON.stringify({
      sourceDirectory: "sources",
      localDefinitions: {
        agents: [{ alias: "local", directory: "agents" }],
        skills: [{ alias: "local", directory: "skills" }],
      },
      kaeno: "local:assistant",
      workers: ["local:worker", "local:other"],
    }),
  );
  return { root, configFile };
}
function feature(name = "custom") {
  const bind = vi.fn<NonNullable<AgentExtension["bind"]>>(() => ({
    version: 1,
    value: { scope: name },
  }));
  const extension: AgentExtension = {
    runtime: {
      durable: defineExtension({
        name,
        tools: ["open", "save"].map((action) =>
          defineTool({
            name: `${name}_${action}`,
            description: action,
            parameters: Type.Object({}),
            execute: async () => ({}),
          }),
        ),
      }),
      validateBinding(binding) {
        if (
          binding.version !== 1 ||
          JSON.stringify(binding.value) !== JSON.stringify({ scope: name })
        ) {
          throw new Error("Wrong private scope");
        }
      },
    },
    bind,
    skills: new SkillCatalog(
      ["guide", "hidden"].map((skill) => ({
        id: `${name}:${skill}`,
        description: skill,
        disableModelInvocation: skill === "hidden",
        treeHash: "a".repeat(64),
        documents: { "SKILL.md": `ORIGINAL ${skill} KNOWLEDGE` },
        assets: { "binary.bin": { base64: "AAEC", executable: true } },
      })),
    ),
  };
  return { extension, bind };
}
function grant(
  extension: AgentExtension,
): NonNullable<LoadEnvironmentOptions["policy"]> {
  return (base) => ({
    assistant: {
      available: [...base.assistant.available, extension],
      defaults: [...base.assistant.defaults, extension],
    },
    worker: {
      available: [...base.worker.available, extension],
      defaults: [...base.worker.defaults, extension],
    },
  });
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

it("installs native definitions without assigning tools, skills or private bindings", async () => {
  const { configFile } = await fixture();
  const { extension, bind } = feature();
  const config = await loadEnvironment({ configFile, extensions: [extension] });
  expect(config.extensions).toContain(extension.runtime);
  expect(config.assistant.tools).not.toContain("custom_open");
  expect(config.work.tools).not.toContain("custom_open");
  expect(
    config.assistant.bindings?.some(
      (binding) =>
        binding.owner === "custom" || binding.owner === "kaeno-skills",
    ),
  ).toBe(false);
  expect(bind).not.toHaveBeenCalled();
});
it("binds an explicit tool selected from availability without adding defaults", async () => {
  const { configFile } = await fixture("tools: [custom_open]\n");
  const { extension, bind } = feature();
  const config = await loadEnvironment({
    configFile,
    extensions: [extension],
    policy: (base) => ({
      ...base,
      assistant: {
        ...base.assistant,
        available: [...base.assistant.available, { tools: ["custom_open"] }],
      },
    }),
  });
  expect(config.assistant.tools).toEqual(["custom_open"]);
  expect(config.assistant.bindings).toContainEqual({
    owner: "custom",
    version: 1,
    value: { scope: "custom" },
  });
  expect(bind).toHaveBeenCalledExactlyOnceWith({
    tools: ["custom_open"],
    skills: [],
  });
});
it.each(["custom_save", "missing"])(
  "rejects an explicit tool outside the ceiling: %s",
  async (name) => {
    const { configFile } = await fixture(`tools: [${name}]\n`);
    const { extension, bind } = feature();
    await expect(
      loadEnvironment({
        configFile,
        extensions: [extension],
        policy: (base) => ({
          ...base,
          assistant: {
            ...base.assistant,
            available: [
              ...base.assistant.available,
              { tools: ["custom_open"] },
            ],
          },
        }),
      }),
    ).rejects.toThrow(`tool "${name}" is outside policy availability`);
    expect(bind).not.toHaveBeenCalled();
  },
);
it("derives WORK approval from availability, not defaults or selected tools", async () => {
  const { root, configFile } = await fixture();
  const { extension, bind } = feature();
  await put(
    root,
    "config.json",
    JSON.stringify({
      sourceDirectory: "sources",
      localDefinitions: { agents: [{ alias: "local", directory: "agents" }] },
      kaeno: "local:assistant",
      workers: [],
    }),
  );
  const config = await loadEnvironment({
    configFile,
    extensions: [extension],
    policy: (base) => ({
      ...base,
      worker: {
        ...base.worker,
        available: [...base.worker.available, { tools: ["custom_open"] }],
      },
    }),
  });
  expect(config.work.agents).toEqual([]);
  expect(config.work.tools).toContain("custom_open");
  expect(config.work.tools).not.toContain("custom_save");
  expect(bind).not.toHaveBeenCalled();
});
it("lets explicit empty fields independently override extension defaults", async () => {
  const { configFile } = await fixture(
    "tools: []\nskills: []\n",
    "tools: []\nskills: [custom:guide]\n",
  );
  const { extension, bind } = feature();
  const config = await loadEnvironment({
    configFile,
    extensions: [extension],
    policy: grant(extension),
  });
  expect(config.assistant.tools).toEqual([]);
  expect(config.assistant.bindings?.map((binding) => binding.owner)).toEqual([
    "kaeno-definition-origins",
  ]);
  const worker = config.work.agents[0].setup;
  expect(worker.tools).toEqual([]);
  expect(worker.bindings).toContainEqual(
    expect.objectContaining({
      owner: "kaeno-skills",
      value: { skills: [expect.objectContaining({ id: "custom:guide" })] },
    }),
  );
  expect(bind.mock.calls[0]).toEqual([{ tools: [], skills: ["custom:guide"] }]);
});
it("keeps per-agent skill defaults separate and cannot widen role permissions", async () => {
  const { configFile } = await fixture();
  const { extension } = feature();
  const config = await loadEnvironment({
    configFile,
    extensions: [extension],
    policy: (base) => ({
      ...base,
      worker: {
        ...base.worker,
        available: [...base.worker.available, extension],
      },
      forAgent: (target, role) =>
        target.role === "worker"
          ? {
              ...role,
              defaults: [
                ...role.defaults,
                {
                  skills: [
                    `custom:${target.id === "local:worker" ? "guide" : "hidden"}`,
                  ],
                },
              ],
            }
          : role,
    }),
  });
  expect(config.work.agents[0].setup.bindings).toContainEqual(
    expect.objectContaining({
      owner: "kaeno-skills",
      value: { skills: [expect.objectContaining({ id: "custom:guide" })] },
    }),
  );
  expect(config.work.agents[1].setup.bindings).toContainEqual(
    expect.objectContaining({
      owner: "kaeno-skills",
      value: { skills: [expect.objectContaining({ id: "custom:hidden" })] },
    }),
  );
  await expect(
    loadEnvironment({
      configFile,
      extensions: [extension],
      policy: (base) => ({
        ...base,
        forAgent: (_target, role) => ({
          ...role,
          available: [...role.available, extension],
        }),
      }),
    }),
  ).rejects.toThrow("availability");
});
it("rejects defaults outside availability before any binding producer runs", async () => {
  const { configFile } = await fixture();
  const { extension, bind } = feature();
  await expect(
    loadEnvironment({
      configFile,
      extensions: [extension],
      policy: (base) => ({
        ...base,
        worker: {
          ...base.worker,
          defaults: [...base.worker.defaults, extension],
        },
      }),
    }),
  ).rejects.toThrow("Worker defaults");
  expect(bind).not.toHaveBeenCalled();
});
it("does not silently filter forbidden wildcard members or ambiguous aliases", async () => {
  const { configFile } = await fixture("skills: [custom:*]\n");
  const { extension } = feature();
  await expect(
    loadEnvironment({
      configFile,
      extensions: [extension],
      policy: (base) => ({
        ...base,
        assistant: {
          ...base.assistant,
          available: [
            ...base.assistant.available,
            { skills: ["custom:guide"] },
          ],
        },
      }),
    }),
  ).rejects.toThrow('skill "custom:hidden" is outside policy availability');
  const { root } = await fixture();
  const other = feature("other").extension;
  await put(
    root,
    "agents/assistant/AGENT.md",
    manifest("assistant", "skills: [guide]\n"),
  );
  await expect(
    loadEnvironment({
      configFile: join(root, "config.json"),
      extensions: [extension, other],
      policy: grant(extension),
    }),
  ).rejects.toThrow('ambiguous skill "guide"');
});
it("requires installed selector identity and rejects duplicate extension/tool/skill ownership", async () => {
  const { configFile } = await fixture();
  const { extension, bind } = feature();
  await expect(
    loadEnvironment({
      configFile,
      extensions: [extension],
      policy: grant(feature().extension),
    }),
  ).rejects.toThrow("uninstalled extension");
  await expect(
    loadEnvironment({ configFile, extensions: [extension, extension] }),
  ).rejects.toThrow("Duplicate or reserved extension");
  await expect(
    loadEnvironment({
      configFile,
      extensions: [
        extension,
        {
          runtime: {
            durable: defineExtension({
              name: "collision",
              tools: extension.runtime.durable.tools,
            }),
          },
        },
      ],
    }),
  ).rejects.toThrow("Duplicate tool");
  await expect(
    loadEnvironment({
      configFile,
      extensions: [
        extension,
        {
          runtime: { durable: defineExtension({ name: "collision" }) },
          skills: extension.skills,
        },
      ],
    }),
  ).rejects.toThrow("duplicate skill");
  const sourceCollision: AgentExtension = {
    runtime: { durable: defineExtension({ name: "source-collision" }) },
    skills: new SkillCatalog([
      {
        id: "local:source",
        description: "Collision",
        disableModelInvocation: false,
        treeHash: "a".repeat(64),
        documents: { "SKILL.md": "collision" },
      },
    ]),
  };
  await expect(
    loadEnvironment({ configFile, extensions: [sourceCollision] }),
  ).rejects.toThrow("duplicate skill local:source");
  expect(bind).not.toHaveBeenCalled();
});
it.each([
  { version: 1, value: { scope: "custom" }, owner: "someone-else" },
  { version: 0, value: { scope: "custom" } },
  { version: 1, value: { scope: "foreign" } },
])("rejects malformed/foreign private binding output %j", async (raw) => {
  const { configFile } = await fixture();
  const original = feature().extension;
  const extension: AgentExtension = {
    runtime: {
      ...original.runtime,
      validateBinding(binding) {
        if (
          JSON.stringify(binding.value) !== JSON.stringify({ scope: "custom" })
        ) {
          throw new Error("Wrong private scope");
        }
      },
    },
    bind: () => raw,
  };
  await expect(
    loadEnvironment({
      configFile,
      extensions: [extension],
      policy: grant(extension),
    }),
  ).rejects.toThrow();
});
it("rejects duplicate explicit tools and foreign read-only metadata", async () => {
  const { configFile } = await fixture("tools: [custom_open, custom_open]\n");
  const { extension } = feature();
  await expect(
    loadEnvironment({
      configFile,
      extensions: [extension],
      policy: grant(extension),
    }),
  ).rejects.toThrow("duplicate tool selection");
  await expect(
    loadEnvironment({
      configFile,
      extensions: [
        {
          runtime: {
            durable: defineExtension({ name: "foreign" }),
            readOnlyTools: ["read"],
          },
        },
      ],
    }),
  ).rejects.toThrow("not owned here");
});

it("supports mixed named tool/skill selectors without silently dropping either kind", async () => {
  const { configFile } = await fixture();
  const { extension, bind } = feature();
  const names = { tools: ["custom_open"], skills: ["custom:guide"] };
  const config = await loadEnvironment({
    configFile,
    extensions: [extension],
    policy: (base) => ({
      ...base,
      assistant: {
        available: [...base.assistant.available, names],
        defaults: [names],
      },
    }),
  });
  expect(config.assistant.tools).toEqual(["custom_open"]);
  expect(config.assistant.bindings).toContainEqual(
    expect.objectContaining({
      owner: "kaeno-skills",
      value: { skills: [expect.objectContaining({ id: "custom:guide" })] },
    }),
  );
  expect(bind).toHaveBeenCalledExactlyOnceWith(names);
});

it("limits assigned skill snapshots rather than the available source catalog", async () => {
  const { root, configFile } = await fixture("skills: [local:source]\n");
  for (const name of ["large1", "large2"]) {
    await put(
      root,
      `skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: Large package\n---\nGuidance`,
    );
    await writeFile(
      join(root, `skills/${name}/asset.bin`),
      Buffer.alloc(3 * 1024 * 1024),
    );
  }
  const config = await loadEnvironment({ configFile });
  expect(config.assistant.bindings).toContainEqual(
    expect.objectContaining({
      owner: "kaeno-skills",
      value: { skills: [expect.objectContaining({ id: "local:source" })] },
    }),
  );
  await put(
    root,
    "agents/assistant/AGENT.md",
    manifest("assistant", "skills: []\n"),
  );
  expect(
    (await loadEnvironment({ configFile })).assistant.bindings?.some(
      (binding) => binding.owner === "kaeno-skills",
    ),
  ).toBe(false);
  await put(
    root,
    "agents/assistant/AGENT.md",
    manifest("assistant", "skills: [local:large1, local:large2]\n"),
  );
  await expect(loadEnvironment({ configFile })).rejects.toThrow(
    "assigned skill snapshots exceed 8 MiB",
  );
});

it("rejects changed private scope in frozen WORK before provisioning, reconciliation or service start", async () => {
  const { root, configFile } = await fixture(
    "",
    "tools: []\nskills: [custom:guide]\n",
  );
  const { extension } = feature();
  const config = await loadEnvironment({
    configFile,
    extensions: [extension],
    policy: (base) => ({
      ...base,
      worker: {
        available: [...base.worker.available, extension],
        defaults: [...base.worker.defaults, extension],
      },
    }),
  });
  let ensuring = false;
  let provisions = 0;
  let reconciliations = 0;
  const environment: WorkEnvironment = {
    identity: "test:private-binding-recovery",
    cwd: "/workspace",
    ensure: async (_work, _runtime, ctx) => {
      provisions++;
      ensuring = true;
      await new Promise<void>((_resolve, reject) => {
        if (ctx.abortSignal?.aborted) {
          reject(ctx.abortSignal.reason);
          return;
        }
        ctx.abortSignal?.addEventListener(
          "abort",
          () => reject(ctx.abortSignal?.reason),
          { once: true },
        );
      });
    },
    release: async () => {},
    reconcile: async () => {
      reconciliations++;
    },
    executionEnvironment: async () => undefined,
  };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("start_work", {
          agent: "worker",
          title: "Pending",
          brief: "Wait",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("STARTED"),
  ]);
  const path = join(root, "db.sqlite");
  const core = await openKaeno({
    ...config,
    storage: await openNodeSqliteStorage(path),
    models,
    work: { ...config.work, environment },
  });
  try {
    const id = await core.threads.getOrCreateConversation(
      "pending-private-binding",
    );
    const task = await core.harness.commit(
      (tx) => core.turns.admitUserTurn(tx, id, "launch", "launch"),
      context,
    );
    await core.harness.waitForTask(task, context);
    await vi.waitFor(() => expect(ensuring).toBe(true));
    await core.close();
    provisions = 0;
    reconciliations = 0;
    const start = vi.fn<() => Promise<void>>(async () => {});
    await expect(
      openKaeno({
        storage: await openNodeSqliteStorage(path),
        models,
        assistant: {
          model: { provider: "faux", modelId: "faux-1" },
          instructions: "Future",
          tools: [],
        },
        extensions: config.extensions.map((runtime) =>
          runtime === extension.runtime
            ? {
                ...runtime,
                validateBinding: () => {
                  throw new Error("Wrong configured private scope");
                },
                start,
              }
            : runtime,
        ),
        work: { ...config.work, agents: [], environment },
      }),
    ).rejects.toThrow("Wrong configured private scope");
    expect(start).not.toHaveBeenCalled();
    expect(provisions).toBe(0);
    expect(reconciliations).toBe(0);
  } finally {
    await core.close();
  }
});

it("derives real discovered Browser worker contributions and rejects an assistant self-grant", async () => {
  const { root, configFile } = await fixture();
  const browser = await browserExtension();
  const options: LoadEnvironmentOptions = {
    configFile,
    extensions: [browser],
    policy: (base) => ({
      ...base,
      worker: {
        available: [...base.worker.available, browser],
        defaults: [...base.worker.defaults, browser],
      },
    }),
  };
  const config = await loadEnvironment(options);
  expect(config.work.tools).toEqual(expect.arrayContaining([...BROWSER_TOOLS]));
  expect(config.work.agents[0].setup.tools).toEqual(
    expect.arrayContaining([...BROWSER_TOOLS]),
  );
  expect(config.assistant.tools).not.toContain("browser_snapshot");
  await put(
    root,
    "agents/assistant/AGENT.md",
    manifest("assistant", "tools: [browser_snapshot]\n"),
  );
  await expect(loadEnvironment(options)).rejects.toThrow(
    'tool "browser_snapshot" is outside policy availability',
  );
});

it("recovers a pending CHAT's native skill snapshot without its producer or source files", async () => {
  const { root, configFile } = await fixture("tools: []\n");
  const mixed = feature("guides").extension;
  const guides: AgentExtension = {
    runtime: { durable: defineExtension({ name: "guides" }) },
    skills: mixed.skills,
  };
  const config = await loadEnvironment({
    configFile,
    extensions: [guides],
    policy: grant(guides),
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const path = join(root, "db.sqlite");
  let conversation: ConversationId | undefined;
  await expect(
    openKaeno({
      ...config,
      storage: await openNodeSqliteStorage(path),
      models,
      extensions: [
        ...config.extensions,
        {
          durable: defineExtension({ name: "interrupt" }),
          start: async (core) => {
            conversation =
              await core.threads.getOrCreateConversation("native-skill");
            const id = conversation;
            await core.harness.commit(
              (tx) =>
                core.turns.admitUserTurn(tx, id, "Read guidance", "request"),
              context,
            );
            throw new Error("interrupted");
          },
        },
      ],
    }),
  ).rejects.toThrow("interrupted");
  const id = conversation;
  if (id === undefined) {
    throw new Error("Expected saved conversation");
  }
  await rm(join(root, "agents"), { recursive: true });
  await rm(join(root, "skills"), { recursive: true });
  let observed = "";
  faux.setResponses([
    async (request) => {
      observed = JSON.stringify(request.messages);
      return fauxAssistantMessage("Recovered guidance");
    },
  ]);
  const core = await openKaeno({
    storage: await openNodeSqliteStorage(path),
    models,
    assistant: {
      model: { provider: "faux", modelId: "faux-1" },
      instructions: "Future",
      tools: [],
    },
    extensions: config.extensions.filter(
      (runtime) => runtime.durable.name !== "guides",
    ),
  });
  try {
    await vi.waitFor(async () =>
      expect(
        (await core.turns.readReplies(id, 0)).replies.map(
          (reply) => reply.text,
        ),
      ).toContain("Recovered guidance"),
    );
    expect(observed).toContain("ORIGINAL guide KNOWLEDGE");
    expect(observed).not.toContain("ORIGINAL hidden KNOWLEDGE");
    expect(observed).not.toContain("Use read_skill");
  } finally {
    await core.close();
  }
});
