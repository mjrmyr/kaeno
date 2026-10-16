import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

interface GitResult {
  stdout: string;
  stderr: string;
}
const execute = promisify(execFile);
const hooks = fileURLToPath(new URL("../../.husky/", import.meta.url));
const installer = fileURLToPath(
  new URL("../../node_modules/husky/bin.js", import.meta.url),
);

it("checks commits but does not run verification on push", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-git-hooks-"));
  const repository = join(directory, "repository");
  const remote = join(directory, "remote.git");
  const env = {
    ...process.env,
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    HUSKY: "1",
    CHECK_EXIT: "0",
    VERIFY_EXIT: "0",
  };
  const git = (
    args: string[],
    overrides: NodeJS.ProcessEnv = {},
  ): Promise<GitResult> =>
    execute("git", args, { cwd: repository, env: { ...env, ...overrides } });
  try {
    await mkdir(join(repository, ".husky"), { recursive: true });
    await execute("git", ["init", "--bare", remote], { env });
    await git(["init", "--initial-branch=main"]);
    await git(["config", "user.name", "Hook Fixture"]);
    await git(["config", "user.email", "hooks@example.invalid"]);
    await git(["config", "commit.gpgsign", "false"]);
    await git(["remote", "add", "origin", remote]);
    await expect(readFile(join(hooks, "pre-push"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await copyFile(
      join(hooks, "pre-commit"),
      join(repository, ".husky", "pre-commit"),
    );
    await writeFile(
      join(repository, "package.json"),
      JSON.stringify({
        private: true,
        scripts: {
          check: "node check.cjs check",
          verify: "node check.cjs verify",
        },
      }),
    );
    await writeFile(
      join(repository, "check.cjs"),
      'const fs = require("node:fs"); const phase = process.argv[2]; fs.appendFileSync("checks.log", phase + "\\n"); process.exit(Number(process.env[phase.toUpperCase() + "_EXIT"]));',
    );
    await execute(process.execPath, [installer], { cwd: repository, env });
    expect(
      (await git(["config", "--get", "core.hooksPath"])).stdout.trim(),
    ).toBe(".husky/_");
    await git(["add", ".husky", "package.json", "check.cjs"]);
    await expect(
      git(["commit", "-m", "fixture"], { CHECK_EXIT: "1" }),
    ).rejects.toThrow();
    await expect(git(["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
    await git(["commit", "-m", "fixture"]);
    await git(["push", "origin", "HEAD:main"], { VERIFY_EXIT: "1" });
    const commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
    expect(
      (await git(["ls-remote", "origin", "refs/heads/main"])).stdout,
    ).toContain(commit);
    expect(await readFile(join(repository, "checks.log"), "utf8")).toBe(
      "check\ncheck\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
