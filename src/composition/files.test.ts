import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadFileEnvironment } from "./index.ts";
const roots: string[] = [];
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "kaeno-files-"));
  roots.push(value);
  return value;
}
async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}
afterEach(async () => {
  for (const value of roots.splice(0)) {
    await rm(value, { recursive: true, force: true });
  }
});
const agent = (name: string, description: string, model?: string) =>
  `---\nname: ${name}\ndescription: ${description}${model ? `\nmodel: ${model}` : ""}\n---\nPrompt for ${name}.\n`;
const skill = (name: string) =>
  `---\nname: ${name}\ndescription: Skill ${name}\n---\nInstructions for ${name}.\n`;
it("loads Kaeno config/skills from .kaeno and worker definitions/skills from home and local .agents", async () => {
  const project = await root();
  const home = await root();
  await put(
    join(home, ".kaeno/AGENT.md"),
    agent("home-assistant", "Home assistant", "openai/home"),
  );
  await put(
    join(project, ".kaeno/AGENT.md"),
    agent("project-assistant", "Project assistant", "openai/project"),
  );
  await put(
    join(home, ".kaeno/skills/kaeno-guide/SKILL.md"),
    skill("kaeno-guide"),
  );
  await put(
    join(project, ".kaeno/skills/local-kaeno/SKILL.md"),
    skill("local-kaeno"),
  );
  await put(
    join(home, ".agents/agents/reviewer/AGENT.md"),
    agent("reviewer", "Home reviewer"),
  );
  await put(
    join(project, ".agents/agents/coder/AGENT.md"),
    agent("coder", "Project coder"),
  );
  await put(join(home, ".agents/skills/shared/SKILL.md"), skill("shared"));
  await put(join(project, ".agents/skills/local/SKILL.md"), skill("local"));
  const config = await loadFileEnvironment({ root: project, home });
  expect(config.assistant.model).toEqual({
    provider: "openai",
    modelId: "project",
  });
  expect(config.assistant.instructions).toBe("Prompt for project-assistant.");
  expect(config.assistant.bindings?.[0]).toMatchObject({
    owner: "kaeno-skills",
    value: {
      skills: [
        { id: "kaeno-home:kaeno-guide" },
        { id: "kaeno-local:local-kaeno" },
      ],
    },
  });
  expect(config.work?.participants.list().map(({ id }) => id)).toEqual([
    "home:reviewer",
    "local:coder",
  ]);
  expect(config.diagnostics).toEqual([]);
});
it("uses ~/.kaeno when there is no project override and still works without worker catalogs", async () => {
  const project = await root();
  const home = await root();
  await put(
    join(home, ".kaeno/AGENT.md"),
    agent("kaeno", "Assistant", "openai/home"),
  );
  const config = await loadFileEnvironment({ root: project, home });
  expect(config.assistant.model).toEqual({
    provider: "openai",
    modelId: "home",
  });
  expect(config.work?.participants.list()).toEqual([]);
  expect(config.assistant.tools).toEqual([]);
});
it("keeps same-name agents distinct across home and project sources", async () => {
  const project = await root();
  const home = await root();
  await put(
    join(home, ".kaeno/AGENT.md"),
    agent("kaeno", "Assistant", "openai/home"),
  );
  await put(
    join(home, ".agents/agents/reviewer/AGENT.md"),
    agent("reviewer", "Home"),
  );
  await put(
    join(project, ".agents/agents/reviewer/AGENT.md"),
    agent("reviewer", "Project"),
  );
  const config = await loadFileEnvironment({ root: project, home });
  expect(config.work?.participants.list().map(({ id }) => id)).toEqual([
    "home:reviewer",
    "local:reviewer",
  ]);
});

it("reports an unavailable external catalog without inventing entries or preventing retained-work composition", async () => {
  const project = await root();
  const home = await root();
  await put(
    join(home, ".kaeno/AGENT.md"),
    agent("kaeno", "Assistant", "openai/home"),
  );
  const config = await loadFileEnvironment({
    root: project,
    home,
    agentSources: [
      {
        alias: "external",
        snapshot: async () => {
          throw new Error("Directory unavailable");
        },
      },
    ],
  });
  expect(config.work?.participants.list()).toEqual([]);
  expect(config.diagnostics).toContainEqual({
    location: "source:external",
    message: "Directory unavailable",
  });
});

it("does not load the same home/project directory twice when started in HOME", async () => {
  const home = await root();
  await put(
    join(home, ".kaeno/AGENT.md"),
    agent("kaeno", "Assistant", "openai/home"),
  );
  await put(
    join(home, ".agents/agents/coder/AGENT.md"),
    agent("coder", "Coder"),
  );
  const config = await loadFileEnvironment({ root: home, home });
  expect(config.work?.participants.list().map(({ id }) => id)).toEqual([
    "home:coder",
  ]);
  expect(config.diagnostics).toEqual([]);
});
