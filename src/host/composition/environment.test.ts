import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { loadEnvironment, parseEnvironmentConfiguration } from "./index.ts";
import { DEFAULT_MODEL, KAENO_PERSONA, parseModelRef } from "./index.ts";

const roots: string[] = [];
async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}
async function fixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "kaeno-skills-only-"));
  roots.push(root);
  const configFile = join(root, "config.json");
  await put(
    configFile,
    JSON.stringify({ sourceDirectory: "./sources", ...overrides }),
  );
  return { root, configFile };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
const browser = {
  runtime: {
    durable: defineExtension({
      name: "browser",
      tools: [
        defineTool({
          name: "browser_snapshot",
          description: "Discovery",
          parameters: Type.Object({}),
          execute: async () => ({}),
        }),
      ],
    }),
  },
};

it("starts with no definitions or skills and a real generic worker setup", async () => {
  const { configFile } = await fixture();
  const config = await loadEnvironment({ configFile });
  expect(config.assistant.instructions).toBe(KAENO_PERSONA);
  expect(config.assistant.instructions).toContain("You are Kaeno");
  expect(config.assistant.model).toEqual(DEFAULT_MODEL);
  expect(config.work.setup.model).toEqual(DEFAULT_MODEL);
  expect(config.work.setup.instructions).toBe("");
  expect(config.work.setup.bindings).toEqual([]);
  expect(config.work.setup.tools).toEqual(
    expect.arrayContaining(["read", "bash", "start_work", "report"]),
  );
  expect(config.assistant.tools).toContain("route");
  expect(config.assistant.tools).not.toContain("bash");
  expect(config.assistant.tools).not.toContain("start_work");
  expect(config.diagnostics).toEqual([]);
});

it("does not consult external personas, agent roots, or legacy assistant files", async () => {
  const { root, configFile } = await fixture();
  await put(join(root, "agents/kaeno.md"), "OVERRIDE PERSONA");
  await put(join(root, ".kaeno/AGENT.md"), "OVERRIDE PERSONA");
  expect((await loadEnvironment({ configFile })).assistant.instructions).toBe(
    KAENO_PERSONA,
  );
});

it.each([
  { agentRepositories: [] },
  { kaeno: "local:kaeno" },
  { workers: [] },
  { localDefinitions: { agents: [] } },
])(
  "rejects legacy agent configuration with actionable migration guidance (%j)",
  async (legacy) => {
    const { configFile } = await fixture(legacy);
    await expect(loadEnvironment({ configFile })).rejects.toThrow(
      "Agent definitions are no longer supported",
    );
  },
);

it("uses one shared model, with environment override before configuration before builtin", async () => {
  const { configFile } = await fixture({
    defaultModel: "anthropic/custom/model",
  });
  const configured = await loadEnvironment({ configFile });
  expect(configured.assistant.model).toEqual({
    provider: "anthropic",
    modelId: "custom/model",
  });
  expect(configured.work.setup.model).toEqual(configured.assistant.model);
  const model = { provider: "faux", modelId: "override" };
  const overridden = await loadEnvironment({ configFile, defaultModel: model });
  expect(overridden.assistant.model).toEqual(model);
  expect(overridden.work.setup.model).toEqual(model);
});
it.each(["", "openai", "/model", "openai/"])(
  "rejects malformed model %j",
  (value) => {
    expect(() => parseModelRef(value)).toThrow("provider/model-id");
  },
);

async function skillsFixture(overrides: Record<string, unknown> = {}) {
  const result = await fixture({
    localDefinitions: { skills: [{ alias: "local", directory: "./skills" }] },
    ...overrides,
  });
  await put(
    join(result.root, "skills/guide/SKILL.md"),
    "---\nname: guide\ndescription: Useful guidance\n---\nApply this skill.",
  );
  return result;
}
function assigned(setup: {
  bindings?: readonly { owner: string; value: unknown }[];
}) {
  return setup.bindings?.find((binding) => binding.owner === "kaeno-skills")
    ?.value;
}
it("binds all configured skills to both roles by default, with durable snapshots", async () => {
  const { configFile } = await skillsFixture();
  const config = await loadEnvironment({ configFile });
  const expected = {
    skills: [
      expect.objectContaining({
        id: "local:guide",
        documents: { "SKILL.md": expect.stringContaining("Apply this skill") },
      }),
    ],
  };
  expect(assigned(config.assistant)).toEqual(expected);
  expect(assigned(config.work.setup)).toEqual(expected);
  expect(config.assistant.tools).toContain("read_skill");
  expect(config.work.setup.tools).toContain("read_skill");
});
it.each([{ skills: [] }, { skills: ["local:guide"] }, { skills: ["local:*"] }])(
  "supports skills-only selection (%j)",
  async ({ skills }) => {
    const { configFile } = await skillsFixture({ skills });
    const config = await loadEnvironment({ configFile });
    const binding = {
      skills: [expect.objectContaining({ id: "local:guide" })],
    };
    const expected = skills.length === 0 ? undefined : binding;
    expect(assigned(config.assistant)).toEqual(expected);
    expect(assigned(config.work.setup)).toEqual(expected);
  },
);
it("rejects unknown skills and malformed selected sources, not silently dropping them", async () => {
  const missing = await skillsFixture({ skills: ["local:missing"] });
  await expect(
    loadEnvironment({ configFile: missing.configFile }),
  ).rejects.toThrow("unknown skill");
  const malformed = await skillsFixture();
  await put(join(malformed.root, "skills/broken/SKILL.md"), "invalid");
  await expect(
    loadEnvironment({ configFile: malformed.configFile }),
  ).rejects.toThrow("invalid skill packages");
});
it("diagnoses malformed unselected skills without preventing an explicit valid selection", async () => {
  const { root, configFile } = await skillsFixture({ skills: ["local:guide"] });
  await put(join(root, "skills/broken/SKILL.md"), "invalid");
  const config = await loadEnvironment({ configFile });
  expect(config.diagnostics).toHaveLength(1);
  expect(assigned(config.work.setup)).toEqual({
    skills: [expect.objectContaining({ id: "local:guide" })],
  });
});
it("retains skill snapshots offline after the source directory is deleted", async () => {
  const { root, configFile } = await skillsFixture();
  const first = await loadEnvironment({ configFile });
  await rm(join(root, "skills"), { recursive: true });
  const offline = await loadEnvironment({ configFile, sourceMode: "offline" });
  expect(assigned(offline.work.setup)).toEqual(assigned(first.work.setup));
  expect(offline.assistant.instructions).toBe(KAENO_PERSONA);
});
it("keeps worker-only extension tools outside the router role", async () => {
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
  expect(config.work.setup.tools).toContain("browser_snapshot");
  expect(config.work.tools).toContain("browser_snapshot");
});
it("rejects role defaults outside their available tools", async () => {
  const { configFile } = await fixture();
  await expect(
    loadEnvironment({
      configFile,
      policy: (base) => ({
        ...base,
        worker: { available: [{ tools: [] }], defaults: base.worker.defaults },
      }),
    }),
  ).rejects.toThrow("outside policy availability");
});
it("rejects extensions claiming the shared skills owner", async () => {
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
it("normalizes skill repository declarations and config-relative paths", () => {
  const config = parseEnvironmentConfiguration(
    {
      sourceDirectory: "./sources",
      skillRepositories: [
        {
          provider: "github",
          repository: "Owner/Repo",
          ref: "release",
          path: "skills",
        },
      ],
      localDefinitions: { skills: [{ alias: "local", directory: "./skills" }] },
    },
    "/tmp/owner/config.json",
  );
  expect(config.sourceDirectory).toBe("/tmp/owner/sources");
  expect(config.repositories).toEqual([
    {
      kind: "skills",
      provider: "github",
      repository: "owner/repo",
      ref: "release",
      path: "skills",
    },
  ]);
  expect(config.directories).toEqual([
    { kind: "skills", alias: "local", directory: "/tmp/owner/skills" },
  ]);
});
it.each([
  { skillRepositories: ["owner/repo"] },
  { skillRepositories: [{ repository: "owner/repo" }] },
  { skillRepositories: [{ provider: "", repository: "owner/repo" }] },
  {
    skillRepositories: [
      { provider: "github", repository: "owner/repo", path: "../escape" },
    ],
  },
  {
    skillRepositories: [
      { provider: "github", repository: "owner/repo", ref: "-x" },
    ],
  },
  {
    skillRepositories: [
      { provider: "github", repository: "owner/repo" },
      { provider: "github", repository: "OWNER/REPO" },
    ],
  },
  {
    localDefinitions: {
      skills: [{ alias: "bad:alias", directory: "./skills" }],
    },
  },
  { unexpected: true },
])("rejects unsafe or ambiguous configuration (%j)", (fields) => {
  expect(() =>
    parseEnvironmentConfiguration(
      { sourceDirectory: "./sources", ...fields },
      "/tmp/config.json",
    ),
  ).toThrow();
});
it("parses explicit execution providers, defaults Docker and resolves backend files relative to the owner config", () => {
  const base = { sourceDirectory: "./sources" };
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
