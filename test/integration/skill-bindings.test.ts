import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  defineExtension,
  AgentDoc,
  MemoryStorage,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openKaeno, type Binding } from "../../src/core/application/index.ts";
import {
  SkillCatalog,
  skillBinder,
  skillsExtension,
} from "../../src/extensions/skills/index.ts";

function guideBinding(catalog: SkillCatalog): Binding {
  const binding = skillBinder(catalog)(["guide"]);
  if (!binding) {
    throw new Error("expected a skills binding");
  }
  return binding;
}

it("replays a pending CHAT with its original assigned skill without a catalog or WORK", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-skill-bindings-"));
  const path = join(directory, "db.sqlite");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: "faux", modelId: "faux-1" };
  const catalog = new SkillCatalog([
    {
      id: "home:guide",
      description: "Guide",
      disableModelInvocation: false,
      treeHash: "a".repeat(64),
      documents: {
        "SKILL.md": "ORIGINAL SKILL",
        "references/check.md": "ORIGINAL REFERENCE",
      },
    },
  ]);
  let conversation: ConversationId | undefined;
  try {
    await expect(
      openKaeno({
        storage: await openNodeSqliteStorage(path),
        models,
        assistant: {
          model,
          instructions: "Use your skill",
          tools: ["list_skills", "read_skill"],
          bindings: [guideBinding(catalog)],
        },
        extensions: [
          skillsExtension(),
          {
            durable: defineExtension({ name: "interrupt-startup" }),
            start: async (core) => {
              conversation =
                await core.threads.getOrCreateConversation("skill-test");
              const id = conversation;
              await core.harness.commit(
                (tx) =>
                  core.turns.admitUserTurn(
                    tx,
                    id,
                    "Read the guide",
                    "skill-request",
                  ),
                context,
              );
              throw new Error("Interrupted before scheduling");
            },
          },
        ],
      }),
    ).rejects.toThrow("Interrupted before scheduling");
    const originalId = conversation;
    if (originalId === undefined) {
      throw new Error("Expected conversation");
    }
    let observedSkill = "";
    let observedList = "";
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("list_skills", {})], {
        stopReason: "toolUse",
      }),
      async (request) => {
        observedList = JSON.stringify(
          request.messages.findLast((message) => message.role === "toolResult"),
        );
        return fauxAssistantMessage(
          [
            fauxToolCall("read_skill", {
              skill: "home:guide",
              file: "references/check.md",
            }),
          ],
          { stopReason: "toolUse" },
        );
      },
      async (request) => {
        observedSkill = JSON.stringify(request.messages);
        return fauxAssistantMessage("Read the original reference");
      },
    ]);
    // No agent factory, no skill catalog, no sources and no WORK. Only the catalog-free native reader.
    const core = await openKaeno({
      storage: await openNodeSqliteStorage(path),
      models,
      assistant: { model, instructions: "Future conversations", tools: [] },
      extensions: [skillsExtension()],
    });
    try {
      await vi.waitFor(async () => {
        expect(
          (await core.turns.readReplies(originalId, 0)).replies.map(
            (reply) => reply.text,
          ),
        ).toContain("Read the original reference");
      });
      expect(observedList).toContain("home:guide");
      expect(observedList).not.toContain("ORIGINAL SKILL");
      expect(observedList).not.toContain("ORIGINAL REFERENCE");
      expect(observedSkill).toContain("ORIGINAL REFERENCE");
    } finally {
      await core.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps explicit tools empty and presents assigned guidance inline without granting read_skill", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: "faux", modelId: "faux-1" };
  const catalog = new SkillCatalog([
    {
      id: "home:guide",
      description: "Guide",
      disableModelInvocation: false,
      treeHash: "b".repeat(64),
      documents: { "SKILL.md": "INLINE GUIDANCE" },
    },
  ]);
  let observed = "";
  faux.setResponses([
    async (request) => {
      observed = JSON.stringify(request.messages);
      return fauxAssistantMessage("DONE");
    },
  ]);
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant: {
      model,
      instructions: "Answer",
      tools: [],
      bindings: [guideBinding(catalog)],
    },
    extensions: [skillsExtension()],
  });
  try {
    const id = await core.threads.getOrCreateConversation("inline");
    const task = await core.harness.commit(
      (tx) => core.turns.admitUserTurn(tx, id, "Question", "inline-request"),
      context,
    );
    await core.harness.waitForTask(task, context);
    expect((await core.harness.snapshot(AgentDoc, id, context))?.tools).toEqual(
      [],
    );
    expect(observed).toContain("INLINE GUIDANCE");
    expect(observed).not.toContain("Use read_skill");
  } finally {
    await core.close();
  }
});
