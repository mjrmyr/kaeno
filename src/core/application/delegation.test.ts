import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage as answer,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { receive, until } from "../../../test/mocks/router.ts";
import { openKaeno } from "./index.ts";

it("routes and delegates to generic workers without agent arguments or catalogs", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const prompts: string[] = [];
  let routed = false;
  let delegated = false;
  faux.setResponses(
    Array.from({ length: 40 }, () => async (request) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      prompts.push(prompt);
      if (prompt.includes("You are Kaeno WORK")) {
        if (!delegated && prompt.includes("start_work")) {
          delegated = true;
          return answer(
            [
              fauxToolCall("start_work", {
                title: "Child",
                brief: "Verify the delegated result.",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        return answer("Verified result.");
      }
      if (!routed) {
        routed = true;
        return answer(
          [
            fauxToolCall("route", {
              items: [
                {
                  trigger: "t1",
                  kind: "accept",
                  title: "Job",
                  ack: "I will verify the result.",
                },
              ],
            }),
          ],
          { stopReason: "toolUse" },
        );
      }
      return answer("");
    }),
  );
  const model = { provider: "faux", modelId: "faux-1" };
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant: { model, instructions: "", tools: ["route", "reply"] },
    work: {
      setup: { model, instructions: "", tools: ["start_work"] },
      tools: ["start_work"],
      maxDepth: 2,
      maxConcurrent: 3,
    },
  });
  try {
    await receive(core, "Please verify this result.");
    await until(async () => {
      const works = await core.harness.commit(
        async (tx) => (await tx.scanTasks({ kind: "kaeno.work" }, 10)).items,
        context,
      );
      return (
        works.length === 2 &&
        works.every((record) => record.state.status === "terminal")
      );
    }, "both generic workers to finish");
    const ticket = await core.router.ticket("k1", context);
    expect(ticket.agent).toBe("kaeno:worker");
    const works = await core.harness.commit(
      async (tx) => (await tx.scanTasks({ kind: "kaeno.work" }, 10)).items,
      context,
    );
    for (const record of works) {
      expect(record.input).toMatchObject({ agent: "kaeno:worker" });
      expect(record.input).toHaveProperty("plan", {
        root: "kaeno:worker",
        participants: {
          "kaeno:worker": {
            id: "kaeno:worker",
            description: "General-purpose worker",
            setup: { model, instructions: "", tools: ["start_work"] },
          },
        },
      });
    }
    expect(
      prompts.some((prompt) => prompt.includes("generic child workers")),
    ).toBe(true);
    expect(prompts.join("\n")).not.toMatch(
      /Agents you can start|Agents for tickets|Pick an agent/,
    );
  } finally {
    await core.close();
  }
}, 15000);
