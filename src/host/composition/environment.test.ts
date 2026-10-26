import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

const browser = {
  runtime: {
    durable: defineExtension({
      name: "browser",
      tools: [
        defineTool({
          name: "browser_snapshot",
          description: "Test discovery",
          parameters: Type.Object({}),
          execute: async () => ({}),
        }),
      ],
    }),
  },
};
import { loadEnvironment, parseEnvironmentConfiguration } from "./index.ts";

const roots: string[] = [];
async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}
function agent(name: string, fields = "model: openai/test\n") {
  return `---\nname: ${name}\ndescription: Profile ${name}\n${fields}---\nInstructions for ${name}.\n`;
}
function skill(name: string) {
  return `---\nname: ${name}\ndescription: Skill ${name}\n---\nKnowledge ${name}.\n`;
}
async function fixture(
  overrides: Record<string, unknown> = {},
): Promise<{ root: string; configFile: string }> {
  const root = await mkdtemp(join(tmpdir(), "kaeno-environment-"));
  roots.push(root);
  await put(join(root, "agents/coordinator.md"), agent("coordinator"));
  await put(
    join(root, "agents/swe.md"),
    agent("swe", "model: openai/worker\nskills: [local:*]\n"),
  );
  await put(join(root, "skills/guide/SKILL.md"), skill("guide"));
  const configFile = join(root, "config.json");
  await put(
    configFile,
    JSON.stringify({
      sourceDirectory: "./sources",
      localDefinitions: {
        agents: [{ alias: "local", directory: "./agents" }],
        skills: [{ alias: "local", directory: "./skills" }],
      },
      kaeno: "local:coordinator",
      workers: ["local:swe"],
      ...overrides,
    }),
  );
  return { root, configFile };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

it("parses explicit execution providers, defaults Docker and resolves backend files relative to the owner config", () => {
  const base = { sourceDirectory: "./sources", kaeno: "local:coordinator" };
  expect(
    parseEnvironmentConfiguration(base, "/owner/config.json").execution,
  ).toEqual({
    provider: "docker",
    configFile: "/owner/docker.json",
  });
  expect(
    parseEnvironmentConfiguration(
      {
        ...base,
        execution: { provider: "kubernetes", configFile: "./cluster.json" },
      },
      "/owner/config.json",
    ).execution,
  ).toEqual({
    provider: "kubernetes",
    configFile: "/owner/cluster.json",
  });
  expect(
    parseEnvironmentConfiguration(
      {
        ...base,
        execution: { provider: "docker", configFile: "./backends/docker.json" },
      },
      "/owner/config.json",
    ).execution,
  ).toMatchObject({
    provider: "docker",
    configFile: "/owner/backends/docker.json",
  });
  expect(
    parseEnvironmentConfiguration(
      {
        ...base,
        execution: { provider: "custom-remote", configFile: "remote.json" },
      },
      "/owner/config.json",
    ).execution,
  ).toEqual({ provider: "custom-remote", configFile: "/owner/remote.json" });
  for (const execution of [
    { provider: "", configFile: "empty.json" },
    { provider: "unknown" },
    { provider: "kubernetes" },
    { provider: "kubernetes", configFile: "" },
    { provider: "docker" },
    { provider: "docker", configFile: "" },
    { provider: "docker", configFile: "docker.json", cpus: 1 },
    { provider: "kubernetes", configFile: "cluster.json", image: "worker:v2" },
  ]) {
    expect(() =>
      parseEnvironmentConfiguration(
        { ...base, execution },
        "/owner/config.json",
      ),
    ).toThrow("execution");
  }
});

it("selects assistant and workers from the same catalog, captures origins and keeps fixed native definitions", async () => {
  const { configFile } = await fixture();
  const config = await loadEnvironment({ configFile });
  expect(config.assistant.instructions).toBe("Instructions for coordinator.");
  expect(config.assistant.tools).toContain("start_work");
  expect(config.assistant.tools).toContain("read_skill");
  expect(config.assistant.bindings).toMatchObject([
    {
      owner: "kaeno-definition-origins",
      value: {
        agent: "local:coordinator",
        origin: { kind: "directory", source: "local" },
      },
    },
  ]);
  expect(
    config.work.agents.map(({ id, description }) => ({ id, description })),
  ).toEqual([{ id: "local:swe", description: "Profile swe" }]);
  expect(config.work.agents[0].setup.bindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        owner: "kaeno-skills",
        value: {
          skills: [
            expect.objectContaining({
              id: "local:guide",
              origin: expect.objectContaining({ kind: "directory" }),
            }),
          ],
        },
      }),
    ]),
  );
  expect(config.diagnostics).toEqual([]);
});
it.each([undefined, []])(
  "omitted or empty workers do not automatically expose catalog agents (%s)",
  async (workers) => {
    const { configFile } = await fixture({ workers });
    const config = await loadEnvironment({ configFile });
    expect(config.work.agents).toEqual([]);
    expect(config.work.tools).toContain("read_skill");
    expect(config.assistant.tools).toContain("start_work");
  },
);
it.each([
  { skills: "", expected: [] },
  { skills: "skills: []\n", expected: [] },
  { skills: "skills: [local:guide]\n", expected: ["local:guide"] },
])(
  "takes Kaeno's skills from its own profile ($skills)",
  async ({ skills, expected }) => {
    const { root, configFile } = await fixture();
    await put(
      join(root, "agents/coordinator.md"),
      agent("coordinator", `model: openai/test\n${skills}`),
    );
    const config = await loadEnvironment({ configFile });
    const binding = config.assistant.bindings?.find(
      (item) => item.owner === "kaeno-skills",
    );
    expect(binding?.value ?? { skills: [] }).toMatchObject({
      skills: expected.map((id) => ({ id })),
    });
    expect(binding === undefined).toBe(expected.length === 0);
  },
);
it.each([
  { agent: "local:coordinator" },
  { agent: "local:coordinator", skills: ["local:guide"] },
])("rejects the old kaeno object form (%j)", async (kaeno) => {
  const { configFile } = await fixture({ kaeno });
  await expect(loadEnvironment({ configFile })).rejects.toThrow(
    "kaeno: Invalid input: expected string, received object",
  );
});
it.each(["[]", "[list_work]"])(
  "explicit assistant tools remain exact (%s)",
  async (tools) => {
    const { root, configFile } = await fixture();
    await put(
      join(root, "agents/coordinator.md"),
      agent("coordinator", `model: openai/test\ntools: ${tools}\n`),
    );
    expect((await loadEnvironment({ configFile })).assistant.tools).toEqual(
      tools === "[]" ? [] : ["list_work"],
    );
  },
);
it("gives owner memory to the assistant by default and never makes it available to workers", async () => {
  const { root, configFile } = await fixture();
  const config = await loadEnvironment({ configFile });
  expect(config.assistant.tools).toEqual(
    expect.arrayContaining(["memory_save", "memory_forget"]),
  );
  expect(config.work.tools).not.toContain("memory_save");
  expect(config.work.agents[0].setup.tools).not.toContain("memory_save");
  await put(
    join(root, "agents/swe.md"),
    agent("swe", "model: openai/test\ntools: [memory_save]\n"),
  );
  await expect(loadEnvironment({ configFile })).rejects.toThrow(
    'tool "memory_save" is outside policy availability',
  );
});
it("rejects explicit worker tools outside the approved policy before opening core", async () => {
  const { root, configFile } = await fixture();
  await put(
    join(root, "agents/swe.md"),
    agent("swe", "model: openai/test\ntools: [missing_tool]\n"),
  );
  await expect(loadEnvironment({ configFile })).rejects.toThrow(
    'tool "missing_tool" is outside policy availability',
  );
});
it("does not inherit a worker model from the assistant", async () => {
  const { root, configFile } = await fixture();
  await put(join(root, "agents/swe.md"), agent("swe", ""));
  await expect(loadEnvironment({ configFile })).rejects.toThrow(
    "Agent local:swe is unavailable: no model",
  );
  const raw = JSON.parse(await readFile(configFile, "utf8"));
  await put(
    configFile,
    JSON.stringify({ ...raw, defaultModel: "openai/owner-default" }),
  );
  const config = await loadEnvironment({ configFile });
  expect(config.work.agents[0].setup.model.modelId).toBe("owner-default");
});
it("reports unused malformed definitions but refuses selecting them or wildcard-dropping malformed skills", async () => {
  const { root, configFile } = await fixture({ workers: [] });
  await put(join(root, "agents/invalid.md"), "invalid");
  await put(join(root, "skills/invalid/SKILL.md"), "invalid");
  const config = await loadEnvironment({ configFile });
  expect(config.diagnostics).toHaveLength(2);
  await put(
    configFile,
    JSON.stringify({
      sourceDirectory: "./sources",
      localDefinitions: {
        agents: [{ alias: "local", directory: "./agents" }],
        skills: [{ alias: "local", directory: "./skills" }],
      },
      kaeno: "local:coordinator",
    }),
  );
  await put(
    join(root, "agents/coordinator.md"),
    agent("coordinator", "model: openai/test\nskills: [local:*]\n"),
  );
  await expect(loadEnvironment({ configFile })).rejects.toThrow(
    "invalid skill packages",
  );
});
it("rejects an extension claiming the shared skills runtime owner", async () => {
  const { configFile } = await fixture();
  await expect(
    loadEnvironment({
      configFile,
      extensions: [
        { runtime: { durable: defineExtension({ name: "kaeno-skills" }) } },
      ],
    }),
  ).rejects.toThrow("Duplicate or reserved extension");
});
it("cached local snapshots survive deletion and are not silently refreshed offline", async () => {
  const { root, configFile } = await fixture();
  await loadEnvironment({ configFile });
  await rm(join(root, "agents"), { recursive: true });
  await rm(join(root, "skills"), { recursive: true });
  const cached = await loadEnvironment({ configFile, sourceMode: "offline" });
  expect(cached.assistant.instructions).toBe("Instructions for coordinator.");
  expect(cached.work.agents.map((profile) => profile.id)).toEqual([
    "local:swe",
  ]);
});
it("does not inspect the obsolete special assistant path", async () => {
  const { root, configFile } = await fixture();
  await put(join(root, ".kaeno/AGENT.md"), agent("obsolete"));
  expect((await loadEnvironment({ configFile })).assistant.instructions).toBe(
    "Instructions for coordinator.",
  );
});
it("normalizes repository declarations, config-relative paths and identical cross-kind refs", () => {
  const config = parseEnvironmentConfiguration(
    {
      sourceDirectory: "./sources",
      agentRepositories: [
        { provider: "github", repository: "Owner/Repo", ref: "release" },
      ],
      skillRepositories: [
        {
          provider: "github",
          repository: "owner/repo",
          ref: "release",
          path: "skills",
        },
      ],
      kaeno: "owner/repo:kaeno",
    },
    "/tmp/example/config.json",
  );
  expect(config.sourceDirectory).toBe("/tmp/example/sources");
  expect(config.repositories).toEqual([
    {
      kind: "agents",
      provider: "github",
      repository: "owner/repo",
      ref: "release",
      path: "agents",
    },
    {
      kind: "skills",
      provider: "github",
      repository: "owner/repo",
      ref: "release",
      path: "skills",
    },
  ]);
});
it.each([
  {
    agentRepositories: [
      { provider: "github", repository: "owner/repo", ref: "one" },
    ],
    skillRepositories: [
      { provider: "github", repository: "owner/repo", ref: "two" },
    ],
  },
  { agentRepositories: ["owner/repo:main"] },
  { agentRepositories: [{ repository: "owner/repo" }] },
  { agentRepositories: [{ provider: "", repository: "owner/repo" }] },
  {
    agentRepositories: [
      { provider: "github", repository: "owner/repo" },
      { provider: "other", repository: "OWNER/REPO" },
    ],
  },
  {
    agentRepositories: [
      { provider: "github", repository: "owner/repo", path: "../escape" },
    ],
  },
  {
    agentRepositories: [
      { provider: "github", repository: "owner/repo", ref: "-x" },
    ],
  },
  { workers: ["local:swe", "local:swe"] },
  { kaeno: "bare-name" },
  { extraSkills: [] },
])("rejects ambiguous/unsafe/obsolete configuration %j", (fields) => {
  expect(() =>
    parseEnvironmentConfiguration(
      {
        sourceDirectory: "./sources",
        kaeno: "local:kaeno",
        ...fields,
      },
      "/tmp/config.json",
    ),
  ).toThrow();
});

it("offers sandbox-only tools to workers, not the assistant defaults", async () => {
  const { configFile } = await fixture();
  const config = await loadEnvironment({
    configFile,
    extensions: [browser],
    policy: (base) => ({
      ...base,
      worker: {
        available: [...base.worker.available, browser],
        defaults: [...base.worker.defaults, browser],
      },
    }),
  });
  expect(config.assistant.tools).not.toContain("browser_snapshot");
  expect(config.work.tools).toContain("browser_snapshot");
  expect(config.work.agents[0].setup.tools).toContain("browser_snapshot");
});

it.each([
  { tools: "tools: []\n", expected: [] },
  { tools: "tools: [read]\n", expected: ["read"] },
  { tools: "tools: [browser_snapshot]\n", expected: ["browser_snapshot"] },
])(
  "respects explicit WORK tool lists instead of adding browser defaults ($tools)",
  async ({ tools, expected }) => {
    const { root, configFile } = await fixture();
    await put(
      join(root, "agents/swe.md"),
      agent("swe", `model: openai/worker\n${tools}`),
    );
    const config = await loadEnvironment({
      configFile,
      extensions: [browser],
      policy: (base) => ({
        ...base,
        worker: {
          available: [...base.worker.available, browser],
          defaults: [...base.worker.defaults, browser],
        },
      }),
    });
    expect(config.work.agents[0].setup.tools).toEqual(expected);
    expect(config.assistant.tools).not.toContain("browser_snapshot");
  },
);

it("diagnoses legacy agents without loading them, and freezes prior resolved setups across refresh/removal", async () => {
  const { root, configFile } = await fixture();
  const first = await loadEnvironment({ configFile });
  const frozen = structuredClone(first.work.agents);
  await put(join(root, "agents/swe/AGENT.md"), agent("swe"));
  const mixed = await loadEnvironment({ configFile });
  expect(mixed.work.agents[0].id).toBe("local:swe");
  expect(mixed.diagnostics.map((item) => item.message).join("\n")).toContain(
    "legacy agent package",
  );
  await put(
    join(root, "agents/swe.md"),
    agent("swe", "model: openai/changed\ntools: []\nskills: []\n"),
  );
  const changed = await loadEnvironment({ configFile });
  expect(changed.work.agents[0].setup.model).toEqual({
    provider: "openai",
    modelId: "changed",
  });
  expect(first.work.agents).toEqual(frozen);
  await rm(join(root, "agents/swe.md"));
  await expect(loadEnvironment({ configFile })).rejects.toThrow(
    /local:swe.*legacy agent package/,
  );
  // Failed refresh cannot replace the last complete set or resurrect the deleted live agent.
  const offline = await loadEnvironment({ configFile, sourceMode: "offline" });
  expect(offline.work.agents).toEqual(changed.work.agents);
});
it("validates injected agent file/name agreement with no filesystem lookup", async () => {
  const { configFile } = await fixture({ workers: ["native:scout"] });
  await expect(
    loadEnvironment({
      configFile,
      agentSources: [
        {
          alias: "native",
          async snapshot() {
            return {
              documents: [
                {
                  source: "native",
                  manifestPath: "/not/read/reviewer.md",
                  manifest: agent("scout"),
                },
              ],
              diagnostics: [],
            };
          },
        },
      ],
    }),
  ).rejects.toThrow(/expected filename "scout.md"/);
});
it.each([undefined, "", "custom/flat"])(
  "keeps omitted agent roots distinct from explicit roots (%s)",
  (path) => {
    const config = parseEnvironmentConfiguration(
      {
        sourceDirectory: "./sources",
        agentRepositories: [
          {
            provider: "github",
            repository: "owner/repo",
            ...(path === undefined ? {} : { path }),
          },
        ],
        skillRepositories: [{ provider: "github", repository: "owner/repo" }],
        kaeno: "owner/repo:kaeno",
      },
      "/tmp/config.json",
    );
    expect(config.repositories.map((item) => item.path)).toEqual([
      path ?? "agents",
      "",
    ]);
  },
);

it("captures absence of an unselected local agent root without consulting it offline", async () => {
  const { root, configFile } = await fixture({
    localDefinitions: {
      agents: [
        { alias: "local", directory: "./agents" },
        { alias: "optional", directory: "./missing" },
      ],
      skills: [{ alias: "local", directory: "./skills" }],
    },
  });
  const first = await loadEnvironment({ configFile });
  expect(first.diagnostics).toEqual([
    { location: join(root, "missing"), message: "Agent root is missing" },
  ]);
  await put(join(root, "missing/new.md"), agent("new"));
  const offline = await loadEnvironment({ configFile, sourceMode: "offline" });
  expect(offline.diagnostics).toEqual(first.diagnostics);
  expect(offline.work.agents).toEqual(first.work.agents);
  expect((await loadEnvironment({ configFile })).diagnostics).toEqual([]);
});

it("expands worker wildcards in stable order, skipping Kaeno unless selected explicitly", async () => {
  const { root, configFile } = await fixture({
    workers: ["local:*", "local:swe"],
  });
  await put(join(root, "agents/reviewer.md"), agent("reviewer"));
  const wildcard = await loadEnvironment({ configFile });
  expect(wildcard.work.agents.map((profile) => profile.id)).toEqual([
    "local:reviewer",
    "local:swe",
  ]);
  const explicit = await fixture({
    workers: ["local:coordinator", "local:*"],
  });
  expect(
    (
      await loadEnvironment({ configFile: explicit.configFile })
    ).work.agents.map((profile) => profile.id),
  ).toEqual(["local:coordinator", "local:swe"]);
});
it("refuses to expand a worker wildcard over invalid records or nothing", async () => {
  const { root, configFile } = await fixture({ workers: ["local:*"] });
  await put(join(root, "agents/broken.md"), agent("other"));
  await expect(loadEnvironment({ configFile })).rejects.toThrow(
    "cannot expand worker selection local:*: source local has invalid agent records",
  );
  // Exact selections of valid records are unaffected by a sibling's error.
  await put(
    configFile,
    JSON.stringify({
      ...JSON.parse(await readFile(configFile, "utf8")),
      workers: ["local:swe"],
    }),
  );
  expect(
    (await loadEnvironment({ configFile })).work.agents.map(
      (profile) => profile.id,
    ),
  ).toEqual(["local:swe"]);
  const lonely = await fixture({ workers: ["local:*"] });
  await rm(join(lonely.root, "agents/swe.md"));
  await expect(
    loadEnvironment({ configFile: lonely.configFile }),
  ).rejects.toThrow("empty worker selection local:*");
});
it.each(["*:swe", "local:sw*", "local:**", "local", "local:*:x"])(
  "rejects malformed worker selector %s",
  (selector) => {
    expect(() =>
      parseEnvironmentConfiguration(
        {
          sourceDirectory: "./sources",
          kaeno: "local:coordinator",
          workers: [selector],
        },
        "/tmp/config.json",
      ),
    ).toThrow("expected source:name or source:*");
  },
);
