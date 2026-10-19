import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openKaeno } from "../../src/core/application/index.ts";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  parseAgent,
  resolveAgents,
} from "../../src/extensions/agents/index.ts";
import { SandboxWorkEnvironment } from "../../src/extensions/docker/index.ts";
import type { SandboxProvider } from "../../src/extensions/docker/index.ts";

it("offers and launches every configured worker even when none delegate to each other", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-templates-"));
  const names = ["easy", "medium", "high"];
  const agents = resolveAgents({
    agents: names.map((name) =>
      parseAgent(
        `---\nname: ${name}\ndescription: ${name} independent worker\nmodel: openai/faux-1\n---\nComplete work as ${name}.`,
        "local",
        name,
      ),
    ),
    defaults: { tools: [] },
  });
  const faux = fauxProvider({ provider: "openai" });
  const models = createModels();
  models.setProvider(faux.provider);
  const workerPrompts: string[] = [];
  faux.setResponses(
    Array.from({ length: 30 }, () => async (request) => {
      const system = getCurrentSystemPrompt(request.messages);
      if (system.includes("You are Kaeno WORK")) {
        workerPrompts.push(system);
        return fauxAssistantMessage("Verified worker result.");
      }
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      const name = names.find((candidate) =>
        JSON.stringify(last?.content).includes(`launch:${candidate}`),
      );
      if (last?.role === "user" && name) {
        return fauxAssistantMessage(
          [
            fauxToolCall("start_work", {
              agent: name,
              title: `Run ${name}`,
              brief: "Complete this independent task.",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage(
        last?.role === "toolResult" ? "STARTED" : "WORK_REPORT",
      );
    }),
  );
  const provisioned: string[] = [];
  const sandbox: SandboxProvider = {
    identity: "test:sandbox",
    ensure: async (identity) => {
      provisioned.push(identity.id);
    },
    executionEnvironment: async () => new NodeExecutionEnv({ cwd: directory }),
    remove: async () => {},
    reconcile: async () => {},
  };
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant: {
      model: { provider: "openai", modelId: "faux-1" },
      instructions: "Delegate the requested task.",
      tools: ["start_work"],
    },
    extensions: [{ durable: CodingTools }],
    work: {
      agents,
      tools: [],
      environment: new SandboxWorkEnvironment({
        sandbox,
        image: "sandbox:test",
        limits: { cpus: 1, memoryBytes: 268435456 },
      }),
      maxConcurrent: 3,
    },
  });
  try {
    for (const name of names) {
      const id = await core.threads.getOrCreateConversation(`test-${name}`);
      const binding = await core.harness.snapshot(AgentDoc, id, context);
      for (const choice of names) {
        expect(binding?.instructions).toContain(
          `- local:${choice}: ${choice} independent worker`,
        );
      }
      const task = await core.harness.commit(
        (tx) =>
          core.turns.admitUserTurn(tx, id, `launch:${name}`, `request-${name}`),
        context,
      );
      await core.harness.waitForTask(task, context);
      const deadline = Date.now() + 5000;
      while (
        !(await core.turns.readReplies(id, 0)).replies.some(
          (reply) => reply.text === "WORK_REPORT",
        ) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Only Kaeno's acknowledgment and summary reach the user-facing ledger;
      // "Verified worker result." is internal worker data, not a chat reply.
      expect(
        (await core.turns.readReplies(id, 0)).replies.map(
          (reply) => reply.text,
        ),
      ).toEqual(["STARTED", "WORK_REPORT"]);
    }
    expect(provisioned).toHaveLength(3);
    expect(workerPrompts).toHaveLength(3);
    for (const name of names) {
      expect(
        workerPrompts.some((prompt) =>
          prompt.includes(`Complete work as ${name}.`),
        ),
      ).toBe(true);
    }
  } finally {
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
});
