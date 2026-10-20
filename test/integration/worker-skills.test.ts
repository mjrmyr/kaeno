import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openKaeno } from "../../src/core/application/index.ts";
import { loadEnvironment } from "../../src/host/composition/index.ts";

it.each([false, true])(
  "gives root and nested workers lazy skill tools independently of assignments (%s)",
  async (assigned) => {
    const directory = await mkdtemp(join(tmpdir(), "kaeno-worker-skills-"));
    async function put(path: string, text: string) {
      await mkdir(join(directory, path, ".."), { recursive: true });
      await writeFile(join(directory, path), text);
    }
    try {
      await put(
        ".agents/agents/kaeno/AGENT.md",
        "---\nname: kaeno\ndescription: Assistant\nmodel: faux/faux-1\n---\nCHAT",
      );
      await put(
        ".agents/agents/parent/AGENT.md",
        "---\nname: parent\ndescription: Coordinator\n---\nPARENT",
      );
      await put(
        ".agents/agents/leaf/AGENT.md",
        `---\nname: leaf\ndescription: Leaf\nskills: [${assigned ? "guide, hidden" : ""}]\n---\nLEAF`,
      );
      await put(
        ".agents/skills/guide/SKILL.md",
        "---\nname: guide\ndescription: Guide description\n---\nGUIDE INSTRUCTIONS",
      );
      await put(
        ".agents/skills/hidden/SKILL.md",
        "---\nname: hidden\ndescription: Hidden description\ndisable-model-invocation: true\n---\nHIDDEN INSTRUCTIONS",
      );
      await put(
        ".agents/skills/secret/SKILL.md",
        "---\nname: secret\ndescription: Unassigned description\n---\nUNASSIGNED INSTRUCTIONS",
      );
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
          workers: ["global:parent", "global:leaf"],
        }),
      );
      const config = await loadEnvironment({ configFile });
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      const lists = new Map<string, string>();
      const prompts = new Map<string, string>();
      let readResult = "";
      function call(name: string, args: Record<string, string>) {
        return fauxAssistantMessage([fauxToolCall(name, args)], {
          stopReason: "toolUse",
        });
      }
      faux.setResponses(
        Array.from({ length: 30 }, () => async (request) => {
          const system = getCurrentSystemPrompt(request.messages);
          const last = request.messages.findLast(
            (message) => message.role !== "system",
          );
          let role = "chat";
          if (system.includes("You are Kaeno WORK")) {
            role = system.includes("PARENT") ? "parent" : "leaf";
          }
          prompts.set(role, system);
          if (role === "chat") {
            if (
              last?.role === "user" &&
              JSON.stringify(last.content).includes("launch-root")
            ) {
              return call("start_work", {
                agent: "parent",
                title: "Parent",
                brief: "Discover skills and delegate to leaf.",
              });
            }
            return fauxAssistantMessage(
              last?.role === "toolResult" ? "STARTED" : "REPORTED",
            );
          }
          if (last?.role === "toolResult") {
            if (last.toolName === "list_skills") {
              lists.set(role, JSON.stringify(last));
              return role === "parent"
                ? call("start_work", {
                    agent: "leaf",
                    title: "Leaf",
                    brief: "Discover and read the guide if assigned.",
                  })
                : call("read_skill", { skill: "guide" });
            }
            if (last.toolName === "read_skill") {
              readResult = JSON.stringify(last);
              return fauxAssistantMessage("LEAF REPORT");
            }
            return fauxAssistantMessage("WAITING");
          }
          if (
            role === "parent" &&
            JSON.stringify(last?.content).includes("Child Work")
          ) {
            return fauxAssistantMessage("PARENT REPORT");
          }
          return call("list_skills", {});
        }),
      );
      const core = await openKaeno({
        ...config,
        storage: new MemoryStorage(),
        models,
      });
      try {
        const id = await core.threads.getOrCreateConversation("worker-skills");
        const task = await core.harness.commit(
          (tx) => core.turns.admitUserTurn(tx, id, "launch-root", "root"),
          context,
        );
        await core.harness.waitForTask(task, context);
        await vi.waitFor(
          async () => {
            expect(
              (await core.turns.readReplies(id, 0)).replies.some(
                (reply) => reply.text === "REPORTED",
              ),
            ).toBe(true);
          },
          { timeout: 5000 },
        );
        expect(lists.size).toBe(2);
        expect(lists.get("parent")).toContain('"text":"[]"');
        if (assigned) {
          expect(lists.get("leaf")).toContain("global:guide");
          expect(lists.get("leaf")).toContain("Guide description");
          expect(readResult).toContain("GUIDE INSTRUCTIONS");
        } else {
          expect(lists.get("leaf")).toContain('"text":"[]"');
          expect(readResult).toContain("skill not assigned: guide");
        }
        expect(lists.get("leaf")).not.toContain("hidden");
        expect(lists.get("leaf")).not.toContain("secret");
        expect(lists.get("leaf")).not.toContain("INSTRUCTIONS");
        expect(prompts.size).toBe(3);
        for (const prompt of prompts.values()) {
          expect(prompt).toContain("Use list_skills");
          expect(prompt).toContain("Use read_skill");
          expect(prompt).not.toContain("global:guide");
          expect(prompt).not.toContain("GUIDE INSTRUCTIONS");
        }
        const conversations = await core.harness.commit(
          (tx) => tx.scanConversations({}, 100),
          context,
        );
        expect(conversations.items).toHaveLength(3);
        for (const conversation of conversations.items) {
          expect(
            (await core.harness.snapshot(AgentDoc, conversation.id, context))
              ?.tools,
          ).toEqual(expect.arrayContaining(["list_skills", "read_skill"]));
        }
      } finally {
        await core.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
