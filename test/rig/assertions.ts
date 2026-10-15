// Ground-truth checks for the rig: every assertion reads evidence the rig itself
// produced (the artifact store, the durable trace, the HTTP surface) — never
// in-memory state — so a green rig run is physical proof, not a tautology.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ENVD_LOG_FILE,
  POD_LOG_FILE,
  WORKSPACE_MANIFEST_FILE,
  type ArtifactStore,
  type RunIdentity,
} from "../../src/artifacts/index.ts";

export interface RigChecks {
  verify(name: string, check: () => Promise<string>): void;
  finish(title: string): Promise<boolean>;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export function createRigChecks(): RigChecks {
  const results: CheckResult[] = [];
  const pending: Promise<void>[] = [];
  const run = async (
    name: string,
    check: () => Promise<string>,
  ): Promise<void> => {
    let detail: string;
    try {
      detail = await check();
    } catch (error) {
      results.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    results.push({ name, ok: true, detail });
  };
  return {
    verify(name: string, check: () => Promise<string>): void {
      pending.push(run(name, check));
    },
    async finish(title: string): Promise<boolean> {
      await Promise.allSettled(pending);
      console.log(`\n${title}`);
      let failed = 0;
      for (const result of results) {
        const mark = result.ok ? "PASS" : "FAIL";
        if (!result.ok) {
          failed += 1;
        }
        console.log(`  [${mark}] ${result.name} — ${result.detail}`);
      }
      console.log(
        `\n  ${results.length - failed}/${results.length} checks passed`,
      );
      return failed === 0;
    },
  };
}

/** Reads a run file's text; throws when missing so the check fails loudly. */
export async function runFile(
  runDirectory: string,
  name: string,
): Promise<string> {
  return readFile(join(runDirectory, name), "utf8");
}

export interface ArtifactFileChecks {
  store: ArtifactStore;
  identity: RunIdentity;
  runDirectory: string;
}

export function artifactChecks(
  checks: RigChecks,
  files: ArtifactFileChecks,
): void {
  const { store, identity, runDirectory } = files;
  checks.verify("run directory exists", async () => {
    const info = await stat(runDirectory);
    if (!info.isDirectory()) {
      throw new Error(`${runDirectory} is not a directory`);
    }
    return runDirectory;
  });
  checks.verify("manifest parses under the strict schema", async () => {
    const manifest = await store.readManifest(identity);
    if (manifest.finishedAt === null) {
      throw new Error("run was never marked finished");
    }
    return `pod=${manifest.pod} template=${manifest.template}`;
  });
  checks.verify("capture completed without truncation", async () => {
    const manifest = await store.readManifest(identity);
    if (manifest.capture.error !== undefined) {
      throw new Error(manifest.capture.error);
    }
    if (manifest.capture.truncated) {
      throw new Error("capture was truncated");
    }
    if (manifest.capture.bytes === 0) {
      throw new Error("capture is empty");
    }
    return `bytes=${manifest.capture.bytes} skipped=${manifest.capture.skippedByBlacklist}`;
  });
  checks.verify("workspace file is byte-exact", async () => {
    const content = await store.readFile(identity, "workspace/hello.txt");
    if (new TextDecoder().decode(content) !== "kaeno-rig") {
      throw new Error(`captured content diverged: ${content.length} bytes`);
    }
    return `${content.length} bytes match`;
  });
  checks.verify("workspace manifest lists the file", async () => {
    const listing = await runFile(runDirectory, WORKSPACE_MANIFEST_FILE);
    if (!listing.includes("workspace/hello.txt")) {
      throw new Error(listing);
    }
    return "workspace/hello.txt listed";
  });
  checks.verify("envd log records the real requests", async () => {
    const log = await runFile(runDirectory, ENVD_LOG_FILE);
    const lines = log.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length < 2) {
      throw new Error(`only ${lines.length} request(s) logged`);
    }
    if (!lines.some((line) => line.includes("collect"))) {
      throw new Error("teardown capture request missing from the log");
    }
    return `${lines.length} requests logged`;
  });
  checks.verify("pod log captured", async () => {
    const log = await runFile(runDirectory, POD_LOG_FILE);
    if (log.trim().length === 0) {
      throw new Error("pod log is empty");
    }
    return log.trim();
  });
  checks.verify("durable trace written during the run", async () => {
    const trace = await runFile(runDirectory, "trace.log");
    if (trace.trim().length === 0) {
      throw new Error("trace is empty");
    }
    return `${trace.trim().split("\n").length} lines`;
  });
}

export interface HttpChecks {
  port: number;
  token: string;
  chatKey: string;
  workId: number;
  runDirectory: string;
  /** Scopes a fresh conversation to a run via the real ThreadDirectory + WorkScope doc. */
  scopeConversation(workId: number): Promise<string>;
  keys: string[];
}

async function get(options: HttpChecks, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${options.port}${path}`, {
    headers: { authorization: `Bearer ${options.token}` },
  });
}

export function httpChecks(checks: RigChecks, options: HttpChecks): void {
  const base = `/v1/threads/${options.chatKey}/work`;
  checks.verify("work listing shows an artifacts summary", async () => {
    const response = await get(options, base);
    if (response.status !== 200) {
      throw new Error(`listing returned ${response.status}`);
    }
    const listing = z
      .array(
        z.object({
          artifacts: z.object({ present: z.boolean() }).partial().optional(),
        }),
      )
      .parse(await response.json());
    const job = listing.find((view) => view.artifacts?.present === true);
    if (job === undefined) {
      throw new Error(
        `no view carries an artifacts summary: ${JSON.stringify(listing)}`,
      );
    }
    return "summary present";
  });
  checks.verify("artifacts listing serves the captured files", async () => {
    const response = await get(options, `${base}/${options.workId}/artifacts`);
    if (response.status !== 200) {
      throw new Error(`listing returned ${response.status}`);
    }
    const listing = z
      .object({ files: z.array(z.string()) })
      .parse(await response.json());
    if (!listing.files.includes("workspace/hello.txt")) {
      throw new Error(JSON.stringify(listing.files));
    }
    return `${listing.files.length} files listed`;
  });
  checks.verify("captured file serves over HTTP byte-exact", async () => {
    const response = await get(
      options,
      `${base}/${options.workId}/artifacts/workspace/hello.txt`,
    );
    if (response.status !== 200) {
      throw new Error(`file returned ${response.status}`);
    }
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/plain")) {
      throw new Error(`unexpected content-type ${type}`);
    }
    const body = await response.text();
    if (body !== "kaeno-rig") {
      throw new Error(`served body diverged: ${body}`);
    }
    return "text/plain, byte-exact";
  });
  checks.verify("traversal cannot escape the run directory", async () => {
    const response = await get(
      options,
      `${base}/${options.workId}/artifacts/..%2F..%2Fstate.sqlite`,
    );
    if (response.status !== 404) {
      throw new Error(`traversal returned ${response.status}`);
    }
    return "404";
  });
  checks.verify("a scoped WORK caller cannot read a foreign run", async () => {
    const key = await options.scopeConversation(999999);
    const response = await get(
      options,
      `/v1/threads/${key}/work/${options.workId}/artifacts`,
    );
    if (response.status !== 404) {
      throw new Error(`foreign run returned ${response.status}`);
    }
    return "404 for a run outside the parent↔child edge";
  });
  checks.verify("no API key material leaks into the artifacts", async () => {
    if (options.keys.length === 0) {
      return "skipped (no real keys in play)";
    }
    for (const name of [
      ENVD_LOG_FILE,
      POD_LOG_FILE,
      WORKSPACE_MANIFEST_FILE,
      "trace.log",
    ]) {
      const content = await runFile(options.runDirectory, name);
      for (const key of options.keys) {
        if (content.includes(key)) {
          throw new Error(`${name} contains key material`);
        }
      }
    }
    return `${options.keys.length} key(s) absent from every log`;
  });
}
