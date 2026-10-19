import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { loadEnvironment } from "../../src/host/composition/index.ts";

it("loads the credential-free image fixture on fresh durable storage, then offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaeno-infrastructure-fixture-"));
  try {
    await cp("scripts/fixtures/infrastructure", root, { recursive: true });
    const file = join(root, "environment.json");
    const configuration = JSON.parse(await readFile(file, "utf8"));
    // The image mounts /data; the Node-only test uses an isolated temporary directory.
    await writeFile(
      file,
      JSON.stringify({ ...configuration, sourceDirectory: "./definitions" }),
    );
    await expect(
      loadEnvironment({ configFile: file, sourceMode: "offline" }),
    ).rejects.toThrow("no verified complete offline input set");
    const loaded = await loadEnvironment({
      configFile: file,
      sourceMode: "refresh",
    });
    expect(loaded.assistant.model).toEqual({
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
    expect(loaded.work.agents).toEqual([]);
    expect(loaded.diagnostics).toEqual([]);
    const offline = await loadEnvironment({
      configFile: file,
      sourceMode: "offline",
    });
    expect(offline.assistant).toEqual(loaded.assistant);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
