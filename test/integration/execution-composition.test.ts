import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  loadExecution,
  parseEnvironmentConfiguration,
} from "../../src/host/composition/index.ts";

it.each([
  "KAENO_KUBERNETES_CONFIG",
  "KAENO_SANDBOX_NAMESPACE",
  "KAENO_SANDBOX_API_HOST",
  "KAENO_SANDBOX_IMAGE",
  "KAENO_WORK_CPUS",
  "KAENO_WORK_MEMORY_BYTES",
])(
  "rejects retired %s instead of silently choosing another configuration",
  async (name) => {
    await expect(
      promisify(execFile)(process.execPath, [resolve("src/host/main.ts")], {
        env: { ...process.env, [name]: "retired-setting" },
        timeout: 10000,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "is no longer supported; configure execution in KAENO_CONFIG instead",
      ),
    });
  },
);

it("constructs interchangeable backends with their native extensions and stable target identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-execution-config-"));
  try {
    const configFile = join(directory, "config.json");
    const databaseFile = join(directory, "db.sqlite");
    const base = { sourceDirectory: "sources", kaeno: "local:kaeno" };
    const dockerConfig = parseEnvironmentConfiguration(
      base,
      configFile,
    ).execution;
    await writeFile(join(directory, "docker.json"), "{}");
    const docker = await loadExecution(dockerConfig, databaseFile);
    const repeated = await loadExecution(dockerConfig, databaseFile);
    const otherDatabase = await loadExecution(
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
    const owned = await loadExecution(explicit, databaseFile);
    expect(owned.environment.identity).toBe(
      (await loadExecution(explicit, "another-db")).environment.identity,
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
    const kubernetes = await loadExecution(kubernetesConfig, databaseFile);
    expect(kubernetes.environment.cwd).toBe(docker.environment.cwd);
    expect(kubernetes.environment.identity).not.toBe(
      docker.environment.identity,
    );
    expect(kubernetes.environment.identity).toBe(
      (await loadExecution(kubernetesConfig, databaseFile)).environment
        .identity,
    );
    expect(
      kubernetes.extensions.map((extension) => extension.durable.name),
    ).toEqual(["kaeno-kubernetes"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
