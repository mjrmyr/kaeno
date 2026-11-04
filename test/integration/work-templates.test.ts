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
import {
  receive,
  replies,
  ROUTER_ASSISTANT_TOOLS,
  sinceLastAnswer,
  until,
} from "../mocks/router.ts";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  parseAgent,
  resolveAgents,
} from "../../src/extensions/agents/index.ts";
import {
  SandboxWorkEnvironment,
  type SandboxProvider,
} from "../../src/extensions/execution/index.ts";

it("offers and launches every configured worker even when none delegate to each other", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-templates-"));
  const names = ["easy", "medium", "high"];
  const agents = resolveAgents({
    agents: names.map((name) =>
      parseAgent(
        `---\nname: ${name}\ndescription: ${name} independent worker\nmodel: openai/faux-1\n---\nComplete work as ${name}.`,
        "local",
        `${name}.md`,
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
      if (last?.role === "toolResult") {
        return fauxAssistantMessage("ok");
      }
      const batch = sinceLastAnswer(request);
      const report = /<report ticket=\\"(k[0-9]+)\\"/.exec(batch);
      if (report) {
        return fauxAssistantMessage(
          [fauxToolCall("reply", { to: report[1], text: "WORK_REPORT" })],
          { stopReason: "toolUse" },
        );
      }
      const trigger = /<trigger id=\\"(t[0-9]+)\\"/.exec(batch);
      const name = names.find((candidate) =>
        batch.includes(`launch:${candidate}`),
      );
      if (trigger && name) {
        return fauxAssistantMessage(
          [
            fauxToolCall("route", {
              items: [
                {
                  trigger: trigger[1],
                  kind: "accept",
                  agent: name,
                  title: `Run ${name}`,
                  ack: "STARTED",
                },
              ],
            }),
          ],
          { stopReason: "toolUse" },
        );
      }
      throw new Error(`Unexpected router batch: ${batch}`);
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
      tools: [...ROUTER_ASSISTANT_TOOLS],
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
    const router = await core.router.routerConversation(context);
    const binding = await core.harness.snapshot(AgentDoc, router, context);
    for (const choice of names) {
      expect(binding?.instructions).toContain(
        `- local:${choice}: ${choice} independent worker`,
      );
    }
    for (const name of names) {
      const thread = `test-${name}`;
      await receive(core, `launch:${name}`, { thread });
      await until(
        async () =>
          (await replies(core, thread)).some(
            (reply) => reply.text === "WORK_REPORT",
          ),
        `the ${name} report`,
      );
      // Only Kaeno's acknowledgment and summary reach the owner;
      // "Verified worker result." is internal worker data, not a reply.
      expect((await replies(core, thread)).map((reply) => reply.text)).toEqual([
        "STARTED",
        "WORK_REPORT",
      ]);
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
