import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openKaeno } from "../../src/core/application/index.ts";
import { loadEnvironment } from "../../src/host/composition/index.ts";
import { receive, until } from "../mocks/router.ts";

it.each([{ withSkill: false }, { withSkill: true }])(
  "boots and executes work with no agent definitions (skills: $withSkill)",
  async ({ withSkill }) => {
    const root = await mkdtemp(join(tmpdir(), "kaeno-no-agents-"));
    try {
      if (withSkill) {
        await mkdir(join(root, "skills/verify"), { recursive: true });
        await writeFile(
          join(root, "skills/verify/SKILL.md"),
          "---\nname: verify\ndescription: Verify evidence\n---\nSKILL_SNAPSHOT_PROOF",
        );
      }
      const configFile = join(root, "config.json");
      await writeFile(
        configFile,
        JSON.stringify({
          sourceDirectory: "./sources",
          defaultModel: "faux/faux-1",
          ...(withSkill
            ? {
                localDefinitions: {
                  skills: [{ alias: "local", directory: "./skills" }],
                },
              }
            : {}),
        }),
      );
      const configuration = await loadEnvironment({ configFile });
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      let accepted = false;
      let workerRan = false;
      let readSnapshot = false;
      faux.setResponses(
        Array.from({ length: 30 }, () => async (request) => {
          const prompt = getCurrentSystemPrompt(request.messages);
          if (prompt.includes("You are Kaeno WORK")) {
            workerRan = true;
            const last = request.messages.findLast(
              (message) => message.role !== "system",
            );
            if (withSkill && last?.role === "user") {
              return fauxAssistantMessage(
                [fauxToolCall("read_skill", { skill: "local:verify" })],
                { stopReason: "toolUse" },
              );
            }
            if (last?.role === "toolResult" && last.toolName === "read_skill") {
              readSnapshot =
                !last.isError &&
                JSON.stringify(last.content).includes("SKILL_SNAPSHOT_PROOF");
            }
            return fauxAssistantMessage("Verified generic worker result.");
          }
          if (!accepted) {
            accepted = true;
            return fauxAssistantMessage(
              [
                fauxToolCall("route", {
                  items: [
                    {
                      trigger: "t1",
                      kind: "accept",
                      title: "Verification",
                      ack: "I will verify it.",
                    },
                  ],
                }),
              ],
              { stopReason: "toolUse" },
            );
          }
          return fauxAssistantMessage("");
        }),
      );
      const core = await openKaeno({
        storage: new MemoryStorage(),
        models,
        assistant: configuration.assistant,
        extensions: configuration.extensions,
        work: configuration.work,
      });
      try {
        await receive(core, "Verify the result using available skills.");
        await until(async () => {
          const tasks = await core.harness.commit(
            async (tx) =>
              (await tx.scanTasks({ kind: "kaeno.work" }, 10)).items,
            context,
          );
          return (
            tasks.length === 1 &&
            tasks.every((task) => task.state.status === "terminal")
          );
        }, "generic work admitted and finished");
        expect(workerRan).toBe(true);
        expect(readSnapshot).toBe(withSkill);
        expect((await core.router.ticket("k1", context)).agent).toBe(
          "kaeno:worker",
        );
        expect(configuration.diagnostics).toEqual([]);
      } finally {
        await core.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
