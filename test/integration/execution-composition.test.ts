import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  loadExecution,
  parseEnvironmentConfiguration,
  type ExecutionConfiguration,
} from "../../src/host/composition/index.ts";
import { dockerExecutionProvider } from "../../src/extensions/docker/index.ts";
import { kubernetesExecutionProvider } from "../../src/extensions/kubernetes/index.ts";
import { microsandboxExecutionProvider } from "../../src/extensions/microsandbox/index.ts";

const providers = [
  dockerExecutionProvider,
  kubernetesExecutionProvider,
  microsandboxExecutionProvider,
];

it("installs and configures providers without loading the native SDK", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-execution-sdk-"));
  try {
    const configFile = join(directory, "backend.json");
    await writeFile(configFile, "{}");
    const script = `
      import { registerHooks } from "node:module";
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === "microsandbox") throw new Error("Native SDK must stay unloaded");
        return next(specifier, context);
      }});
      const { loadExecution } = await import(${JSON.stringify(resolve("src/host/composition/index.ts"))});
      const { dockerExecutionProvider } = await import(${JSON.stringify(resolve("src/extensions/docker/index.ts"))});
      const { kubernetesExecutionProvider } = await import(${JSON.stringify(resolve("src/extensions/kubernetes/index.ts"))});
      const { microsandboxExecutionProvider } = await import(${JSON.stringify(resolve("src/extensions/microsandbox/index.ts"))});
      const installed = [dockerExecutionProvider, kubernetesExecutionProvider, microsandboxExecutionProvider];
      for (const provider of ["docker", "microsandbox"]) {
        await loadExecution({provider, configFile: process.argv[1]}, "db.sqlite", installed);
      }
      console.log("Configured without native SDK");
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script, configFile],
      { timeout: 10_000 },
    );
    expect(stdout).toContain("Configured without native SDK");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("constructs interchangeable installed backends with native extensions and stable target identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-execution-config-"));
  const load = (config: ExecutionConfiguration, databaseFile: string) =>
    loadExecution(config, databaseFile, providers);
  try {
    const configFile = join(directory, "config.json");
    const databaseFile = join(directory, "db.sqlite");
    const base = { sourceDirectory: "sources", kaeno: "local:kaeno" };
    const dockerConfig = parseEnvironmentConfiguration(
      base,
      configFile,
    ).execution;
    await writeFile(join(directory, "docker.json"), "{}");
    const docker = await load(dockerConfig, databaseFile);
    const repeated = await load(dockerConfig, databaseFile);
    const otherDatabase = await load(
      dockerConfig,
      join(directory, "other.sqlite"),
    );
    expect(docker.environment.cwd).toBe("/workspace");
    expect(docker.extensions).toEqual([]);
    expect(docker.environment.identity).toBe(repeated.environment.identity);
    expect(docker.environment.identity).not.toBe(
      otherDatabase.environment.identity,
    );
    await writeFile(
      join(directory, "docker-owner.json"),
      JSON.stringify({
        namespace: "owner",
        image: "worker:v2",
        cpus: 2,
        memoryBytes: 536870912,
      }),
    );
    const explicit = parseEnvironmentConfiguration(
      {
        ...base,
        execution: { provider: "docker", configFile: "docker-owner.json" },
      },
      configFile,
    ).execution;
    const owned = await load(explicit, databaseFile);
    expect(owned.environment.identity).toBe(
      (await load(explicit, "another-db")).environment.identity,
    );

    await writeFile(join(directory, "microsandbox.json"), "{}");
    const vmConfig = parseEnvironmentConfiguration(
      {
        ...base,
        execution: {
          provider: "microsandbox",
          configFile: "microsandbox.json",
        },
      },
      configFile,
    ).execution;
    const microvm = await load(vmConfig, databaseFile);
    expect(microvm.environment.cwd).toBe(docker.environment.cwd);
    expect(microvm.extensions).toEqual([]);
    expect(microvm.environment.identity).not.toBe(docker.environment.identity);
    expect(microvm.environment.identity).toBe(
      (await load(vmConfig, databaseFile)).environment.identity,
    );
    expect(microvm.environment.identity).not.toBe(
      (await load(vmConfig, join(directory, "other.sqlite"))).environment
        .identity,
    );
    await writeFile(
      join(directory, "microsandbox.json"),
      JSON.stringify({ namespace: "owner", cpus: 1.5, memoryBytes: 536870912 }),
    );
    expect((await load(vmConfig, databaseFile)).environment.identity).toBe(
      (await load(vmConfig, "another-db")).environment.identity,
    );

    await writeFile(
      join(directory, "cluster.json"),
      JSON.stringify({
        namespace: "kaeno",
        owner: "personal",
        image: "worker:v1",
        caFile: null,
        resources: {
          requests: { cpu: "100m", memory: "128Mi" },
          limits: { cpu: "1", memory: "1Gi" },
        },
      }),
    );
    const kubernetesConfig = parseEnvironmentConfiguration(
      {
        ...base,
        execution: { provider: "kubernetes", configFile: "cluster.json" },
      },
      configFile,
    ).execution;
    const kubernetes = await load(kubernetesConfig, databaseFile);
    expect(kubernetes.environment.cwd).toBe(docker.environment.cwd);
    expect(kubernetes.environment.identity).not.toBe(
      docker.environment.identity,
    );
    expect(kubernetes.environment.identity).not.toBe(
      microvm.environment.identity,
    );
    expect(kubernetes.environment.identity).toBe(
      (await load(kubernetesConfig, databaseFile)).environment.identity,
    );
    expect(
      kubernetes.extensions.map((extension) => extension.durable.name),
    ).toEqual(["kaeno-kubernetes"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
