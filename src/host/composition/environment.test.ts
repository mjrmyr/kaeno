import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
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
  await put(join(root, "agents/coordinator/AGENT.md"), agent("coordinator"));
  await put(
    join(root, "agents/swe/AGENT.md"),
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
      join(root, "agents/coordinator/AGENT.md"),
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
it("native-only knowledge is additive even with source skills/tools explicitly empty", async () => {
  const { root, configFile } = await fixture();
  await put(
    join(root, "agents/coordinator/AGENT.md"),
    agent("coordinator", "model: openai/test\ntools: []\n"),
  );
  const config = await loadEnvironment({
    configFile,
    skillsFor: (_agent, role) =>
      role === "assistant"
        ? [
            {
              id: "native:baseline",
              description: "Native",
              disableModelInvocation: false,
              treeHash: "a".repeat(64),
              documents: { "SKILL.md": skill("baseline") },
            },
          ]
        : [],
  });
  expect(config.assistant.tools).toEqual([]);
  expect(
    config.assistant.bindings?.filter(
      (binding) => binding.owner === "kaeno-skills",
    ),
  ).toMatchObject([{ value: { skills: [{ id: "native:baseline" }] } }]);
});
it("keeps worker-specific native contributions separate", async () => {
  const { root, configFile } = await fixture({
    workers: ["local:swe", "local:other"],
  });
  await put(join(root, "agents/other/AGENT.md"), agent("other"));
  const config = await loadEnvironment({
    configFile,
    skillsFor: (definition, role) =>
      role === "worker"
        ? [
            {
              id: `native:${definition.name}`,
              description: "Native",
              disableModelInvocation: false,
              treeHash: "a".repeat(64),
              documents: { "SKILL.md": skill(definition.name) },
            },
          ]
        : [],
  });
  expect(
    config.work.agents.find((profile) => profile.id === "local:other")?.setup
      .bindings,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        owner: "kaeno-skills",
        value: { skills: [expect.objectContaining({ id: "native:other" })] },
      }),
    ]),
  );
});
it.each(["[]", "[list_work]"])(
  "explicit assistant tools remain exact (%s)",
  async (tools) => {
    const { root, configFile } = await fixture();
    await put(
      join(root, "agents/coordinator/AGENT.md"),
      agent("coordinator", `model: openai/test\ntools: ${tools}\n`),
    );
    expect((await loadEnvironment({ configFile })).assistant.tools).toEqual(
      tools === "[]" ? [] : ["list_work"],
    );
  },
);
it("keeps explicit worker tools for core to check when Kaeno opens", async () => {
  const { root, configFile } = await fixture();
  await put(
    join(root, "agents/swe/AGENT.md"),
    agent("swe", "model: openai/test\ntools: [missing_tool]\n"),
  );
  const config = await loadEnvironment({ configFile });
  expect(config.work.agents[0].setup.tools).toEqual(["missing_tool"]);
  expect(config.work.tools).not.toContain("missing_tool");
});
it("does not inherit a worker model from the assistant", async () => {
  const { root, configFile } = await fixture();
  await put(join(root, "agents/swe/AGENT.md"), agent("swe", ""));
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
  await put(join(root, "agents/invalid/AGENT.md"), "invalid");
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
    join(root, "agents/coordinator/AGENT.md"),
    agent("coordinator", "model: openai/test\nskills: [local:*]\n"),
  );
  await expect(loadEnvironment({ configFile })).rejects.toThrow(
    "invalid skill packages",
  );
});
it("rejects a competing native skills owner", async () => {
  const { configFile } = await fixture();
  await expect(
    loadEnvironment({
      configFile,
      bindings: [{ owner: "kaeno-skills", version: 1, value: { skills: [] } }],
    }),
  ).rejects.toThrow("Use skillsFor");
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
      agentRepositories: ["Owner/Repo:release"],
      skillRepositories: [
        { repository: "owner/repo", ref: "release", path: "skills" },
      ],
      kaeno: "owner/repo:kaeno",
    },
    "/tmp/example/config.json",
  );
  expect(config.sourceDirectory).toBe("/tmp/example/sources");
  expect(config.repositories).toEqual([
    { kind: "agents", repository: "owner/repo", ref: "release", path: "" },
    {
      kind: "skills",
      repository: "owner/repo",
      ref: "release",
      path: "skills",
    },
  ]);
});
it.each([
  {
    agentRepositories: ["owner/repo:one"],
    skillRepositories: ["owner/repo:two"],
  },
  { agentRepositories: ["owner/repo", "OWNER/REPO"] },
  { agentRepositories: [{ repository: "owner/repo", path: "../escape" }] },
  { agentRepositories: ["owner/repo:-x"] },
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
    workerTools: ["browser_snapshot"],
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
      join(root, "agents/swe/AGENT.md"),
      agent("swe", `model: openai/worker\n${tools}`),
    );
    const config = await loadEnvironment({
      configFile,
      workerTools: ["browser_snapshot"],
    });
    expect(config.work.agents[0].setup.tools).toEqual(expected);
    expect(config.assistant.tools).not.toContain("browser_snapshot");
  },
);
