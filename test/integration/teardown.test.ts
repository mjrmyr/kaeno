import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactStore,
  ENVD_LOG_FILE,
  POD_LOG_FILE,
  WORKSPACE_MANIFEST_FILE,
  WORKSPACE_ROOT,
  type CaptureTransport,
  type RunIdentity,
} from "../../src/artifacts/index.ts";
import {
  EnvironmentServer,
  RemoteExecutionEnv,
  type CaptureFrame,
  type CaptureRootMapping,
} from "../../src/execution/index.ts";
import {
  SandboxCapacity,
  SandboxManager,
  sandboxPod,
  type EnvironmentFactory,
  type ManagedSandbox,
  type Pod,
  type SandboxCapture,
  type SandboxClient,
  type SandboxRuntime,
  DEFAULT_SANDBOX_RESOURCES,
} from "../../src/sandboxes/index.ts";
import { createMockRuntime } from "../mocks/durable.ts";
import {
  createPod,
  namespace,
  resetCluster,
  runningPods,
} from "./sandbox-fixture.ts";
import * as k8s from "./sandbox-fixture.ts";
import { serverPort } from "./values.ts";

const envdToken = "e".repeat(40);
const servers: EnvironmentServer["server"][] = [];

async function startEnvd(capture: {
  roots: readonly CaptureRootMapping[];
  capBytes: number;
  root: string;
}): Promise<string> {
  const server = new EnvironmentServer(
    envdToken,
    (cwd) => new NodeExecutionEnv({ cwd }),
    capture.root,
    { roots: capture.roots, capBytes: capture.capBytes },
  ).server;
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${serverPort(server)}`;
}
afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

interface Rig {
  root: string;
  manager: SandboxManager;
  store: ArtifactStore;
  pod: string;
  capture: SandboxCapture;
}

async function startRig(
  factory: (url: string) => EnvironmentFactory,
): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), "kaeno-teardown-"));
  const url = await startEnvd({
    roots: [
      { name: "workspace", dir: join(root, "workspace") },
      { name: "home", dir: join(root, "home") },
    ],
    capBytes: 64 * 1024 * 1024,
    root: join(root, "workspace"),
  });
  // Call-time indirection through the module namespace: vi.spyOn on the fixture
  // must be visible to the manager under test.
  const client: SandboxClient = {
    namespace,
    getPod: (name) => k8s.getPod(name),
    createPod: (pod) => k8s.createPod(pod),
    deletePod: (name) => k8s.deletePod(name),
    listSandboxPods: () => k8s.listSandboxPods(),
    getPodLog: (name) => k8s.getPodLog(name),
    readSandboxQuota: () => k8s.readSandboxQuota(),
  };
  const harness = (): SandboxRuntime => ({ getTask: async () => undefined });
  const capacity = new SandboxCapacity(() => createMockRuntime(), client);
  const store = new ArtifactStore(join(root, "artifacts"));
  const manager = new SandboxManager(
    harness,
    client,
    capacity,
    factory(url),
    store,
  );
  const pod = "kaeno-sb-rig1";
  await createPod(
    sandboxPod(
      {
        name: pod,
        token: envdToken,
        images: { execution: "sandbox:1" },
        skillCacheClaim: "claim",
        skills: [],
        conversationId: "7",
        taskId: "5",
        template: "swe",
        resources: DEFAULT_SANDBOX_RESOURCES,
      },
      namespace,
    ),
  );
  const capture: SandboxCapture = {
    identity: { workId: 5, taskId: 5 },
    header: { conversationId: 7, pod, template: "swe" },
  };
  return { root, manager, store, pod, capture };
}

const brokenCaptureFactory = (): EnvironmentFactory => ({
  createEnvironment: () => {
    throw new Error("unexpected environment use");
  },
  createCaptureEnvironment: (): CaptureTransport => ({
    async *collect(): AsyncGenerator<CaptureFrame> {
      yield {
        type: "file",
        target: "workspace/half.txt",
        size: 4,
        mode: 0o100644,
        mtimeMs: 1,
      };
      yield {
        type: "chunk",
        target: "workspace/half.txt",
        data: Buffer.from("half").toString("base64"),
      };
    },
  }),
});

function text(
  store: ArtifactStore,
  identity: RunIdentity,
  path: string,
): Promise<string> {
  return store
    .readFile(identity, path)
    .then((content) => Buffer.from(content).toString("utf8"));
}

beforeEach(() => {
  resetCluster();
});

describe("sandbox teardown artifact collection", () => {
  it("collects evidence before deleting the pod and releasing capacity", async () => {
    const factory = (url: string): EnvironmentFactory => ({
      createEnvironment: (pod, token, cwd) =>
        new RemoteExecutionEnv(url, token, `pod:${pod}`, cwd, fetch),
      createCaptureEnvironment: (pod, token, cwd) =>
        new RemoteExecutionEnv(url, token, `capture:${pod}`, cwd, fetch),
    });
    const rig = await startRig(factory);
    try {
      await mkdir(join(rig.root, "workspace/src"), { recursive: true });
      await writeFile(join(rig.root, "workspace/src/main.ts"), "hello");
      const sandbox: ManagedSandbox = {
        pod: rig.pod,
        token: envdToken,
        images: { execution: "sandbox:1" },
        skillCacheClaim: "claim",
      };
      const env = rig.manager.getExecutionEnvironment(sandbox, WORKSPACE_ROOT);
      await env.exists(WORKSPACE_ROOT, BACKGROUND_CONTEXT);

      await rig.manager.removeSandbox(rig.pod, rig.capture);

      expect(runningPods()).toEqual([]);
      const files = await rig.store.list(rig.capture.identity);
      expect(files).toContain(POD_LOG_FILE);
      expect(files).toContain(ENVD_LOG_FILE);
      expect(files).toContain("workspace/src/main.ts");
      expect(files).toContain(WORKSPACE_MANIFEST_FILE);
      expect(await text(rig.store, rig.capture.identity, POD_LOG_FILE)).toBe(
        `sandbox container log for ${rig.pod}\n`,
      );
      const manifest = await rig.store.readManifest(rig.capture.identity);
      expect(manifest.finishedAt).not.toBeNull();
      expect(manifest.envdLog).toBe(true);
      expect(manifest.podLog).toBe(true);
      expect(manifest.capture.truncated).toBe(false);
      const entries = (
        await text(rig.store, rig.capture.identity, ENVD_LOG_FILE)
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      // cleanup posts no method, so its op is the empty string.
      expect(entries.map((entry) => entry.op)).toEqual([
        "exists",
        "",
        "collect",
      ]);
    } finally {
      await rm(rig.root, { recursive: true, force: true });
    }
  });

  it("records the failure and still deletes the pod when the capture stream dies", async () => {
    const rig = await startRig(brokenCaptureFactory);
    try {
      await rig.manager.removeSandbox(rig.pod, rig.capture);
      expect(runningPods()).toEqual([]);
      const manifest = await rig.store.readManifest(rig.capture.identity);
      expect(manifest.capture.error).toContain("without a stat frame");
      expect(manifest.finishedAt).not.toBeNull();
      const files = await rig.store.list(rig.capture.identity);
      expect(files).toContain(POD_LOG_FILE);
      expect(files).not.toContain("workspace/half.txt");
      expect(files).not.toContain(ENVD_LOG_FILE);
    } finally {
      await rm(rig.root, { recursive: true, force: true });
    }
  });

  it("orphan sweep collects pods that exist and records nothing for pods already gone", async () => {
    const factory = (url: string): EnvironmentFactory => ({
      createEnvironment: (pod, token, cwd) =>
        new RemoteExecutionEnv(url, token, `pod:${pod}`, cwd, fetch),
      createCaptureEnvironment: (pod, token, cwd) =>
        new RemoteExecutionEnv(url, token, `capture:${pod}`, cwd, fetch),
    });
    const rig = await startRig(factory);
    try {
      await mkdir(join(rig.root, "workspace"), { recursive: true });
      await writeFile(join(rig.root, "workspace/note.txt"), "evidence");
      // A pod visible to the sweep listing but already gone from the cluster.
      const ghost: Pod = {
        metadata: {
          name: "kaeno-sb-ghost",
          annotations: {
            "kaeno.io/conversation": "9",
            "kaeno.io/task": "9",
          },
          labels: { "kaeno.io/template": "swe" },
        },
      };
      vi.spyOn(k8s, "listSandboxPods").mockImplementationOnce(async () => [
        ...(await k8s.listSandboxPods()),
        ghost,
      ]);
      await rig.manager.sweepOrphanedSandboxes();

      expect(runningPods()).toEqual([]);
      const files = await rig.store.list(rig.capture.identity);
      expect(files).toContain("workspace/note.txt");
      expect(files).toContain(ENVD_LOG_FILE);
      await expect(
        rig.store.readManifest({ workId: 9, taskId: 9 }),
      ).rejects.toThrow();
    } finally {
      await rm(rig.root, { recursive: true, force: true });
    }
  });
});
