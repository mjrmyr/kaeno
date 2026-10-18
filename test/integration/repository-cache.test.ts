import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { parseEnvironmentConfiguration } from "../../src/host/composition/index.ts";
import {
  definitionTreeHash,
  withDefinitionSources,
  type DefinitionPackage,
  type DefinitionSources,
  type RepositoryDefinitionSource,
  type RepositoryReader,
} from "../../src/extensions/definitions/index.ts";
import { githubRepositoryReader } from "../../src/extensions/github/index.ts";

const execute = promisify(execFile);
const roots: string[] = [];
const children = new Set<ChildProcess>();
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const repositories: RepositoryDefinitionSource[] = [
  {
    kind: "agents",
    repository: "owner/definitions",
    ref: "HEAD",
    path: "agents",
  },
  {
    kind: "skills",
    repository: "owner/definitions",
    ref: "HEAD",
    path: "skills",
  },
];
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Missing fixture item ${index}`);
  }
  return value;
}

const twoRepositories: RepositoryDefinitionSource[] = [
  at(repositories, 0),
  { kind: "skills", repository: "owner/other", ref: "trunk", path: "skills" },
];
const binary = Buffer.from([0, 255, 128, 13, 10, 42]);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kaeno-repository-cache-test-"));
  roots.push(root);
  return { root, directory: join(root, "cache") };
}

async function put(root: string, path: string, content: string | Uint8Array) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function exportDefinitions(destination: string, version = "first") {
  await put(
    destination,
    "agents/reviewer/AGENT.md",
    `---\nname: reviewer\ndescription: Review\n---\n${version}\n`,
  );
  await put(
    destination,
    "skills/nested/tool/SKILL.md",
    `---\nname: tool\ndescription: Tool\n---\n${version}\n`,
  );
  await put(destination, "skills/nested/tool/assets/blob.bin", binary);
  await put(
    destination,
    "skills/nested/tool/scripts/run.sh",
    "#!/bin/sh\nexit 0\n",
  );
  await chmod(join(destination, "skills/nested/tool/scripts/run.sh"), 0o700);
}

function injectedReader(version = "first", commit = commitA) {
  const read = vi.fn<RepositoryReader["read"]>(
    async (_request, destination) => {
      await exportDefinitions(destination, version);
      return { commit };
    },
  );
  return { read } satisfies RepositoryReader;
}

function forbiddenReader() {
  return {
    read: vi.fn<RepositoryReader["read"]>(async () => {
      throw new Error("offline must never call the reader");
    }),
  } satisfies RepositoryReader;
}

async function snapshot(sources: DefinitionSources) {
  async function kind(name: "agents" | "skills", manifest: string) {
    const packages: DefinitionPackage[] = [];
    for (const source of sources[name]) {
      const result = await source.snapshot(manifest);
      expect(result.diagnostics).toEqual([]);
      packages.push(...result.packages);
    }
    return packages;
  }
  return {
    agents: await kind("agents", "AGENT.md"),
    skills: await kind("skills", "SKILL.md"),
  };
}

async function localGit(root: string) {
  const repository = join(root, "git");
  await mkdir(repository);
  const git = async (args: readonly string[]) => {
    const result = await execute(
      "git",
      [
        "-C",
        repository,
        "-c",
        "user.name=Cache Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    return result.stdout.trim();
  };
  await git(["init", "--initial-branch=trunk", "--template="]);
  await exportDefinitions(repository);
  await git(["add", "."]);
  await git(["commit", "-m", "first"]);
  return { repository, git };
}

function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function launchPausedWriter(directory: string, marker: string) {
  // Native Node TS loading, through the same public barrel used by application code.
  // Pause after all exports and snapshots, but before the load record can be published.
  const script = `
    import { mkdir, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import { withDefinitionSources } from ${JSON.stringify(pathToFileURL(resolve("src/extensions/definitions/index.ts")).href)};
    await withDefinitionSources({
      directory: ${JSON.stringify(directory)},
      repositories: ${JSON.stringify(twoRepositories)},
      directories: [],
      reader: { async read(request, destination) {
        const kind = request.repository === "owner/other" ? "skills" : "agents";
        const packageDirectory = join(destination, kind, "child");
        await mkdir(packageDirectory, { recursive: true });
        await writeFile(join(packageDirectory, kind === "skills" ? "SKILL.md" : "AGENT.md"), "unpublished child version");
        return { commit: ${JSON.stringify(commitB)} };
      } },
    }, async (sources) => {
      for (const source of sources.agents) await source.snapshot("AGENT.md");
      for (const source of sources.skills) await source.snapshot("SKILL.md");
      await writeFile(${JSON.stringify(marker)}, "ready");
      await new Promise(() => { setInterval(() => {}, 1000); });
    });
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  let diagnostics = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      children.delete(child);
      resolveExit({ code, signal });
    });
  });
  return { child, exited, diagnostics: () => diagnostics };
}

async function waitForChildReady(
  marker: string,
  process: ReturnType<typeof launchPausedWriter>,
) {
  await vi.waitFor(
    async () => {
      expect(process.child.exitCode).toBeNull();
      if (process.child.exitCode !== null) {
        throw new Error(process.diagnostics());
      }
      expect(await readFile(marker, "utf8")).toBe("ready");
    },
    { timeout: 10_000, interval: 25 },
  );
}

afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      const exited = new Promise<void>((resolveExit) =>
        child.once("exit", () => resolveExit()),
      );
      child.kill("SIGKILL");
      await exited;
    }),
  );
  children.clear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("deduplicates a real Git export across kinds and preserves commit, package provenance, binary assets and executable modes", async () => {
  const { root, directory } = await fixture();
  const { repository, git } = await localGit(root);
  const firstCommit = await git(["rev-parse", "HEAD"]);
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(new Response()),
  );
  const hostPath = vi.fn<() => string>(() => repository);
  const realReader = githubRepositoryReader({
    host: { repositoryPath: hostPath, fetch },
  });
  const reader: RepositoryReader = {
    read: vi.fn<RepositoryReader["read"]>(realReader.read.bind(realReader)),
  };
  const options = { directory, repositories, directories: [], reader };
  const first = await withDefinitionSources(options, snapshot);
  expect(reader.read).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(first.agents).toHaveLength(1);
  expect(first.skills).toHaveLength(1);
  const agent = at(first.agents, 0);
  const skill = at(first.skills, 0);
  expect(agent.source).toBe("owner/definitions");
  expect(agent.origin).toEqual({
    kind: "repository",
    repository: "owner/definitions",
    ref: "HEAD",
    commit: firstCommit,
    path: "agents/reviewer",
    contentHash: await definitionTreeHash(agent.directory),
  });
  expect(skill.origin).toEqual({
    kind: "repository",
    repository: "owner/definitions",
    ref: "HEAD",
    commit: firstCommit,
    path: "skills/nested/tool",
    contentHash: await definitionTreeHash(skill.directory),
  });
  expect(await readFile(join(skill.directory, "assets/blob.bin"))).toEqual(
    binary,
  );
  expect(
    (await lstat(join(skill.directory, "scripts/run.sh"))).mode & 0o111,
  ).not.toBe(0);
  expect(
    (await lstat(join(skill.directory, "assets/blob.bin"))).mode & 0o111,
  ).toBe(0);
  expect(
    (await lstat(join(skill.directory, "assets/blob.bin"))).mode & 0o222,
  ).toBe(0);
  await expect(
    lstat(join(dirname(dirname(agent.directory)), ".git")),
  ).rejects.toMatchObject({ code: "ENOENT" });

  await put(repository, "agents/reviewer/AGENT.md", "second commit\n");
  await git(["add", "."]);
  await git(["commit", "-m", "second"]);
  const secondCommit = await git(["rev-parse", "HEAD"]);
  const offlineReader = forbiddenReader();
  const offline = await withDefinitionSources(
    { ...options, reader: offlineReader, mode: "offline" },
    snapshot,
  );
  expect(offline).toEqual(first);
  expect(offlineReader.read).not.toHaveBeenCalled();
  const refreshed = await withDefinitionSources(options, snapshot);
  expect(reader.read).toHaveBeenCalledTimes(2);
  expect(refreshed.agents[0]?.origin).toMatchObject({ commit: secondCommit });
  expect(refreshed.agents[0]?.manifest).toBe("second commit\n");
  expect(first.agents[0]?.manifest).toContain("first");
});

it("captures local inputs once across kinds and serves captured bytes after the live input disappears", async () => {
  const { root, directory } = await fixture();
  const local = join(root, "local");
  await put(local, "reviewer/AGENT.md", "local agent");
  await put(local, "reviewer/SKILL.md", "local skill");
  await put(local, "reviewer/blob.bin", binary);
  await chmod(join(local, "reviewer/blob.bin"), 0o700);
  const reader = forbiddenReader();
  const directories = [
    { kind: "agents" as const, alias: "work", directory: local },
    { kind: "skills" as const, alias: "tools", directory: local },
  ];
  const options = { directory, repositories: [], directories, reader };
  const captured = await withDefinitionSources(options, async (sources) => {
    await put(local, "reviewer/AGENT.md", "mutated after capture");
    return snapshot(sources);
  });
  const agent = at(captured.agents, 0);
  expect(agent.manifest).toBe("local agent");
  expect(agent.directory).not.toBe(join(local, "reviewer"));
  expect(agent.directory).toBe(captured.skills[0]?.directory);
  expect(agent.origin).toEqual({
    kind: "directory",
    source: "work",
    path: join(local, "reviewer"),
    contentHash: await definitionTreeHash(agent.directory),
  });
  expect(captured.skills[0]?.origin).toMatchObject({
    kind: "directory",
    source: "tools",
  });
  expect(await readFile(join(agent.directory, "blob.bin"))).toEqual(binary);
  expect(
    (await lstat(join(agent.directory, "blob.bin"))).mode & 0o111,
  ).not.toBe(0);
  await rm(local, { recursive: true });
  expect(
    await withDefinitionSources({ ...options, mode: "offline" }, snapshot),
  ).toEqual(captured);
  expect(reader.read).not.toHaveBeenCalled();
});

it("requires an exact offline recipe, including kind, root path, alias and absolute local input directory", async () => {
  const { root, directory } = await fixture();
  const local = join(root, "local");
  const otherLocal = join(root, "other-local");
  await put(local, "reviewer/AGENT.md", "same bytes");
  await put(otherLocal, "reviewer/AGENT.md", "same bytes");
  const directories = [
    { kind: "agents" as const, alias: "local", directory: local },
  ];
  const options = {
    directory,
    repositories,
    directories,
    reader: injectedReader(),
  };
  const original = await withDefinitionSources(options, snapshot);
  const reader = forbiddenReader();
  const variants = [
    { repositories: [at(repositories, 0)] },
    {
      repositories: [{ ...at(repositories, 0), path: "" }, at(repositories, 1)],
    },
    {
      repositories: [
        { ...at(repositories, 0), ref: "trunk" },
        at(repositories, 1),
      ],
    },
    { repositories: [...repositories].reverse() },
    { directories: [{ ...at(directories, 0), alias: "renamed" }] },
    { directories: [{ ...at(directories, 0), kind: "skills" as const }] },
    { directories: [{ ...at(directories, 0), directory: otherLocal }] },
  ];
  for (const variant of variants) {
    await expect(
      withDefinitionSources(
        { ...options, ...variant, reader, mode: "offline" },
        snapshot,
      ),
    ).rejects.toThrow(/offline input set/);
  }
  expect(
    await withDefinitionSources(
      { ...options, reader, mode: "offline" },
      snapshot,
    ),
  ).toEqual(original);
  expect(reader.read).not.toHaveBeenCalled();
  const otherRootOptions = {
    ...options,
    repositories: [{ ...at(repositories, 0), path: "" }],
    reader: injectedReader("second", commitB),
  };
  const otherRoot = await withDefinitionSources(otherRootOptions, snapshot);
  expect(otherRoot.agents[0]?.origin).toMatchObject({
    path: "agents/reviewer",
    commit: commitB,
  });
  expect(
    await withDefinitionSources(
      { ...otherRootOptions, reader, mode: "offline" },
      snapshot,
    ),
  ).toEqual(otherRoot);
  expect(
    await withDefinitionSources(
      { ...options, reader, mode: "offline" },
      snapshot,
    ),
  ).toEqual(original);
});

it("does not deduplicate different refs of one repository", async () => {
  const { directory } = await fixture();
  const reader = injectedReader();
  await withDefinitionSources(
    {
      directory,
      directories: [],
      reader,
      repositories: [
        at(repositories, 0),
        { ...at(repositories, 1), ref: "release" },
      ],
    },
    snapshot,
  );
  expect(reader.read).toHaveBeenCalledTimes(2);
  expect(reader.read.mock.calls.map(([request]) => request.ref)).toEqual([
    "HEAD",
    "release",
  ]);
});

it.each(["second repository", "selected consumer"] as const)(
  "retains the previous complete cohort when the %s fails",
  async (failure) => {
    const { directory } = await fixture();
    const options = {
      directory,
      repositories: twoRepositories,
      directories: [],
      reader: injectedReader(),
    };
    const previous = await withDefinitionSources(options, snapshot);
    const read = vi.fn<RepositoryReader["read"]>(
      async (request, destination) => {
        if (
          failure === "second repository" &&
          request.repository === "owner/other"
        ) {
          throw new Error("second repository failed");
        }
        await exportDefinitions(destination, "unpublished");
        return { commit: commitB };
      },
    );
    await expect(
      withDefinitionSources(
        { ...options, reader: { read } },
        async (sources) => {
          const selected = await snapshot(sources);
          expect(selected.agents[0]?.manifest).toContain("unpublished");
          throw new Error("selected consumer failed");
        },
      ),
    ).rejects.toThrow(`${failure} failed`);
    expect(read).toHaveBeenCalledTimes(2);
    const reader = forbiddenReader();
    expect(
      await withDefinitionSources(
        { ...options, reader, mode: "offline" },
        snapshot,
      ),
    ).toEqual(previous);
    expect(reader.read).not.toHaveBeenCalled();
    expect(
      (await readdir(join(directory, "definitions-v1"))).filter((name) =>
        name.startsWith("staging-"),
      ),
    ).toEqual([]);
  },
);

it("does not create an offline cohort when the first consumer fails", async () => {
  const { directory } = await fixture();
  const options = {
    directory,
    repositories,
    directories: [],
    reader: injectedReader(),
  };
  await expect(
    withDefinitionSources(options, async (sources) => {
      await snapshot(sources);
      throw new Error("invalid selection");
    }),
  ).rejects.toThrow("invalid selection");
  const reader = forbiddenReader();
  await expect(
    withDefinitionSources({ ...options, reader, mode: "offline" }, snapshot),
  ).rejects.toThrow(/offline input set/);
  expect(reader.read).not.toHaveBeenCalled();
});

it.each(["bytes", "executable bit", "missing file"] as const)(
  "refuses %s corruption offline and repairs it with a fresh export",
  async (corruption) => {
    const { directory } = await fixture();
    const reader = injectedReader();
    const options = { directory, repositories, directories: [], reader };
    const previous = await withDefinitionSources(options, snapshot);
    const asset = join(at(previous.skills, 0).directory, "assets/blob.bin");
    if (corruption === "bytes") {
      await chmod(asset, 0o600);
      await writeFile(asset, Buffer.from([9, 9, 9, 9, 9, 9]));
    } else if (corruption === "executable bit") {
      await chmod(asset, 0o555);
    } else {
      await rm(asset);
    }
    const offlineReader = forbiddenReader();
    await expect(
      withDefinitionSources(
        { ...options, reader: offlineReader, mode: "offline" },
        snapshot,
      ),
    ).rejects.toThrow(/corrupt|ENOENT/);
    expect(offlineReader.read).not.toHaveBeenCalled();
    const repaired = await withDefinitionSources(
      { ...options, mode: "refresh" },
      snapshot,
    );
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(repaired).toEqual(previous);
    expect(
      await readFile(join(at(repaired.skills, 0).directory, "assets/blob.bin")),
    ).toEqual(binary);
    expect(
      (await lstat(join(at(repaired.skills, 0).directory, "assets/blob.bin")))
        .mode & 0o111,
    ).toBe(0);
    expect(
      await withDefinitionSources(
        { ...options, reader: offlineReader, mode: "offline" },
        snapshot,
      ),
    ).toEqual(previous);
  },
);

it("refuses a corrupt completion record instead of falling back to loose trees", async () => {
  const { directory } = await fixture();
  const options = {
    directory,
    repositories,
    directories: [],
    reader: injectedReader(),
  };
  await withDefinitionSources(options, snapshot);
  // Discover the opaque recipe record on disk; no implementation internals are imported.
  const loads = join(directory, "definitions-v1", "loads");
  const records = await readdir(loads);
  expect(records).toHaveLength(1);
  await writeFile(join(loads, at(records, 0)), "{truncated crash record");
  const reader = forbiddenReader();
  await expect(
    withDefinitionSources({ ...options, reader, mode: "offline" }, snapshot),
  ).rejects.toThrow(/offline input set/);
  expect(reader.read).not.toHaveBeenCalled();
  const repaired = await withDefinitionSources(options, snapshot);
  expect(
    await withDefinitionSources(
      { ...options, reader, mode: "offline" },
      snapshot,
    ),
  ).toEqual(repaired);
});

it.each(["symlink", "fifo", "git metadata"] as const)(
  "rejects exported %s before consumption and keeps the prior cohort",
  async (unsafe) => {
    const { root, directory } = await fixture();
    const options = {
      directory,
      repositories,
      directories: [],
      reader: injectedReader(),
    };
    const previous = await withDefinitionSources(options, snapshot);
    const external = join(root, "external");
    await writeFile(external, "must not be followed");
    const reader: RepositoryReader = {
      async read(_request, destination) {
        await exportDefinitions(destination, "unsafe");
        if (unsafe === "symlink") {
          await symlink(external, join(destination, "link"));
        } else if (unsafe === "fifo") {
          await execute("mkfifo", [join(destination, "pipe")]);
        } else {
          await put(destination, ".git/config", "credential material");
        }
        return { commit: commitB };
      },
    };
    const consume = vi.fn<typeof snapshot>(snapshot);
    await expect(
      withDefinitionSources({ ...options, reader }, consume),
    ).rejects.toThrow(/links\/special|Git metadata/);
    expect(consume).not.toHaveBeenCalled();
    expect(
      await withDefinitionSources(
        { ...options, reader: forbiddenReader(), mode: "offline" },
        snapshot,
      ),
    ).toEqual(previous);
  },
);

it.each(["symlink", "fifo"] as const)(
  "rejects a %s in local inputs without publishing",
  async (unsafe) => {
    const { root, directory } = await fixture();
    const local = join(root, "local");
    await put(local, "reviewer/AGENT.md", "local");
    if (unsafe === "symlink") {
      await symlink("AGENT.md", join(local, "reviewer/link"));
    } else {
      await execute("mkfifo", [join(local, "reviewer/pipe")]);
    }
    const reader = forbiddenReader();
    const options = {
      directory,
      repositories: [],
      directories: [
        { kind: "agents" as const, alias: "local", directory: local },
      ],
      reader,
    };
    const consume = vi.fn<typeof snapshot>(snapshot);
    await expect(withDefinitionSources(options, consume)).rejects.toThrow(
      /links\/special/,
    );
    expect(consume).not.toHaveBeenCalled();
    await expect(
      withDefinitionSources({ ...options, mode: "offline" }, snapshot),
    ).rejects.toThrow(/offline input set/);
    expect(reader.read).not.toHaveBeenCalled();
  },
);

it.each([
  "../escape",
  "/absolute",
  "agents/../skills",
  "skills\\nested",
  "skills//nested",
  ".git",
  "skills/./nested",
  "skills\u0000nested",
])(
  "rejects unsafe configured discovery paths before invoking the reader: %j",
  async (path) => {
    const { root } = await fixture();
    expect(() =>
      parseEnvironmentConfiguration(
        {
          sourceDirectory: "cache",
          agentRepositories: [{ repository: "owner/definitions", path }],
          kaeno: { agent: "owner/definitions:reviewer" },
        },
        join(root, "config.json"),
      ),
    ).toThrow(/safe relative discovery path/);
  },
);

it("does not allow direct API discovery to escape the captured repository root", async () => {
  const { directory } = await fixture();
  // This path resolves outside the captured tree, even though the outside package is valid.
  await put(directory, "outside/AGENT.md", "outside the captured input");
  const consume = vi.fn<typeof snapshot>(snapshot);
  await expect(
    withDefinitionSources(
      {
        directory,
        directories: [],
        reader: injectedReader(),
        repositories: [{ ...at(repositories, 0), path: "../../../outside" }],
      },
      consume,
    ),
  ).rejects.toThrow(/path|root|outside|relative/i);
  expect(consume).not.toHaveBeenCalled();
});

it.each(["individual bytes", "total bytes", "file count"] as const)(
  "bounds exported %s before consumer invocation",
  async (limit) => {
    const { directory } = await fixture();
    const reader: RepositoryReader = {
      async read(_request, destination) {
        if (limit === "file count") {
          for (let start = 0; start < 16385; start += 128) {
            await Promise.all(
              Array.from(
                { length: Math.min(128, 16385 - start) },
                async (_, offset) => {
                  await writeFile(
                    join(destination, `file-${start + offset}`),
                    "",
                  );
                },
              ),
            );
          }
        } else {
          // Sparse files exercise real size accounting without allocating giant fixture buffers.
          for (
            let index = 0;
            index < (limit === "total bytes" ? 5 : 1);
            index++
          ) {
            const handle = await open(
              join(destination, `large-${index}`),
              "wx",
            );
            try {
              await handle.truncate(
                64 * 1024 * 1024 + (limit === "individual bytes" ? 1 : 0),
              );
            } finally {
              await handle.close();
            }
          }
        }
        return { commit: commitA };
      },
    };
    const consume = vi.fn<typeof snapshot>(snapshot);
    const options = {
      directory,
      repositories: [at(repositories, 0)],
      directories: [],
      reader,
    };
    await expect(withDefinitionSources(options, consume)).rejects.toThrow(
      /size\/file limit/,
    );
    expect(consume).not.toHaveBeenCalled();
    await expect(
      withDefinitionSources(
        { ...options, reader: forbiddenReader(), mode: "offline" },
        snapshot,
      ),
    ).rejects.toThrow(/offline input set/);
  },
);

it("rejects invalid resolved commits and overlapping selected packages without publishing", async () => {
  const { directory } = await fixture();
  const options = {
    directory,
    repositories,
    directories: [],
    reader: injectedReader("invalid", "not-a-commit"),
  };
  await expect(withDefinitionSources(options, snapshot)).rejects.toThrow();
  const reader: RepositoryReader = {
    async read(_request, destination) {
      await exportDefinitions(destination);
      await put(destination, "agents/AGENT.md", "overlapping parent");
      return { commit: commitA };
    },
  };
  await expect(
    withDefinitionSources({ ...options, reader }, snapshot),
  ).rejects.toThrow(/overlapping AGENT.md/);
  await expect(
    withDefinitionSources(
      { ...options, reader: forbiddenReader(), mode: "offline" },
      snapshot,
    ),
  ).rejects.toThrow(/offline input set/);
});

it("cancels before reading and during an export, retaining the prior complete cohort", async () => {
  const { directory } = await fixture();
  const options = {
    directory,
    repositories: twoRepositories,
    directories: [],
    reader: injectedReader(),
  };
  const previous = await withDefinitionSources(options, snapshot);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(new Error("pre-cancelled"));
  const unused = forbiddenReader();
  await expect(
    withDefinitionSources(
      { ...options, reader: unused, signal: alreadyAborted.signal },
      snapshot,
    ),
  ).rejects.toThrow("pre-cancelled");
  expect(unused.read).not.toHaveBeenCalled();
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reader: RepositoryReader = {
    async read(_request, destination, signal) {
      await exportDefinitions(destination, "cancelled");
      entered.resolve();
      await delay(60_000, undefined, { signal });
      return { commit: commitB };
    },
  };
  const outcome = observe(
    withDefinitionSources(
      { ...options, reader, signal: controller.signal },
      snapshot,
    ),
  );
  await entered.promise;
  controller.abort();
  expect(await outcome).toMatchObject({
    ok: false,
    error: expect.objectContaining({ name: "AbortError" }),
  });
  expect(
    await withDefinitionSources(
      { ...options, reader: unused, mode: "offline" },
      snapshot,
    ),
  ).toEqual(previous);
});

it("does not publish if cancellation arrives after the selected consumer resolves", async () => {
  const { directory } = await fixture();
  const options = {
    directory,
    repositories,
    directories: [],
    reader: injectedReader(),
  };
  const previous = await withDefinitionSources(options, snapshot);
  const controller = new AbortController();
  await expect(
    withDefinitionSources(
      {
        ...options,
        reader: injectedReader("cancelled", commitB),
        signal: controller.signal,
      },
      async (sources) => {
        await snapshot(sources);
        controller.abort(new Error("cancel before publication"));
      },
    ),
  ).rejects.toThrow("cancel before publication");
  expect(
    await withDefinitionSources(
      { ...options, reader: forbiddenReader(), mode: "offline" },
      snapshot,
    ),
  ).toEqual(previous);
});

it("cancels while waiting for another writer's lock without touching that writer's transaction", async () => {
  const { directory } = await fixture();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const options = {
    directory,
    repositories,
    directories: [],
    reader: injectedReader(),
  };
  const first = observe(
    withDefinitionSources(options, async (sources) => {
      entered.resolve();
      await finish.promise;
      return snapshot(sources);
    }),
  );
  await entered.promise;
  const controller = new AbortController();
  const reader = forbiddenReader();
  const second = observe(
    withDefinitionSources(
      { ...options, reader, signal: controller.signal },
      snapshot,
    ),
  );
  try {
    await delay(150);
    controller.abort();
    expect(await second).toMatchObject({
      ok: false,
      error: expect.objectContaining({ name: "AbortError" }),
    });
    expect(reader.read).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
  }
  const completed = await first;
  expect(completed.ok).toBe(true);
  if (!completed.ok) {
    throw completed.error;
  }
  expect(
    await withDefinitionSources(
      { ...options, reader, mode: "offline" },
      snapshot,
    ),
  ).toEqual(completed.value);
});

it("serializes concurrent writers through consumption and publishes only coherent whole-load cohorts", async () => {
  const { directory } = await fixture();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const options = { directory, repositories: twoRepositories, directories: [] };
  const first = observe(
    withDefinitionSources(
      { ...options, reader: injectedReader("writer-one") },
      async (sources) => {
        entered.resolve();
        await finish.promise;
        return snapshot(sources);
      },
    ),
  );
  await entered.promise;
  const secondReader = injectedReader("writer-two", commitB);
  const thirdReader = injectedReader("writer-three", "c".repeat(40));
  const others = [secondReader, thirdReader].map((reader) =>
    observe(withDefinitionSources({ ...options, reader }, snapshot)),
  );
  try {
    await delay(150);
    expect(secondReader.read).not.toHaveBeenCalled();
    expect(thirdReader.read).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
  }
  const outcomes = await Promise.all([first, ...others]);
  for (const outcome of outcomes) {
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw outcome.error;
    }
    expect(outcome.value.agents).toHaveLength(1);
    expect(outcome.value.skills).toHaveLength(1);
    expect(outcome.value.agents[0]?.manifest.split("---\n").at(-1)).toBe(
      outcome.value.skills[0]?.manifest.split("---\n").at(-1),
    );
    expect(outcome.value.agents[0]?.origin?.kind).toBe("repository");
    expect(outcome.value.skills[0]?.origin).toMatchObject({
      commit:
        outcome.value.agents[0]?.origin &&
        "commit" in outcome.value.agents[0].origin
          ? outcome.value.agents[0].origin.commit
          : "missing",
    });
  }
  const offline = await withDefinitionSources(
    { ...options, reader: forbiddenReader(), mode: "offline" },
    snapshot,
  );
  expect(
    outcomes.some(
      (outcome) =>
        outcome.ok && JSON.stringify(outcome.value) === JSON.stringify(offline),
    ),
  ).toBe(true);
  expect(secondReader.read).toHaveBeenCalledTimes(2);
  expect(thirdReader.read).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "survives SIGKILL before publication and recovers a dead process lock (previous cohort: %s)",
  async (hasPrevious) => {
    const { root, directory } = await fixture();
    const options = {
      directory,
      repositories: twoRepositories,
      directories: [],
      reader: injectedReader(),
    };
    const previous = hasPrevious
      ? await withDefinitionSources(options, snapshot)
      : undefined;
    const marker = join(root, "child-ready");
    const process = launchPausedWriter(directory, marker);
    await waitForChildReady(marker, process);
    expect(process.child.kill("SIGKILL")).toBe(true);
    expect(await process.exited).toEqual({ code: null, signal: "SIGKILL" });
    // proper-lockfile uses directory mtime for staleness; the owner is confirmed dead first.
    // Age only its actual lock, rather than waiting 30 seconds or deleting a live lock.
    const lockDirectory = join(directory, "definitions-v1.lock");
    expect((await lstat(lockDirectory)).isDirectory()).toBe(true);
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDirectory, old, old);
    const reader = forbiddenReader();
    const offlineOptions = { ...options, reader, mode: "offline" as const };
    if (hasPrevious) {
      expect(await withDefinitionSources(offlineOptions, snapshot)).toEqual(
        previous,
      );
    } else {
      await expect(
        withDefinitionSources(offlineOptions, snapshot),
      ).rejects.toThrow(/offline input set/);
    }
    expect(reader.read).not.toHaveBeenCalled();
    await expect(lstat(lockDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const refreshed = await withDefinitionSources(
      { ...options, reader: injectedReader("recovered", commitB) },
      snapshot,
    );
    expect(refreshed.agents[0]?.manifest).toContain("recovered");
    expect(refreshed.skills[0]?.manifest).toContain("recovered");
    expect(await withDefinitionSources(offlineOptions, snapshot)).toEqual(
      refreshed,
    );
  },
  20_000,
);
