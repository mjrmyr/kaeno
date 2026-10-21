import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { openKaeno } from "../../src/core/application/index.ts";
import {
  loadEnvironment,
  type LoadEnvironmentOptions,
} from "../../src/host/composition/index.ts";
import {
  githubBinding,
  githubExtension,
  GITHUB_TOOLS,
  loadGitHubConfiguration,
} from "../../src/extensions/github/index.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
const installationId = 12;

it("gives the assistant, root worker, and nested worker GitHub discovery by default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-github-workers-"));
  async function put(path: string, content: string) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  try {
    await put(
      ".agents/agents/kaeno/AGENT.md",
      "---\nname: kaeno\ndescription: Assistant\nmodel: faux/faux-1\n---\nCHAT",
    );
    await put(
      ".agents/agents/coder/AGENT.md",
      "---\nname: coder\ndescription: Codes in authorized repositories\nskills: [engineering]\n---\nCODER",
    );
    await put(
      ".agents/agents/reviewer/AGENT.md",
      "---\nname: reviewer\ndescription: Reviews\n---\nREVIEWER",
    );
    await put(
      ".agents/skills/engineering/SKILL.md",
      "---\nname: engineering\ndescription: Implement and verify software changes\n---\nRun tests before proposing changes.",
    );
    async function fetch(
      input: Parameters<typeof globalThis.fetch>[0],
    ): Promise<Response> {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("access_tokens")) {
        return Response.json({ token: "secret-token" });
      }
      if (path === "/installation/repositories") {
        return Response.json({
          repositories: [
            { id: 34, full_name: "owner/private", default_branch: "main" },
          ],
        });
      }
      throw new Error("Unexpected GitHub request");
    }
    const extension = githubExtension({
      appId: "123",
      privateKey,
      installationId,
      fetch,
    });
    const configFile = join(directory, "config.json");
    await put(
      "config.json",
      JSON.stringify({
        sourceDirectory: "./sources",
        localDefinitions: {
          agents: [{ alias: "global", directory: "./.agents/agents" }],
          skills: [{ alias: "global", directory: "./.agents/skills" }],
        },
        defaultModel: "faux/faux-1",
        kaeno: "global:kaeno",
        workers: ["global:coder", "global:reviewer"],
      }),
    );
    const config = await loadEnvironment({
      configFile,
      extensions: [extension],
      policy: (base) => ({
        assistant: {
          available: [...base.assistant.available, extension],
          defaults: [...base.assistant.defaults, extension],
        },
        worker: {
          available: [...base.worker.available, extension],
          defaults: [...base.worker.defaults, extension],
        },
      }),
    });
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const results = new Map<string, string>();
    const prompts = new Map<string, string>();
    function call(name: string, args: Record<string, string>) {
      return fauxAssistantMessage([fauxToolCall(name, args)], {
        stopReason: "toolUse",
      });
    }
    faux.setResponses(
      Array.from({ length: 40 }, () => async (request) => {
        const prompt = getCurrentSystemPrompt(request.messages);
        const last = request.messages.findLast(
          (message) => message.role !== "system",
        );
        if (!prompt.includes("You are Kaeno WORK")) {
          prompts.set("chat", prompt);
          if (
            last?.role === "user" &&
            JSON.stringify(last.content).includes("launch-root")
          ) {
            return call("github_list_repositories", {});
          }
          if (
            last?.role === "toolResult" &&
            last.toolName === "github_list_repositories"
          ) {
            results.set("chat", JSON.stringify(last));
            return call("start_work", {
              agent: "coder",
              title: "Code",
              brief: "Discover projects and delegate a review.",
            });
          }
          return fauxAssistantMessage("REPORTED");
        }
        const role = prompt.includes("CODER") ? "coder" : "reviewer";
        prompts.set(role, prompt);
        if (last?.role === "toolResult") {
          if (last.toolName === "list_skills") {
            return call("read_skill", { skill: "engineering" });
          }
          if (last.toolName === "read_skill") {
            results.set("skill", JSON.stringify(last));
            return call("github_list_repositories", {});
          }
          if (last.toolName === "github_list_repositories") {
            results.set(role, JSON.stringify(last));
            if (role === "coder") {
              return call("start_work", {
                agent: "reviewer",
                title: "Review",
                brief: "Discover your own available repository access.",
              });
            }
          }
          return fauxAssistantMessage("REPORT");
        }
        if (JSON.stringify(last?.content).includes("Child Work")) {
          return fauxAssistantMessage("CODER REPORT");
        }
        return call(
          role === "coder" ? "list_skills" : "github_list_repositories",
          {},
        );
      }),
    );
    const core = await openKaeno({
      ...config,
      storage: new MemoryStorage(),
      models,
    });
    try {
      const id = await core.threads.getOrCreateConversation("github-workers");
      const task = await core.harness.commit(
        (tx) => core.turns.admitUserTurn(tx, id, "launch-root", "root"),
        context,
      );
      await core.harness.waitForTask(task, context);
      await vi.waitFor(
        () => {
          expect(results.get("coder")).toContain("owner/private");
          expect(results.get("reviewer")).toContain("owner/private");
          expect(results.get("chat")).toContain("owner/private");
        },
        { timeout: 5000 },
      );
      expect(results.get("skill")).toContain(
        "Run tests before proposing changes",
      );
      for (const role of ["chat", "coder", "reviewer"]) {
        expect(prompts.get(role)).toContain("Use github_list_repositories");
        expect(prompts.get(role)).toContain(
          "GitHub installation access is assigned",
        );
        expect(prompts.get(role)).not.toContain("secret-token");
      }
    } finally {
      await core.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("configures GitHub for every agent while respecting explicit tool overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-github-config-"));
  try {
    await mkdir(join(directory, ".agents/agents/kaeno"), { recursive: true });
    await writeFile(
      join(directory, ".agents/agents/kaeno/AGENT.md"),
      "---\nname: kaeno\ndescription: Assistant\nmodel: faux/faux-1\n---\nCHAT",
    );
    await mkdir(join(directory, ".agents/agents/coder"), { recursive: true });
    await writeFile(
      join(directory, ".agents/agents/coder/AGENT.md"),
      "---\nname: coder\ndescription: Codes\n---\nCODER",
    );
    await writeFile(join(directory, "app.pem"), privateKey, { mode: 0o600 });
    const path = join(directory, "github.json");
    const ownerConfig = {
      appId: "123",
      privateKeyFile: "app.pem",
      installationId,
    };
    await writeFile(path, JSON.stringify(ownerConfig));
    const github = await loadGitHubConfiguration(path);
    const configFile = join(directory, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        sourceDirectory: "./sources",
        localDefinitions: {
          agents: [{ alias: "global", directory: "./.agents/agents" }],
        },
        defaultModel: "faux/faux-1",
        kaeno: "global:kaeno",
        workers: ["global:coder"],
      }),
    );
    const options: LoadEnvironmentOptions = {
      configFile,
      extensions: [github],
      policy: (base) => ({
        assistant: {
          available: [...base.assistant.available, github],
          defaults: [...base.assistant.defaults, github],
        },
        worker: {
          available: [...base.worker.available, github],
          defaults: [...base.worker.defaults, github],
        },
      }),
    };
    const config = await loadEnvironment(options);
    const setup = config.work?.agents.find(
      (agent) => agent.id === "global:coder",
    )?.setup;
    expect(
      setup?.bindings?.filter(
        (binding) => binding.owner !== "kaeno-definition-origins",
      ),
    ).toEqual([githubBinding(installationId)]);
    expect(setup?.bindings).toContainEqual(
      expect.objectContaining({
        owner: "kaeno-definition-origins",
        version: 1,
      }),
    );
    expect(setup?.tools).toEqual(expect.arrayContaining([...GITHUB_TOOLS]));
    expect(config.work?.tools).toEqual(
      expect.arrayContaining([...GITHUB_TOOLS]),
    );
    expect(
      config.assistant.bindings?.filter(
        (binding) => binding.owner !== "kaeno-definition-origins",
      ),
    ).toEqual([githubBinding(installationId)]);
    expect(config.assistant.bindings).toContainEqual(
      expect.objectContaining({
        owner: "kaeno-definition-origins",
        version: 1,
      }),
    );
    expect(config.assistant.tools).toEqual(
      expect.arrayContaining([...GITHUB_TOOLS]),
    );
    expect(() => github.runtime.validateBinding?.(githubBinding(99))).toThrow(
      "configured installation",
    );
    expect(() =>
      github.runtime.validateBinding?.({
        ...githubBinding(installationId),
        version: 1,
      }),
    ).toThrow("unsupported binding");
    await writeFile(
      join(directory, ".agents/agents/coder/AGENT.md"),
      "---\nname: coder\ndescription: Codes\ntools: []\n---\nCODER",
    );
    await writeFile(
      join(directory, ".agents/agents/kaeno/AGENT.md"),
      "---\nname: kaeno\ndescription: Assistant\nmodel: faux/faux-1\ntools: [github_list_repositories]\n---\nCHAT",
    );
    const overridden = await loadEnvironment(options);
    expect(
      overridden.work?.agents.find((agent) => agent.id === "global:coder")
        ?.setup.tools,
    ).toEqual([]);
    expect(overridden.assistant.tools).toEqual(["github_list_repositories"]);
    expect(
      overridden.work.agents[0].setup.bindings?.some(
        (binding) => binding.owner === "kaeno-github",
      ),
    ).toBe(false);
    await expect(loadEnvironment({ configFile })).rejects.toThrow(
      'tool "github_list_repositories" is outside policy availability',
    );
    await writeFile(
      join(directory, ".agents/agents/kaeno/AGENT.md"),
      "---\nname: kaeno\ndescription: Assistant\nmodel: faux/faux-1\n---\nCHAT",
    );
    const disabled = await loadEnvironment({ configFile });
    expect(
      disabled.work?.agents.find((agent) => agent.id === "global:coder")?.setup
        .bindings,
    ).toEqual([
      expect.objectContaining({
        owner: "kaeno-definition-origins",
        version: 1,
      }),
    ]);
    expect(disabled.assistant.bindings).toEqual([
      expect.objectContaining({
        owner: "kaeno-definition-origins",
        version: 1,
      }),
    ]);
    expect(disabled.work?.tools).not.toContain("github_list_repositories");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
