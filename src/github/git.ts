import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
export const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
export const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);

export interface RepositoryTransport {
  checkout(
    remote: string,
    ref: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<{ bundle: Uint8Array; sha: string }>;
  publish(
    remote: string,
    branch: string,
    bundle: Uint8Array,
    sha: string,
    expected: string | null,
    token: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** Trusted host Git only. Credentials are ephemeral process environment, never a remote URL or bundle. */
export class HostGit implements RepositoryTransport {
  private async git(
    directory: string,
    args: readonly string[],
    token: string,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const result = await execute("git", ["-C", directory, ...args], {
        signal,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_CONFIG_COUNT: "4",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
          GIT_CONFIG_KEY_1: "core.hooksPath",
          GIT_CONFIG_VALUE_1: "/dev/null",
          GIT_CONFIG_KEY_2: "http.followRedirects",
          GIT_CONFIG_VALUE_2: "false",
          GIT_CONFIG_KEY_3: "credential.helper",
          GIT_CONFIG_VALUE_3: "",
        },
      });
      return result.stdout.trim();
    } catch {
      signal?.throwIfAborted();
      // Neither child-process error objects nor remote output may expose credentials.
      throw new Error(
        "GitHub Git operation failed; check access, Git availability, and remote branch state",
      );
    }
  }

  private async temporary<Result>(
    run: (directory: string) => Promise<Result>,
  ): Promise<Result> {
    const directory = await mkdtemp(join(tmpdir(), "kaeno-github-"));
    try {
      await this.git(directory, ["init", "--bare", "--quiet"], "");
      return await run(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async checkout(
    remote: string,
    ref: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<{ bundle: Uint8Array; sha: string }> {
    return this.temporary(async (directory) => {
      // A full bundle makes the worker independent of authenticated network access.
      await this.git(
        directory,
        ["fetch", "--no-tags", "--", remote, ref],
        token,
        signal,
      );
      const sha = commitSchema.parse(
        await this.git(
          directory,
          ["rev-parse", "FETCH_HEAD^{commit}"],
          "",
          signal,
        ),
      );
      await this.git(
        directory,
        ["update-ref", "refs/heads/kaeno-base", sha],
        "",
        signal,
      );
      const path = join(directory, "checkout.bundle");
      await this.git(
        directory,
        ["bundle", "create", path, "refs/heads/kaeno-base"],
        "",
        signal,
      );
      if ((await stat(path)).size > MAX_BUNDLE_BYTES) {
        throw new Error("GitHub checkout exceeds the 100 MiB bundle limit");
      }
      return { bundle: await readFile(path), sha };
    });
  }

  async publish(
    remote: string,
    branch: string,
    bundle: Uint8Array,
    sha: string,
    expected: string | null,
    token: string,
    signal?: AbortSignal,
  ): Promise<void> {
    commitSchema.parse(sha);
    if (expected !== null) {
      commitSchema.parse(expected);
    }
    if (bundle.byteLength > MAX_BUNDLE_BYTES) {
      throw new Error("GitHub publish exceeds the 100 MiB bundle limit");
    }
    await this.temporary(async (directory) => {
      const ref = `refs/heads/${branch}`;
      await this.git(directory, ["check-ref-format", ref], "", signal);
      const path = join(directory, "publish.bundle");
      await writeFile(path, bundle);
      await this.git(
        directory,
        ["fetch", "--no-tags", path, "refs/heads/kaeno-export"],
        "",
        signal,
      );
      const received = await this.git(
        directory,
        ["rev-parse", "FETCH_HEAD^{commit}"],
        "",
        signal,
      );
      if (received !== sha) {
        throw new Error(
          "GitHub: exported commit does not match saved publish intent",
        );
      }
      const advertised = await this.git(
        directory,
        ["ls-remote", "--refs", "--", remote, ref],
        token,
        signal,
      );
      const current = advertised
        ? commitSchema.parse(advertised.split(/\s/)[0])
        : null;
      if (current === sha) {
        return;
      }
      if (current !== expected) {
        throw new Error(
          "GitHub: remote work branch changed unexpectedly; refusing to overwrite it",
        );
      }
      if (expected) {
        await this.git(
          directory,
          ["merge-base", "--is-ancestor", expected, sha],
          "",
          signal,
        );
      }
      // Ordinary push only: Git also rejects a concurrent non-fast-forward update.
      await this.git(
        directory,
        ["push", "--", remote, `${sha}:${ref}`],
        token,
        signal,
      );
    });
  }
}
