import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadDockerConfiguration } from "./index.ts";

const roots: string[] = [];
const context = {
  defaultNamespace: "application",
  createEnvironment: () => {
    throw new Error("Loading configuration must not execute work");
  },
};
async function configFile(settings: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kaeno-docker-config-"));
  roots.push(root);
  const path = join(root, "docker.json");
  await writeFile(path, JSON.stringify(settings));
  return path;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { cpus: 0 },
  { memoryBytes: -1 },
  { namespace: "bad namespace" },
  { image: "" },
  { unexpected: true },
])(
  "owns strict validation of its configuration file (%j)",
  async (settings) => {
    await expect(
      loadDockerConfiguration(await configFile(settings), context),
    ).rejects.toThrow();
  },
);

it("rejects missing and malformed files without falling back to defaults", async () => {
  const path = await configFile({});
  await rm(path);
  await expect(loadDockerConfiguration(path, context)).rejects.toThrow(
    "ENOENT",
  );
  await writeFile(path, "not json");
  await expect(loadDockerConfiguration(path, context)).rejects.toThrow(
    SyntaxError,
  );
});

it("constructs the common configured result with extension-owned defaults and host-supplied dependencies", async () => {
  const configured = await loadDockerConfiguration(
    await configFile({}),
    context,
  );
  expect(configured.extensions).toEqual([]);
  expect(configured.environment.cwd).toBe("/workspace");
  expect(JSON.parse(configured.environment.identity)).toEqual({
    provider: "docker",
    namespace: "application",
    apiHost: "127.0.0.1",
  });

  const explicit = await loadDockerConfiguration(
    await configFile({
      namespace: "owner",
      apiHost: "sandbox-host",
      image: "worker:v2",
      cpus: 2,
      memoryBytes: 536870912,
    }),
    context,
  );
  expect(JSON.parse(explicit.environment.identity)).toEqual({
    provider: "docker",
    namespace: "owner",
    apiHost: "sandbox-host",
  });
});
