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
const agent = (name: string, fields = "model: openai/test\n") =>
  `---\nname: ${name}\ndescription: Profile ${name}\n${fields}---\nInstructions for ${name}.\n`;
const skill = (name: string) =>
  `---\nname: ${name}\ndescription: Skill ${name}\n---\nKnowledge ${name}.\n`;
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
      kaeno: { agent: "local:coordinator" },
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
  expect(config.work.participants.list()).toEqual([
    { id: "local:swe", description: "Profile swe", available: true },
  ]);
  expect(
    config.work.participants.plan("local:swe").participants["local:swe"].setup
      .bindings,
  ).toEqual(
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
    expect(config.work.participants.list()).toEqual([]);
    expect(config.work.tools).toContain("read_skill");
    expect(config.assistant.tools).toContain("start_work");
  },
);
it.each([undefined, [], ["local:guide"]])(
  "applies omitted/empty/explicit Kaeno skill selections (%s)",
  async (skills) => {
    const { root, configFile } = await fixture({
      kaeno: { agent: "local:coordinator", skills },
    });
    await put(
      join(root, "agents/coordinator/AGENT.md"),
      agent("coordinator", "model: openai/test\nskills: [local:guide]\n"),
    );
    const config = await loadEnvironment({ configFile });
    const binding = config.assistant.bindings?.find(
      (item) => item.owner === "kaeno-skills",
    );
    const expected = skills?.length === 0 ? [] : ["local:guide"];
    expect(binding?.value ?? { skills: [] }).toMatchObject({
      skills: expected.map((id) => ({ id })),
    });
    expect(binding === undefined).toBe(expected.length === 0);
  },
);
it("native-only knowledge is additive even with source skills/tools explicitly empty", async () => {
  const { root, configFile } = await fixture({
    kaeno: { agent: "local:coordinator", skills: [] },
  });
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
  const participants = config.work.participants.plan("local:swe").participants;
  expect(participants["local:other"].setup.bindings).toEqual(
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
it("fails explicit unavailable selections instead of silently shrinking workers", async () => {
  const { root, configFile } = await fixture();
  await put(
    join(root, "agents/swe/AGENT.md"),
    agent("swe", "model: openai/test\ntools: [missing_tool]\n"),
  );
  await expect(loadEnvironment({ configFile })).rejects.toThrow(
    "selected worker local:swe is unavailable",
  );
});
it("does not inherit a worker model from the assistant", async () => {
  const { root, configFile } = await fixture();
  await put(join(root, "agents/swe/AGENT.md"), agent("swe", ""));
  await expect(loadEnvironment({ configFile })).rejects.toThrow("no model");
  const raw = JSON.parse(await readFile(configFile, "utf8"));
  await put(
    configFile,
    JSON.stringify({ ...raw, defaultModel: "openai/owner-default" }),
  );
  const config = await loadEnvironment({ configFile });
  expect(
    config.work.participants.plan("local:swe").participants["local:swe"].setup
      .model.modelId,
  ).toBe("owner-default");
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
      kaeno: { agent: "local:coordinator", skills: ["local:*"] },
    }),
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
  expect(cached.work.participants.list()[0].available).toBe(true);
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
      kaeno: { agent: "owner/repo:kaeno" },
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
  { kaeno: { agent: "bare-name" } },
  { extraSkills: [] },
])("rejects ambiguous/unsafe/obsolete configuration %j", (fields) => {
  expect(() =>
    parseEnvironmentConfiguration(
      {
        sourceDirectory: "./sources",
        kaeno: { agent: "local:kaeno" },
        ...fields,
      },
      "/tmp/config.json",
    ),
  ).toThrow();
});
