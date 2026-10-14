import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  ENVD_LOG_FILE,
  WORKSPACE_MANIFEST_FILE,
  collectArtifacts,
  type RunIdentity,
} from "../../src/artifacts/index.ts";
import {
  EnvironmentServer,
  RemoteExecutionEnv,
  type CaptureRootMapping,
} from "../../src/execution/index.ts";
import { serverPort } from "./values.ts";

const token = "t".repeat(40);
const servers: EnvironmentServer["server"][] = [];

async function startServer(capture: {
  roots: readonly CaptureRootMapping[];
  capBytes: number;
  root: string;
}): Promise<string> {
  const server = new EnvironmentServer(
    token,
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

describe("run artifact collection over envd", () => {
  it("captures evidence, records symlinks without following, prunes blacklisted trees and logs requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaeno-collect-"));
    try {
      await mkdir(join(root, "workspace/src"), { recursive: true });
      await mkdir(join(root, "workspace/node_modules/pkg"), {
        recursive: true,
      });
      await mkdir(join(root, "workspace/.git"), { recursive: true });
      await mkdir(join(root, "home"), { recursive: true });
      await writeFile(join(root, "workspace/src/main.ts"), "hello");
      await writeFile(
        join(root, "workspace/node_modules/pkg/index.js"),
        "junk",
      );
      await writeFile(join(root, "workspace/.git/config"), "junk");
      await writeFile(join(root, "home/.bashrc"), "export EDITOR=vi\n");
      const big = Buffer.alloc(300_000, 7);
      await writeFile(join(root, "workspace/big.bin"), big);
      await symlink(join(root, "secret"), join(root, "workspace/link"));
      const roots: CaptureRootMapping[] = [
        { name: "workspace", dir: join(root, "workspace") },
        { name: "home", dir: join(root, "home") },
      ];
      const url = await startServer({
        roots,
        capBytes: 64 * 1024 * 1024,
        root: join(root, "workspace"),
      });
      const env = new RemoteExecutionEnv(
        url,
        token,
        "collect-pod",
        join(root, "workspace"),
        fetch,
      );
      await env.exists("/workspace", BACKGROUND_CONTEXT);

      const store = new ArtifactStore(join(root, "artifacts"));
      const identity: RunIdentity = { workId: 7, taskId: 3 };
      const handle = await store.createRun(identity, {
        conversationId: 12,
        pod: "collect-pod",
        template: "swe",
      });
      await collectArtifacts(env, handle);
      await handle.finish();

      const files = await store.list(identity);
      expect(files).toContain("workspace/src/main.ts");
      expect(files).toContain("workspace/big.bin");
      expect(files).toContain("home/.bashrc");
      expect(files).toContain(ENVD_LOG_FILE);
      expect(files).toContain(WORKSPACE_MANIFEST_FILE);
      expect(files.filter((path) => path.includes("node_modules"))).toEqual([]);
      expect(files.filter((path) => path.includes(".git/"))).toEqual([]);

      const main = await store.readFile(identity, "workspace/src/main.ts");
      expect(Buffer.from(main).toString("utf8")).toBe("hello");
      const capturedBig = await store.readFile(identity, "workspace/big.bin");
      expect(Buffer.compare(Buffer.from(capturedBig), big)).toBe(0);

      const manifestText = Buffer.from(
        await store.readFile(identity, WORKSPACE_MANIFEST_FILE),
      ).toString("utf8");
      expect(manifestText).toContain("workspace/src/main.ts");
      expect(manifestText).toContain(
        `symlink\tworkspace/link -> ${join(root, "secret")}`,
      );
      expect(manifestText).not.toContain("node_modules");

      const logText = Buffer.from(
        await store.readFile(identity, ENVD_LOG_FILE),
      ).toString("utf8");
      const entries = logText
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(
        entries.some(
          (entry) =>
            entry.route === "/call" && entry.op === "exists" && entry.ms >= 0,
        ),
      ).toBe(true);
      expect(
        entries.some(
          (entry) =>
            entry.route === "/collect" && entry.op === "collect" && !entry.ms,
        ),
      ).toBe(true);

      const manifest = await store.readManifest(identity);
      expect(manifest.capture.skippedByBlacklist).toBe(2);
      expect(manifest.capture.truncated).toBe(false);
      expect(manifest.envdLog).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops at the cap and records truncation, tolerating missing roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaeno-collect-"));
    try {
      await mkdir(join(root, "workspace"), { recursive: true });
      await writeFile(join(root, "workspace/a.txt"), "a".repeat(100));
      await writeFile(join(root, "workspace/z.bin"), "z".repeat(1024 * 1024));
      const roots: CaptureRootMapping[] = [
        { name: "workspace", dir: join(root, "workspace") },
        { name: "home", dir: join(root, "home") },
      ];
      const url = await startServer({
        roots,
        capBytes: 4096,
        root: join(root, "workspace"),
      });
      const env = new RemoteExecutionEnv(
        url,
        token,
        "cap-pod",
        join(root, "workspace"),
        fetch,
      );
      const store = new ArtifactStore(join(root, "artifacts"));
      const identity: RunIdentity = { workId: 8, taskId: 5 };
      const handle = await store.createRun(identity, {
        conversationId: 12,
        pod: "cap-pod",
        template: "swe",
      });
      await collectArtifacts(env, handle);
      await handle.finish();

      const files = await store.list(identity);
      expect(files).toContain("workspace/a.txt");
      expect(files).toContain(ENVD_LOG_FILE);
      expect(files).not.toContain("workspace/z.bin");
      const manifest = await store.readManifest(identity);
      expect(manifest.capture.truncated).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
