import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExecutionConfigurationContext } from "../execution/index.ts";
import { loadMicrosandboxConfiguration } from "./index.ts";

const roots: string[] = [];
const createSandboxEnvironment = vi.fn<
  ExecutionConfigurationContext["createSandboxEnvironment"]
>(({ sandbox }) => ({
  identity: sandbox.identity,
  cwd: "/workspace",
  ensure: async () => {},
  release: async () => {},
  reconcile: async () => {},
  executionEnvironment: async () => undefined,
}));
const context: ExecutionConfigurationContext = {
  defaultNamespace: "application",
  createSandboxEnvironment,
  createEnvironment: () => {
    throw new Error("Configuration must not execute work");
  },
};
async function configFile(settings: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kaeno-microsandbox-config-"));
  roots.push(root);
  const path = join(root, "microsandbox.json");
  await writeFile(path, JSON.stringify(settings));
  return path;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each([
  { cpus: 0 },
  { memoryBytes: 0 },
  { memoryBytes: 1048575 },
  { memoryBytes: 1048576.5 },
  { namespace: "bad namespace" },
  { image: " " },
  { apiHost: "0.0.0.0" },
  { unexpected: true },
])("owns strict configuration validation (%j)", async (settings) => {
  await expect(
    loadMicrosandboxConfiguration(await configFile(settings), context),
  ).rejects.toThrow();
  expect(createSandboxEnvironment).not.toHaveBeenCalled();
});

it("rejects missing and malformed files", async () => {
  const path = await configFile({});
  await rm(path);
  await expect(loadMicrosandboxConfiguration(path, context)).rejects.toThrow(
    "ENOENT",
  );
  await writeFile(path, "not json");
  await expect(loadMicrosandboxConfiguration(path, context)).rejects.toThrow(
    SyntaxError,
  );
});

it("uses extension-owned defaults and a stable local store identity without booting a VM", async () => {
  const path = await configFile({});
  const loaded = await loadMicrosandboxConfiguration(path, context);
  expect(loaded.extensions).toEqual([]);
  expect(JSON.parse(loaded.environment.identity)).toEqual({
    provider: "microsandbox",
    namespace: "application",
    target: resolve(process.env.MSB_HOME ?? join(homedir(), ".microsandbox")),
  });
  expect(createSandboxEnvironment).toHaveBeenLastCalledWith({
    sandbox: expect.objectContaining({ identity: loaded.environment.identity }),
    image: "kaeno:local",
    limits: { cpus: 1, memoryBytes: 1073741824 },
  });
  vi.stubEnv("MSB_HOME", join(tmpdir(), "another-microsandbox-store"));
  expect(
    (await loadMicrosandboxConfiguration(path, context)).environment.identity,
  ).not.toBe(loaded.environment.identity);
});

it("passes explicit settings to the shared lifecycle adapter", async () => {
  const loaded = await loadMicrosandboxConfiguration(
    await configFile({
      namespace: "owner",
      image: "worker:v2",
      cpus: 1.5,
      memoryBytes: 536870912,
    }),
    context,
  );
  expect(JSON.parse(loaded.environment.identity).namespace).toBe("owner");
  expect(createSandboxEnvironment).toHaveBeenLastCalledWith({
    sandbox: expect.objectContaining({ identity: loaded.environment.identity }),
    image: "worker:v2",
    limits: { cpus: 1.5, memoryBytes: 536870912 },
  });
});
