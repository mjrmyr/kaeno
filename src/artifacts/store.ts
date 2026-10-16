import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CAPTURE_ROOTS } from "./blacklist.ts";
import { parseManifest, type RunManifest } from "./manifest.ts";

export const MANIFEST_FILE = "manifest.json";
export const TRACE_FILE = "trace.log";
export const POD_LOG_FILE = "pod.log";
export const ENVD_LOG_FILE = "envd.log";
export const WORKSPACE_MANIFEST_FILE = "workspace-manifest.txt";

export interface RunIdentity {
  workId: number;
  taskId: number;
}

export interface RunHeader {
  conversationId: number;
  pod: string;
  template: string;
}

function runRelativePath(relative: string): string {
  if (relative.startsWith("/")) {
    throw new Error(`Artifact path must be run-relative: ${relative}`);
  }
  const segments = relative.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`Invalid artifact path: ${relative}`);
    }
  }
  return segments.join("/");
}

/**
 * One run's write side. Created at teardown, finished when all evidence has landed.
 * Re-creating a run directory converges: a crashed collection attempt leaves a stale
 * manifest that the next attempt overwrites from scratch.
 */
export class RunHandle {
  public readonly directory: string;
  private manifest: RunManifest;
  private readonly written = new Set<string>();

  constructor(directory: string, manifest: RunManifest) {
    this.directory = directory;
    this.manifest = manifest;
  }

  async write(relative: string, data: string | Uint8Array): Promise<void> {
    const path = runRelativePath(relative);
    await mkdir(dirname(join(this.directory, path)), { recursive: true });
    await writeFile(join(this.directory, path), data);
    const bytes =
      typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    this.manifest.capture.bytes += bytes;
    const [root] = path.split("/");
    this.written.add(root);
  }

  recordSkipped(count: number): void {
    this.manifest.capture.skippedByBlacklist += count;
  }

  markTruncated(): void {
    this.manifest.capture.truncated = true;
  }

  markFailed(error: string): void {
    this.manifest.capture.error = error;
  }

  async finish(): Promise<RunManifest> {
    this.manifest = {
      ...this.manifest,
      finishedAt: new Date().toISOString(),
      envdLog: this.written.has(ENVD_LOG_FILE),
      podLog: this.written.has(POD_LOG_FILE),
    };
    await writeFile(
      join(this.directory, MANIFEST_FILE),
      JSON.stringify(this.manifest),
    );
    return this.manifest;
  }
}

/**
 * Durable evidence store on the orchestrator. Sandboxes never mount it: their channel
 * is upload-only, collected out-of-band at teardown. Manifest timestamps enable later
 * manual cleanup; there is no automatic retention.
 */
export class ArtifactStore {
  public readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  runDirectory(identity: RunIdentity): string {
    return join(
      this.root,
      `work-${identity.workId}`,
      `task-${identity.taskId}`,
    );
  }

  async createRun(
    identity: RunIdentity,
    header: RunHeader,
  ): Promise<RunHandle> {
    const directory = this.runDirectory(identity);
    await mkdir(directory, { recursive: true });
    const manifest: RunManifest = {
      workId: identity.workId,
      taskId: identity.taskId,
      conversationId: header.conversationId,
      pod: header.pod,
      template: header.template,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      roots: [...CAPTURE_ROOTS],
      capture: { truncated: false, bytes: 0, skippedByBlacklist: 0 },
      envdLog: false,
      podLog: false,
    };
    await writeFile(join(directory, MANIFEST_FILE), JSON.stringify(manifest));
    return new RunHandle(directory, manifest);
  }

  async readManifest(identity: RunIdentity): Promise<RunManifest> {
    const raw = JSON.parse(
      await readFile(join(this.runDirectory(identity), MANIFEST_FILE), "utf8"),
    );
    return parseManifest(raw);
  }

  async readFile(identity: RunIdentity, relative: string): Promise<Uint8Array> {
    const path = join(this.runDirectory(identity), runRelativePath(relative));
    return readFile(path);
  }

  async list(identity: RunIdentity): Promise<string[]> {
    const directory = this.runDirectory(identity);
    const paths: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      const current = relative ? join(directory, relative) : directory;
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(child);
        } else {
          paths.push(child);
        }
      }
    };
    await walk("");
    return paths.sort();
  }
}
