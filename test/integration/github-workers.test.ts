import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type JsonObject } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { openKaeno } from "../../src/core/application/index.ts";
import { receive } from "../mocks/router.ts";
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

it("supports explicitly granted GitHub discovery for router, generic root and child workers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-github-workers-"));
  async function put(path: string, content: string) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  try {
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
          skills: [{ alias: "global", directory: "./.agents/skills" }],
        },
        defaultModel: "faux/faux-1",
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
    function call(name: string, args: JsonObject) {
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
            return call("route", {
              items: [
                {
                  trigger: "t1",
                  kind: "accept",
                  title: "Code",
                  ack: "On it.",
                },
              ],
            });
          }
          return fauxAssistantMessage("REPORTED");
        }
        const role = prompt.includes("generic child workers")
          ? "coder"
          : "reviewer";
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
      await receive(
        core,
        "launch-root: discover projects and delegate a review.",
      );
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

it("configures GitHub through role policy without agent profiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-github-config-"));
  try {
    await writeFile(join(directory, "app.pem"), privateKey, { mode: 0o600 });
    const path = join(directory, "github.json");
    await writeFile(
      path,
      JSON.stringify({
        appId: "123",
        privateKeyFile: "app.pem",
        installationId,
      }),
    );
    const github = await loadGitHubConfiguration(path);
    const configFile = join(directory, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        sourceDirectory: "./sources",
        defaultModel: "faux/faux-1",
      }),
    );
    const options: LoadEnvironmentOptions = {
      configFile,
      extensions: [github],
      policy: (base) => ({
        assistant: base.assistant,
        worker: {
          available: [...base.worker.available, github],
          defaults: [...base.worker.defaults, github],
        },
      }),
    };
    const config = await loadEnvironment(options);
    expect(config.work.setup.bindings).toEqual([githubBinding(installationId)]);
    expect(config.work.setup.tools).toEqual(
      expect.arrayContaining([...GITHUB_TOOLS]),
    );
    expect(config.assistant.tools).not.toContain("github_list_repositories");
    expect(config.assistant.bindings).toEqual([]);
    expect(() => github.runtime.validateBinding?.(githubBinding(99))).toThrow(
      "configured installation",
    );
    const overridden = await loadEnvironment({
      ...options,
      policy: (base) => ({
        assistant: {
          available: [...base.assistant.available, github],
          defaults: [{ tools: ["github_list_repositories"] }],
        },
        worker: {
          available: [...base.worker.available, github],
          defaults: base.worker.defaults,
        },
      }),
    });
    expect(overridden.work.setup.tools).not.toContain(
      "github_list_repositories",
    );
    expect(overridden.assistant.tools).toEqual(["github_list_repositories"]);
    expect(overridden.work.setup.bindings).toEqual([]);
    const disabled = await loadEnvironment({ configFile });
    expect(disabled.work.setup.bindings).toEqual([]);
    expect(disabled.assistant.bindings).toEqual([]);
    expect(disabled.work.tools).not.toContain("github_list_repositories");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
