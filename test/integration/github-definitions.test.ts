import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { githubRepositoryReader } from "../../src/github/index.ts";

const execute = promisify(execFile);
const roots: string[] = [];
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
const app = { appId: "123", installationId: 12, privateKey };

async function fixture(): Promise<{
  root: string;
  repository: string;
  destination: string;
  git: (args: readonly string[]) => Promise<string>;
  put: (path: string, content: string | Uint8Array) => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "kaeno-definition-reader-test-"));
  roots.push(root);
  const repository = join(root, "repository");
  const destination = join(root, "export");
  await mkdir(repository, { mode: 0o700 });
  await mkdir(destination, { mode: 0o700 });
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await execute(
      "git",
      [
        "-C",
        repository,
        "-c",
        "user.name=Reader Fixture",
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
  const put = async (
    path: string,
    content: string | Uint8Array,
  ): Promise<void> => {
    await mkdir(join(repository, path, ".."), { recursive: true });
    await writeFile(join(repository, path), content);
  };
  await git(["init", "--initial-branch=trunk", "--template="]);
  await put(
    "AGENT.md",
    "---\nname: coordinator\ndescription: Fixture\n---\nInitial\n",
  );
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
  return { root, repository, destination, git, put };
}

async function assertNoMetadata(root: string): Promise<void> {
  expect(
    (await readdir(root)).filter((name) => name.startsWith(".kaeno-github-")),
  ).toEqual([]);
}

/** Host-only executable shim: forwards to real Git, or deterministically exercises failure/abort. */
async function auditGit(
  root: string,
  mode:
    | "forward"
    | "fail-network"
    | "wait-network"
    | "overflow-output"
    | "overflow-diagnostics" = "forward",
  token = "",
): Promise<string> {
  const realGit = (await execute("which", ["git"])).stdout.trim();
  const tools = join(root, "tools");
  const audit = join(root, "audit.jsonl");
  await mkdir(tools);
  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const directory = args[1];
const settings = Array.from({ length: Number(process.env.GIT_CONFIG_COUNT || 0) }, (_, index) => [process.env["GIT_CONFIG_KEY_" + index], process.env["GIT_CONFIG_VALUE_" + index]]);
const expected = ${JSON.stringify(`Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`)};
let config = "";
try { config = fs.readFileSync(path.join(directory, "config"), "utf8"); } catch {}
fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify({
  args,
  settings: settings.map(([key, value]) => [key, key.endsWith(".extraheader") ? "[redacted]" : value]),
  authenticated: settings.some(([key, value]) => key === "http.https://github.com/.extraheader" && value === expected),
  envKeys: Object.keys(process.env),
  home: process.env.HOME,
  config,
}) + "\\n");
if (args.includes("fetch") || args.includes("ls-remote")) {
  if (${JSON.stringify(mode)} === "fail-network") {
    process.stderr.write(${JSON.stringify(`remote diagnostic ${token} ${Buffer.from(`x-access-token:${token}`).toString("base64")}`)});
    process.stdout.write(${JSON.stringify(token)});
    process.exit(1);
  }
  if (${JSON.stringify(mode)} === "overflow-output") {
    process.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1, 120), () => process.exit(0));
    return;
  }
  if (${JSON.stringify(mode)} === "overflow-diagnostics") {
    process.stderr.write(Buffer.alloc(1024 * 1024 + 1, 120), () => process.exit(0));
    return;
  }
  if (${JSON.stringify(mode)} === "wait-network") {
    fs.writeFileSync(${JSON.stringify(join(root, "waiting"))}, "ready");
    setInterval(() => {}, 1000);
    return;
  }
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { env: process.env, stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
`;
  await writeFile(join(tools, "git"), script, { mode: 0o700 });
  vi.stubEnv("PATH", `${tools}:${process.env.PATH ?? ""}`);
  return audit;
}

async function auditRecords(path: string): Promise<unknown[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

it("exports tracked raw binary/executable files at default HEAD, without Git metadata or checkout execution", async () => {
  const { root, repository, destination, git, put } = await fixture();
  const binary = Buffer.from([0, 255, 128, 13, 10, 42]);
  await put("skills/data/blob.bin", binary);
  await put("skills/data/run.sh", "#!/bin/sh\necho fixture\n");
  await chmod(join(repository, "skills/data/run.sh"), 0o755);
  await put(".gitattributes", "*.bin filter=poison\n");
  await put("untracked", "never exported");
  await git(["add", "skills", ".gitattributes"]);
  await git(["commit", "-m", "assets"]);
  const commit = await git(["rev-parse", "HEAD"]);
  const marker = join(root, "executed");
  await git(["config", "filter.poison.smudge", `touch ${marker}`]);
  await git(["config", "filter.poison.required", "true"]);
  await mkdir(join(repository, ".git/hooks"));
  await writeFile(
    join(repository, ".git/hooks/post-checkout"),
    `#!/bin/sh\ntouch '${marker}'\n`,
    { mode: 0o700 },
  );
  const fetch = vi.fn<typeof globalThis.fetch>();
  const path = vi.fn<(repository: string) => string>(() => repository);
  const reader = githubRepositoryReader({
    host: { repositoryPath: path, fetch },
  });
  expect(
    await reader.read(
      { repository: "Owner/Definitions", ref: "HEAD" },
      destination,
    ),
  ).toEqual({ commit });
  expect(path).toHaveBeenCalledWith("owner/definitions");
  expect(fetch).not.toHaveBeenCalled();
  expect(await readFile(join(destination, "skills/data/blob.bin"))).toEqual(
    binary,
  );
  expect(
    (await lstat(join(destination, "skills/data/run.sh"))).mode & 0o111,
  ).toBe(0o100);
  expect(
    (await lstat(join(destination, "skills/data/blob.bin"))).isFile(),
  ).toBe(true);
  expect(await readdir(destination)).toEqual([
    ".gitattributes",
    "AGENT.md",
    "skills",
  ]);
  await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  await assertNoMetadata(root);
});

it("resolves moving branches, tags, qualified ambiguous names, and full commit pins", async () => {
  const { root, repository, destination, git, put } = await fixture();
  const reader = githubRepositoryReader({
    host: { repositoryPath: () => repository },
  });
  const first = await git(["rev-parse", "HEAD"]);
  await git(["tag", "-a", "release", "-m", "annotated release"]);
  await put("AGENT.md", "Updated\n");
  await git(["add", "."]);
  await git(["commit", "-m", "update default branch"]);
  const second = await git(["rev-parse", "HEAD"]);
  await git(["branch", "release"]);
  for (const [index, [ref, commit]] of [
    ["HEAD", second],
    ["trunk", second],
    ["refs/heads/release", second],
    ["refs/tags/release", first],
    [first, first],
  ].entries()) {
    const target = join(root, `target-${index}`);
    await mkdir(target);
    expect(
      await reader.read({ repository: "owner/repo", ref: ref ?? "" }, target),
    ).toEqual({ commit });
  }
  await expect(
    reader.read({ repository: "owner/repo", ref: "release" }, destination),
  ).rejects.toThrow("ambiguous");
  await expect(
    reader.read({ repository: "owner/repo", ref: "missing" }, destination),
  ).rejects.toThrow("missing");
  await assertNoMetadata(root);
});

it.each([
  "https://github.com/owner/repo",
  "owner/repo.git?token=secret",
  "owner/../repo",
  "owner/repo/extra",
  "--upload-pack=evil/repo",
  "owner/..",
  "owner/repo\n",
])(
  "rejects non-identity repository input before host/network access: %j",
  async (repository) => {
    const path = vi.fn<(repository: string) => string>(() => "/not-used");
    await expect(
      githubRepositoryReader({ host: { repositoryPath: path } }).read(
        { repository, ref: "HEAD" },
        "/not-used",
      ),
    ).rejects.toThrow("Invalid GitHub repository");
    expect(path).not.toHaveBeenCalled();
  },
);

it.each([
  "",
  "-option",
  "main:other",
  "main~1",
  "main^",
  "main..other",
  "main@{1}",
  "a\\b",
  "a b",
  "/main",
  "refs//main",
  "refs/heads/.hidden",
  "main.lock",
  "refs/heads/main.",
])("rejects ref syntax outside the strict boundary: %j", async (ref) => {
  const path = vi.fn<(repository: string) => string>(() => "/not-used");
  await expect(
    githubRepositoryReader({ host: { repositoryPath: path } }).read(
      { repository: "owner/repo", ref },
      "/not-used",
    ),
  ).rejects.toThrow("Invalid GitHub repository ref");
  expect(path).not.toHaveBeenCalled();
});

it.each(["symlink", "submodule", "unsafe-path", "lfs"] as const)(
  "rejects %s entries without publishing usable definitions",
  async (kind) => {
    const { root, repository, destination, git, put } = await fixture();
    if (kind === "symlink") {
      await symlink("../../outside", join(repository, "linked"));
      await git(["add", "linked"]);
    } else if (kind === "submodule") {
      const commit = await git(["rev-parse", "HEAD"]);
      await git([
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${commit},module`,
      ]);
    } else if (kind === "unsafe-path") {
      await put("bad\\path", "unsafe");
      await git(["add", "."]);
    } else {
      await put(
        "asset.bin",
        "version https://git-lfs.github.com/spec/v1\noid sha256:" +
          "a".repeat(64) +
          "\nsize 123\n",
      );
      await git(["add", "."]);
    }
    await git(["commit", "-m", kind]);
    await expect(
      githubRepositoryReader({
        host: { repositoryPath: () => repository },
      }).read({ repository: "owner/repo", ref: "HEAD" }, destination),
    ).rejects.toThrow(/reject|unsafe|LFS/);
    // The cache owns failed private export disposal; no unsafe entry or metadata is exported.
    expect(
      (await readdir(destination)).every((name) => name === "AGENT.md"),
    ).toBe(true);
    await assertNoMetadata(root);
  },
);

it("bounds blobs before exporting and refuses nonempty/symlink destinations", async () => {
  const { root, repository, destination, git, put } = await fixture();
  const reader = githubRepositoryReader({
    host: { repositoryPath: () => repository },
  });
  await put("huge.bin", Buffer.alloc(16 * 1024 * 1024 + 1));
  await git(["add", "."]);
  await git(["commit", "-m", "too large"]);
  await expect(
    reader.read({ repository: "owner/repo", ref: "HEAD" }, destination),
  ).rejects.toThrow("limits");
  expect(await readdir(destination)).toEqual([]);
  await writeFile(join(destination, "existing"), "preserved");
  await expect(
    reader.read({ repository: "owner/repo", ref: "HEAD" }, destination),
  ).rejects.toThrow("empty private directory");
  expect(await readFile(join(destination, "existing"), "utf8")).toBe(
    "preserved",
  );
  const link = join(root, "link");
  await symlink(destination, link);
  await expect(
    reader.read({ repository: "owner/repo", ref: "HEAD" }, link),
  ).rejects.toThrow("empty private directory");
  await assertNoMetadata(root);
});

it("isolates public Git from inherited home/config/helpers/askpass and never requests App tokens", async () => {
  const { root, repository, destination } = await fixture();
  const audit = await auditGit(root);
  await writeFile(
    join(root, ".gitconfig"),
    "[credential]\n helper = !touch should-not-run\n",
  );
  for (const name of [
    "HOME",
    "XDG_CONFIG_HOME",
    "GIT_CONFIG_GLOBAL",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    vi.stubEnv(name, root);
  }
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", "credential.helper");
  vi.stubEnv("GIT_CONFIG_VALUE_0", "!touch should-not-run");
  const fetch = vi.fn<typeof globalThis.fetch>();
  await githubRepositoryReader({
    host: { repositoryPath: () => repository, fetch },
  }).read({ repository: "owner/repo", ref: "HEAD" }, destination);
  expect(fetch).not.toHaveBeenCalled();
  const records = await auditRecords(audit);
  for (const record of records) {
    expect(record).toMatchObject({ authenticated: false });
    expect(record).toHaveProperty(
      "settings",
      expect.arrayContaining([
        ["credential.helper", ""],
        ["core.hooksPath", "/dev/null"],
        ["http.followRedirects", "false"],
        ["protocol.allow", "never"],
      ]),
    );
    expect(record).toHaveProperty(
      "envKeys",
      expect.not.arrayContaining([
        "GIT_ASKPASS",
        "SSH_ASKPASS",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      ]),
    );
    expect(record).not.toHaveProperty("home", root);
    expect(record).toHaveProperty(
      "settings",
      expect.not.arrayContaining([
        ["http.https://github.com/.extraheader", "[redacted]"],
      ]),
    );
  }
  await assertNoMetadata(root);
});

it("uses an ephemeral host-scoped App header only for transport; exported bytes and disk config stay credential-free", async () => {
  const { root, repository, destination } = await fixture();
  const token = "installation-token-private";
  const audit = await auditGit(root, "forward", token);
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(String(input)).toBe(
      "https://api.github.com/app/installations/12/access_tokens",
    );
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({
      authorization: expect.stringMatching(/^Bearer [\w.-]+$/),
    });
    expect(JSON.parse(String(init?.body))).toEqual({});
    return Response.json({ token });
  });
  await githubRepositoryReader({
    app,
    host: { repositoryPath: () => repository, fetch },
  }).read({ repository: "owner/private", ref: "HEAD" }, destination);
  expect(fetch).toHaveBeenCalledTimes(1);
  const records = await auditRecords(audit);
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        authenticated: true,
        args: expect.arrayContaining(["fetch"]),
      }),
    ]),
  );
  for (const record of records) {
    expect(record).toHaveProperty("config", expect.not.stringContaining(token));
    expect(record).toHaveProperty(
      "config",
      expect.not.stringContaining("extraheader"),
    );
    expect(record).toHaveProperty(
      "args",
      expect.not.arrayContaining([expect.stringContaining(token)]),
    );
    if (
      typeof record === "object" &&
      record !== null &&
      "authenticated" in record &&
      record.authenticated === true
    ) {
      expect(record).toHaveProperty("args", expect.arrayContaining(["fetch"]));
    }
  }
  expect(await readFile(join(destination, "AGENT.md"), "utf8")).not.toContain(
    token,
  );
  expect(await readdir(destination)).toEqual(["AGENT.md"]);
  await assertNoMetadata(root);
});

it("redacts raw and encoded credentials from Git errors, using a fixed GitHub URL", async () => {
  const { root, destination } = await fixture();
  const token = "do-not-leak-git-credential";
  const audit = await auditGit(root, "fail-network", token);
  const fetch: typeof globalThis.fetch = async () => Response.json({ token });
  const operation = githubRepositoryReader({ app, host: { fetch } }).read(
    { repository: "Owner/Private", ref: "HEAD" },
    destination,
  );
  await expect(operation).rejects.toThrow("GitHub Git operation failed");
  await expect(operation).rejects.not.toThrow(token);
  await expect(operation).rejects.not.toThrow(
    Buffer.from(`x-access-token:${token}`).toString("base64"),
  );
  expect(await auditRecords(audit)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        args: expect.arrayContaining(["https://github.com/owner/private.git"]),
        authenticated: true,
      }),
    ]),
  );
  expect(await readdir(destination)).toEqual([]);
  await assertNoMetadata(root);
});

it("redacts App response/host exceptions without silently falling back to public fetch", async () => {
  const { root, repository, destination } = await fixture();
  const secret = "token-private-material";
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new Error(secret);
  });
  const reader = githubRepositoryReader({
    app,
    host: { repositoryPath: () => repository, fetch },
  });
  await expect(
    reader.read({ repository: "owner/private", ref: "HEAD" }, destination),
  ).rejects.toThrow("App credentials");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await readdir(destination)).toEqual([]);
  await assertNoMetadata(root);
  await expect(
    githubRepositoryReader({
      host: {
        repositoryPath: () => {
          throw new Error(secret);
        },
      },
    }).read({ repository: "owner/repo", ref: "HEAD" }, destination),
  ).rejects.not.toThrow(secret);
  await assertNoMetadata(root);
});

it.each([
  ["overflow-output", "output"],
  ["overflow-diagnostics", "diagnostics"],
] as const)(
  "bounds Git %s without surfacing remote buffers",
  async (mode, label) => {
    const { root, repository, destination } = await fixture();
    await auditGit(root, mode);
    await expect(
      githubRepositoryReader({
        host: { repositoryPath: () => repository },
      }).read({ repository: "owner/repo", ref: "HEAD" }, destination),
    ).rejects.toThrow(`GitHub Git ${label} exceeds the size limit`);
    expect(await readdir(destination)).toEqual([]);
    await assertNoMetadata(root);
  },
);

it("enforces a 120-second Git-operation timeout and cleans the stopped transport", async () => {
  const { root, repository, destination } = await fixture();
  await auditGit(root, "wait-network");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const controller = new AbortController();
  const operation = githubRepositoryReader({
    host: { repositoryPath: () => repository },
  }).read(
    { repository: "owner/repo", ref: "HEAD" },
    destination,
    controller.signal,
  );
  const outcome = operation.then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  try {
    await vi.waitFor(
      async () => {
        expect(await readFile(join(root, "waiting"), "utf8")).toBe("ready");
      },
      { timeout: 5000 },
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await outcome).toMatchObject({
      error: expect.objectContaining({
        message: "GitHub Git operation timed out (120 seconds)",
      }),
    });
  } finally {
    controller.abort();
    await outcome;
    vi.useRealTimers();
  }
  expect(await readdir(destination)).toEqual([]);
  await assertNoMetadata(root);
});

it("cancels in-flight Git, redacts arbitrary abort reasons, and cleans temporary metadata", async () => {
  const { root, repository, destination } = await fixture();
  await auditGit(root, "wait-network");
  const controller = new AbortController();
  const operation = githubRepositoryReader({
    host: { repositoryPath: () => repository },
  }).read(
    { repository: "owner/repo", ref: "HEAD" },
    destination,
    controller.signal,
  );
  // Attach rejection handling before triggering the cancellation.
  const outcome = operation.then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  try {
    await vi.waitFor(async () => {
      expect(await readFile(join(root, "waiting"), "utf8")).toBe("ready");
    });
  } finally {
    controller.abort(new Error("secret-abort-reason"));
  }
  expect(await outcome).toMatchObject({
    error: expect.objectContaining({
      message: "GitHub repository read cancelled",
    }),
  });
  expect(await readdir(destination)).toEqual([]);
  await assertNoMetadata(root);
  await expect(
    githubRepositoryReader().read(
      { repository: "owner/repo", ref: "HEAD" },
      destination,
      controller.signal,
    ),
  ).rejects.not.toThrow("secret-abort-reason");
});
