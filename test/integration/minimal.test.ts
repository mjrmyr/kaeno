import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { AgentDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openKaeno, type Kaeno } from "../../src/core/application/index.ts";

it("reopens a core-only native conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-minimal-"));
  let core: Kaeno | undefined;
  const open = async () =>
    openKaeno({
      storage: await openNodeSqliteStorage(join(directory, "core.sqlite")),
      models: createModels(),
      assistant: {
        model: { provider: "openai", modelId: "example" },
        instructions: "Be helpful",
      },
    });
  try {
    core = await open();
    const id = await core.threads.getOrCreateConversation("minimal");
    const binding = await core.harness.snapshot(AgentDoc, id, context);
    expect(binding).toMatchObject({ tools: [], instructions: "Be helpful" });
    await core.close();
    core = await open();
    expect(await core.threads.getOrCreateConversation("minimal")).toBe(id);
    expect(await core.harness.snapshot(AgentDoc, id, context)).toEqual(binding);
    expect((await core.harness.inspect(context)).scheduling).toBe("running");
  } finally {
    await core?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
