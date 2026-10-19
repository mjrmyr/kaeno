import { expect, it, vi } from "vitest";
import { loadExecution } from "./index.ts";
import type {
  ConfiguredExecution,
  ExecutionConfigurationLoader,
} from "../../extensions/execution/index.ts";

const configured: ConfiguredExecution = {
  environment: {
    identity: "custom:target",
    cwd: "/workspace",
    ensure: async () => {},
    release: async () => {},
    reconcile: async () => {},
    executionEnvironment: async () => undefined,
  },
  extensions: [],
};

it.each(["custom-remote", "__proto__", "constructor"])(
  "resolves an explicitly installed provider named %s",
  async (name) => {
    const loader = vi.fn<ExecutionConfigurationLoader>(async () => configured);
    const result = await loadExecution(
      { provider: name, configFile: "/owner/custom.json" },
      "db.sqlite",
      [{ name, loadConfiguration: loader }],
    );
    expect(result).toBe(configured);
    expect(loader).toHaveBeenCalledExactlyOnceWith("/owner/custom.json", {
      defaultNamespace: expect.stringMatching(/^[a-f0-9]{16}$/),
      createSandboxEnvironment: expect.any(Function),
      createEnvironment: expect.any(Function),
    });
  },
);

it.each(["missing", "docker", "toString"])(
  "rejects uninstalled provider %s without invoking a loader",
  async (name) => {
    const loader = vi.fn<ExecutionConfigurationLoader>(async () => configured);
    await expect(
      loadExecution(
        { provider: name, configFile: "/owner/custom.json" },
        "db.sqlite",
        [{ name: "custom", loadConfiguration: loader }],
      ),
    ).rejects.toThrow(
      `Unknown execution provider "${name}". Installed: custom.`,
    );
    expect(loader).not.toHaveBeenCalled();
  },
);

it("reports an empty installation rather than implicitly installing Docker", async () => {
  await expect(
    loadExecution(
      { provider: "docker", configFile: "/owner/docker.json" },
      "db.sqlite",
      [],
    ),
  ).rejects.toThrow('Unknown execution provider "docker". Installed: (none).');
});

it("rejects duplicate registrations before loading provider configuration", async () => {
  const loader = vi.fn<ExecutionConfigurationLoader>(async () => configured);
  const provider = { name: "custom", loadConfiguration: loader };
  await expect(
    loadExecution(
      { provider: "custom", configFile: "/owner/custom.json" },
      "db.sqlite",
      [provider, provider],
    ),
  ).rejects.toThrow('Duplicate execution provider "custom"');
  expect(loader).not.toHaveBeenCalled();
});

it("preserves extension-owned configuration failures without falling back", async () => {
  const error = new Error("Invalid custom provider settings");
  const loader = vi.fn<ExecutionConfigurationLoader>(async () => {
    throw error;
  });
  await expect(
    loadExecution(
      { provider: "custom", configFile: "/owner/custom.json" },
      "db.sqlite",
      [{ name: "custom", loadConfiguration: loader }],
    ),
  ).rejects.toBe(error);
});
