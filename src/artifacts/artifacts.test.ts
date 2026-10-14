import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../skills/index.ts", () => ({
  SKILL_ROOT: "/workspace/.agents/skills",
}));
import {
  ArtifactStore,
  ENVD_LOG_FILE,
  MANIFEST_FILE,
  isBlacklisted,
  parseManifest,
  type RunIdentity,
} from "./index.ts";

describe("blacklist", () => {
  it("excludes dependency and tool caches at any depth", () => {
    expect(isBlacklisted("/workspace/node_modules/react/index.js")).toBe(true);
    expect(isBlacklisted("/workspace/packages/app/node_modules")).toBe(true);
    expect(isBlacklisted("/workspace/.venv/lib/python3/site")).toBe(true);
    expect(isBlacklisted("/workspace/app/__pycache__/main.pyc")).toBe(true);
    expect(isBlacklisted("/home/agent/.cache/pip/http")).toBe(true);
    expect(isBlacklisted("/home/agent/.npm/_cacache")).toBe(true);
    expect(isBlacklisted("/workspace/service/target/debug")).toBe(true);
  });
  it("excludes git history, materialized skills and home ssh credentials", () => {
    expect(isBlacklisted("/workspace/.git/config")).toBe(true);
    expect(isBlacklisted("/home/agent/project/.git/refs")).toBe(true);
    expect(isBlacklisted("/workspace/.agents/skills")).toBe(true);
    expect(isBlacklisted("/workspace/.agents/skills/swe/p-mode/SKILL.md")).toBe(
      true,
    );
    expect(isBlacklisted("/home/agent/.ssh")).toBe(true);
    expect(isBlacklisted("/home/agent/.ssh/id_ed25519")).toBe(true);
  });
  it("keeps ordinary files and prefix neighbors", () => {
    expect(isBlacklisted("/workspace/src/main.ts")).toBe(false);
    expect(isBlacklisted("/home/agent/.bashrc")).toBe(false);
    expect(isBlacklisted("/workspace/.agents")).toBe(false);
    expect(isBlacklisted("/workspace/.agents/other/note.md")).toBe(false);
    expect(isBlacklisted("/home/agent/.sshrc")).toBe(false);
    expect(isBlacklisted("/workspace/targets/list.txt")).toBe(false);
  });
  it("treats a bare excluded name as excluded wherever it appears", () => {
    expect(isBlacklisted("/workspace/target")).toBe(true);
  });
});

describe("manifest", () => {
  const manifest = {
    workId: 7,
    taskId: 3,
    conversationId: 12,
    pod: "sandbox-abc",
    template: "swe",
    createdAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    roots: ["/workspace", "/home/agent"],
    capture: { truncated: false, bytes: 0, skippedByBlacklist: 0 },
    envdLog: false,
    podLog: false,
  };
  it("parses a full manifest", () => {
    expect(parseManifest(manifest)).toEqual(manifest);
  });
  it("rejects unknown fields and invalid values", () => {
    expect(() => parseManifest({ ...manifest, sandbox: true })).toThrow(
      /Invalid run manifest/,
    );
    expect(() =>
      parseManifest({ ...manifest, capture: { truncated: "yes" } }),
    ).toThrow(/Invalid run manifest/);
    expect(() => parseManifest({ ...manifest, workId: 0 })).toThrow(
      /Invalid run manifest/,
    );
  });
});

describe("ArtifactStore", () => {
  let root: string;
  const identity: RunIdentity = { workId: 7, taskId: 3 };
  const header = { conversationId: 12, pod: "sandbox-abc", template: "swe" };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kaeno-artifacts-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a run directory with an initial manifest", async () => {
    const store = new ArtifactStore(root);
    expect(store.runDirectory(identity)).toBe(join(root, "work-7", "task-3"));
    await store.createRun(identity, header);
    const manifest = await store.readManifest(identity);
    expect(manifest.workId).toBe(7);
    expect(manifest.conversationId).toBe(12);
    expect(manifest.pod).toBe("sandbox-abc");
    expect(manifest.roots).toEqual(["/workspace", "/home/agent"]);
    expect(manifest.finishedAt).toBeNull();
  });
  it("counts written evidence and records finish state", async () => {
    const store = new ArtifactStore(root);
    const handle = await store.createRun(identity, header);
    await handle.write("workspace/src/main.ts", "hello");
    await handle.write("home/.bashrc", "export EDITOR=vi\n");
    await handle.write(ENVD_LOG_FILE, "request log");
    handle.recordSkipped(42);
    handle.markTruncated();
    const finished = await handle.finish();
    expect(finished.finishedAt).not.toBeNull();
    expect(finished.capture).toEqual({
      truncated: true,
      bytes:
        Buffer.byteLength("hello") +
        Buffer.byteLength("export EDITOR=vi\n") +
        Buffer.byteLength("request log"),
      skippedByBlacklist: 42,
    });
    expect(finished.envdLog).toBe(true);
    expect(finished.podLog).toBe(false);
    const manifest = await store.readManifest(identity);
    expect(manifest).toEqual(finished);
  });
  it("re-creating a run directory converges over a stale attempt", async () => {
    const store = new ArtifactStore(root);
    const first = await store.createRun(identity, header);
    await first.write("workspace/src/main.ts", "stale");
    await first.finish();
    await store.createRun(identity, header);
    const manifest = await store.readManifest(identity);
    expect(manifest.finishedAt).toBeNull();
    expect(manifest.capture.bytes).toBe(0);
  });
  it("serves files only within the run directory", async () => {
    const store = new ArtifactStore(root);
    const handle = await store.createRun(identity, header);
    await handle.write("workspace/a.txt", "hello");
    const content = await store.readFile(identity, "workspace/a.txt");
    expect(Buffer.from(content).toString("utf8")).toBe("hello");
    await expect(
      store.readFile(identity, "../other/manifest.json"),
    ).rejects.toThrow(/Invalid artifact path/);
    await expect(store.readFile(identity, "/etc/passwd")).rejects.toThrow(
      /run-relative/,
    );
    await expect(handle.write("workspace/../escape.txt", "x")).rejects.toThrow(
      /Invalid artifact path/,
    );
  });
  it("lists all evidence files relative to the run", async () => {
    const store = new ArtifactStore(root);
    const handle = await store.createRun(identity, header);
    await handle.write("workspace/src/main.ts", "a");
    await handle.write("home/.bashrc", "b");
    await handle.write("trace.log", "c");
    await handle.finish();
    expect(await store.list(identity)).toEqual([
      "home/.bashrc",
      MANIFEST_FILE,
      "trace.log",
      "workspace/src/main.ts",
    ]);
  });
});
