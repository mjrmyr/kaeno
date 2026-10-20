import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { RepositoryReader } from "../definitions/index.ts";
import { GitHubClient } from "./client.ts";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_GIT_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 10_000;
const COMMIT = /^[a-f0-9]{40}$/;

/** Native host capabilities only; these are not owner repository configuration. */
export interface GitHubRepositoryReaderOptions {
  app?: { appId: string; installationId: number; privateKey: string };
  host?: {
    /** Substitute a local Git repository for HTTPS (e.g. an offline test fixture). */
    repositoryPath?: (repository: string) => string;
    fetch?: typeof globalThis.fetch;
  };
}

class ReadFailure extends Error {}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    // A caller's abort reason is arbitrary and may itself contain credentials.
    throw new ReadFailure("GitHub repository read cancelled");
  }
}

function validate(repository: string, ref: string): void {
  if (
    !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(repository) ||
    [".", ".."].includes(repository.split("/")[1] ?? "")
  ) {
    throw new ReadFailure("Invalid GitHub repository; expected owner/repo");
  }
  if (ref === "HEAD" || COMMIT.test(ref)) {
    return;
  }
  if (
    !ref ||
    ref.length > 1024 ||
    /[\p{Cc}\s~^:?*\\]/u.test(ref) ||
    ref.includes("[") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.startsWith("-") ||
    ref.endsWith(".") ||
    ref === "@" ||
    ref
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new ReadFailure("Invalid GitHub repository ref");
  }
}

function environment(
  directory: string,
  local: boolean,
  token: string,
): NodeJS.ProcessEnv {
  const settings: [string, string][] = [
    ["core.hooksPath", "/dev/null"],
    ["core.attributesFile", "/dev/null"],
    ["credential.helper", ""],
    ["credential.interactive", "false"],
    ["http.followRedirects", "false"],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ["protocol.file.allow", local ? "always" : "never"],
    ["transfer.fsckObjects", "true"],
    ["fetch.fsckObjects", "true"],
    ["core.protectNTFS", "true"],
    ["core.protectHFS", "true"],
  ];
  if (token) {
    settings.push([
      "http.https://github.com/.extraheader",
      `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    ]);
  }
  const result: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(settings.length),
  };
  settings.forEach(([key, value], index) => {
    result[`GIT_CONFIG_KEY_${index}`] = key;
    result[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return result;
}

async function diskBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    bytes += entry.isDirectory()
      ? await diskBytes(path)
      : (await lstat(path)).size;
    if (bytes > MAX_GIT_BYTES) {
      break;
    }
  }
  return bytes;
}

/** No shell, inherited Git settings, stderr diagnostics, or child-process errors escape. */
async function git(
  directory: string,
  args: readonly string[],
  options: {
    local: boolean;
    token?: string;
    signal?: AbortSignal;
    maxBytes?: number;
    monitor?: boolean;
    input?: Buffer;
  },
): Promise<Buffer> {
  cancelled(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["-C", directory, `--git-dir=${directory}`, ...args],
      {
        env: environment(directory, options.local, options.token ?? ""),
        stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let errorBytes = 0;
    let failure: string | undefined;
    let monitoring = false;
    function stop(message: string): void {
      failure ??= message;
      // Git can spawn a remote helper/upload-pack. Stop the entire private group.
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // A child that already exited may no longer have a process group.
        }
      }
      child.kill("SIGKILL");
    }
    function abort(): void {
      stop("GitHub repository read cancelled");
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }
    if (options.input) {
      child.stdin?.end(options.input);
    }
    const timeout = setTimeout(
      () => stop("GitHub Git operation timed out (120 seconds)"),
      120_000,
    );
    const monitor = setInterval(() => {
      if (!options.monitor || monitoring) {
        return;
      }
      monitoring = true;
      void diskBytes(directory)
        .then((size) => {
          if (size > MAX_GIT_BYTES) {
            stop("GitHub Git staging exceeds the 256 MiB limit");
          }
        })
        .catch(() => {
          // Git may rename/unlink pack files during this best-effort measurement.
        })
        .finally(() => {
          monitoring = false;
        });
    }, 250);
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 4 * 1024 * 1024)) {
        stop("GitHub Git output exceeds the size limit");
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > 1024 * 1024) {
        stop("GitHub Git diagnostics exceeds the size limit");
      }
    });
    child.on("error", () => {
      failure ??=
        "GitHub Git operation failed; check Git availability and repository access";
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      clearInterval(monitor);
      options.signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) {
        reject(
          new ReadFailure(
            failure ??
              "GitHub Git operation failed; check repository access and ref",
          ),
        );
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

interface FileEntry {
  path: string;
  object: string;
  size: number;
  executable: boolean;
}

function files(tree: Buffer): FileEntry[] {
  const entries: FileEntry[] = [];
  let total = 0;
  for (const record of tree.toString("utf8").split("\0")) {
    if (!record) {
      continue;
    }
    const match = /^(\d{6}) (\w+) ([a-f0-9]{40}) +([0-9]+|-)\t([\s\S]+)$/.exec(
      record,
    );
    if (!match) {
      throw new ReadFailure("Unsupported GitHub repository tree entry");
    }
    const [, mode, type, object, rawSize, path] = match;
    if (
      !path ||
      !object ||
      (mode !== "100644" && mode !== "100755") ||
      type !== "blob"
    ) {
      throw new ReadFailure(
        "GitHub definitions reject symlinks, submodules, and special entries",
      );
    }
    if (
      path
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            /^\.git$/i.test(part) ||
            /[\p{Cc}\\:]/u.test(part) ||
            /[. ]$/.test(part),
        )
    ) {
      throw new ReadFailure("GitHub definitions contain an unsafe path");
    }
    const size = Number(rawSize);
    total += size;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_FILE_BYTES ||
      total > MAX_EXPORT_BYTES ||
      entries.length >= MAX_FILES
    ) {
      throw new ReadFailure(
        "GitHub definitions exceed file count or byte limits",
      );
    }
    entries.push({ path, object, size, executable: mode === "100755" });
  }
  if (!Buffer.from(tree.toString("utf8"), "utf8").equals(tree)) {
    throw new ReadFailure("GitHub definitions require UTF-8 paths");
  }
  return entries;
}

function blobs(output: Buffer, entries: readonly FileEntry[]): Buffer[] {
  const result: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const end = output.indexOf(10, offset);
    if (end < 0) {
      throw new ReadFailure("GitHub blob batch is incomplete");
    }
    const header = output.subarray(offset, end).toString("ascii");
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(header);
    if (
      !match ||
      match[1] !== entry.object ||
      Number(match[2]) !== entry.size
    ) {
      throw new ReadFailure(
        "GitHub blob batch does not match the repository tree",
      );
    }
    const start = end + 1;
    const finish = start + entry.size;
    if (finish >= output.length || output[finish] !== 10) {
      throw new ReadFailure("GitHub blob batch is truncated");
    }
    result.push(output.subarray(start, finish));
    offset = finish + 1;
  }
  if (offset !== output.length) {
    throw new ReadFailure("GitHub blob batch has unexpected trailing data");
  }
  return result;
}

async function cleanup(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    // Filesystem errors can contain private host paths; never expose them.
    throw new ReadFailure(
      "GitHub temporary metadata cleanup failed; check host storage",
    );
  }
}

/** Read-only GitHub acquisition; raw objects bypass checkout hooks, filters and archives. */
export function githubRepositoryReader(
  options: GitHubRepositoryReaderOptions = {},
): RepositoryReader {
  return {
    async read(request, destination, signal): Promise<{ commit: string }> {
      validate(request.repository, request.ref);
      cancelled(signal);
      let directory: string | undefined;
      try {
        const target = await lstat(destination);
        if (
          !target.isDirectory() ||
          target.isSymbolicLink() ||
          (await readdir(destination)).length
        ) {
          throw new ReadFailure(
            "GitHub export destination must be an empty private directory",
          );
        }
        directory = await mkdtemp(
          join(dirname(resolve(destination)), ".kaeno-github-"),
        );
        const repository = request.repository.toLowerCase();
        const localPath = options.host?.repositoryPath?.(repository);
        if (localPath !== undefined && !isAbsolute(localPath)) {
          throw new ReadFailure("GitHub host repository path must be absolute");
        }
        const remote = localPath ?? `https://github.com/${repository}.git`;
        const local = localPath !== undefined;
        function run(
          args: readonly string[],
          maxBytes?: number,
        ): Promise<Buffer> {
          return git(directory ?? "", args, { local, signal, maxBytes });
        }
        await run(["init", "--bare", "--quiet", "--template="]);
        let token = "";
        if (options.app) {
          if (
            !Number.isSafeInteger(options.app.installationId) ||
            options.app.installationId <= 0
          ) {
            throw new ReadFailure("Invalid GitHub App installation ID");
          }
          const client = new GitHubClient({
            ...options.app,
            fetch: options.host?.fetch,
          });
          token = await client.token(
            options.app.installationId,
            undefined,
            signal,
          );
          if (token.length > 4096 || /\p{Cc}/u.test(token)) {
            throw new ReadFailure("Invalid GitHub App credential response");
          }
        }
        function network(args: readonly string[]): Promise<Buffer> {
          return git(directory ?? "", args, {
            local,
            token,
            signal,
            monitor: true,
          });
        }
        let ref = request.ref;
        if (ref !== "HEAD" && !ref.startsWith("refs/") && !COMMIT.test(ref)) {
          const branches = `refs/heads/${ref}`;
          const tags = `refs/tags/${ref}`;
          const advertised = (
            await network(["ls-remote", "--refs", "--", remote, branches, tags])
          ).toString("utf8");
          const matches = advertised
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split("\t")[1])
            .filter((name) => name === branches || name === tags);
          if (matches.length !== 1) {
            throw new ReadFailure(
              "GitHub ref is missing or ambiguous; qualify with refs/heads/ or refs/tags/",
            );
          }
          ref = matches[0] ?? "";
        }
        await network([
          "fetch",
          "--quiet",
          "--depth=1",
          "--no-tags",
          "--no-recurse-submodules",
          "--",
          remote,
          ref,
        ]);
        token = "";
        if ((await diskBytes(directory)) > MAX_GIT_BYTES) {
          throw new ReadFailure("GitHub Git staging exceeds the 256 MiB limit");
        }
        const commit = (
          await run(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])
        )
          .toString("utf8")
          .trim();
        if (
          !COMMIT.test(commit) ||
          (COMMIT.test(request.ref) && commit !== request.ref)
        ) {
          throw new ReadFailure(
            "GitHub returned an invalid or mismatched commit",
          );
        }
        const entries = files(
          await run(["ls-tree", "-r", "-l", "-z", "--full-tree", commit]),
        );
        const output = await git(directory, ["cat-file", "--batch"], {
          local,
          signal,
          maxBytes: MAX_EXPORT_BYTES + MAX_FILES * 128,
          input: Buffer.from(
            `${entries.map((entry) => entry.object).join("\n")}\n`,
          ),
        });
        const contents = blobs(output, entries);
        for (const [index, entry] of entries.entries()) {
          cancelled(signal);
          const content = contents[index];
          if (!content || content.length !== entry.size) {
            throw new ReadFailure("GitHub blob size mismatch");
          }
          if (
            content
              .subarray(0, 1024)
              .toString("utf8")
              .includes("version https://git-lfs.github.com/spec/v1")
          ) {
            throw new ReadFailure(
              "GitHub definitions do not support Git LFS pointers",
            );
          }
          const path = join(destination, entry.path);
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await writeFile(path, content, {
            flag: "wx",
            mode: entry.executable ? 0o700 : 0o600,
          });
        }
        cancelled(signal);
        return { commit };
      } catch (error) {
        cancelled(signal);
        if (error instanceof ReadFailure) {
          throw error;
        }
        throw new ReadFailure(
          "GitHub repository read failed; check host storage, App credentials, and repository access",
        );
      } finally {
        if (directory) {
          await cleanup(directory);
        }
      }
    },
  };
}
