import { execFile } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Server } from "node:http";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { JsonObject } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { z } from "zod";
import { openKaeno, type Kaeno } from "../../src/application/index.ts";
import {
  EnvironmentServer,
  RemoteExecutionEnv,
} from "../../src/execution/index.ts";
import {
  githubBinding,
  githubExtension,
  GITHUB_TOOLS,
  HostGit,
  GitHubClient,
  type GitHubPull,
  type RepositoryTransport,
} from "../../src/github/index.ts";

const execute = promisify(execFile);
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const installationId = 12;

async function git(path: string, ...args: string[]): Promise<string> {
  return (
    await execute("git", ["-C", path, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    })
  ).stdout.trim();
}

function githubApi() {
  const requests: { path: string; body: unknown }[] = [];
  const pulls: GitHubPull[] = [];
  let failAfterCreate = false;
  let forbidden = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ path: url.pathname, body });
    if (forbidden) {
      return Response.json(
        { message: "secret-token must not leak" },
        { status: 403 },
      );
    }
    if (url.pathname === "/app/installations/12/access_tokens") {
      const jwt =
        new Headers(init?.headers)
          .get("authorization")
          ?.replace("Bearer ", "") ?? "";
      const [header, payload, signature] = jwt.split(".");
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          keys.publicKey,
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(true);
      expect(
        JSON.parse(Buffer.from(payload, "base64url").toString()),
      ).toMatchObject({ iss: "123" });
      const requested = z
        .object({ repository_ids: z.array(z.number()).optional() })
        .strict()
        .parse(body);
      if (requested.repository_ids?.includes(99)) {
        return Response.json({}, { status: 422 });
      }
      return Response.json({ token: "secret-token" });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer secret-token",
    );
    const repository = {
      id: 34,
      full_name: "owner/private",
      default_branch: "main",
    };
    if (url.pathname === "/installation/repositories") {
      return Response.json({
        repositories: [
          repository,
          { id: 56, full_name: "owner/other", default_branch: "main" },
        ],
      });
    }
    if (url.pathname === "/repositories/34") {
      return Response.json(repository);
    }
    if (url.pathname === "/repos/owner/private/pulls") {
      if (init?.method === "POST") {
        const draft = z
          .object({
            head: z.string(),
            base: z.string(),
            draft: z.literal(true),
          })
          .parse(body);
        const pull: GitHubPull = {
          number: 1,
          html_url: "https://github.com/owner/private/pull/1",
          state: "open",
          draft: true,
          head: { ref: draft.head, repo: { id: 34 } },
          base: { ref: draft.base },
        };
        pulls.push(pull);
        if (failAfterCreate) {
          failAfterCreate = false;
          return Response.json({}, { status: 502 });
        }
        return Response.json(pull);
      }
      return Response.json(pulls);
    }
    throw new Error(`Unexpected API request: ${url.pathname}`);
  };
  return {
    fetch,
    requests,
    pulls,
    failNextCreate: () => {
      failAfterCreate = true;
    },
    deny: () => {
      forbidden = true;
    },
  };
}

it("checks out private code without credentials, preserves edits, publishes binary changes, and reconciles a failed PR response across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-github-test-"));
  let core: Kaeno | undefined;
  let environmentServer: Server | undefined;
  try {
    const source = join(directory, "source");
    const remote = join(directory, "remote.git");
    const workspace = join(directory, "workspace");
    await mkdir(source);
    await mkdir(workspace);
    await git(source, "init", "-b", "main");
    await writeFile(join(source, "README.md"), "original\n");
    await writeFile(join(source, ".gitignore"), "ignored.txt\n");
    await writeFile(join(source, "removed.txt"), "remove this\n");
    await git(source, "add", ".");
    await git(
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-m",
      "Initial",
    );
    await git(directory, "clone", "--bare", source, remote);
    const host = new HostGit();
    const transport: RepositoryTransport = {
      checkout: async (_remote, ref, token, signal) => {
        expect(token).toBe("secret-token");
        const bundle = await host.checkout(remote, ref, token, signal);
        expect(Buffer.from(bundle.bundle).includes(Buffer.from(token))).toBe(
          false,
        );
        return bundle;
      },
      publish: async (_remote, branch, bundle, sha, expected, token, signal) =>
        host.publish(remote, branch, bundle, sha, expected, token, signal),
    };
    const api = githubApi();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const storagePath = join(directory, "test.sqlite");
    const server = new EnvironmentServer(
      "environment-token",
      (cwd) => new NodeExecutionEnv({ cwd }),
      workspace,
    ).server;
    environmentServer = server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP environment address");
    }
    const env = new RemoteExecutionEnv(
      `http://127.0.0.1:${address.port}`,
      "environment-token",
      "sandbox",
      workspace,
      fetch,
    );
    const rename = env.renameFile.bind(env);
    let interruptCheckout = true;
    env.renameFile = async (sourcePath, destination, ctx) => {
      const result = await rename(sourcePath, destination, ctx);
      if (result.ok && interruptCheckout) {
        interruptCheckout = false;
        throw new Error("Simulated crash after checkout rename");
      }
      return result;
    };
    const extension = githubExtension({
      appId: "123",
      privateKey,
      installationId,
      fetch: api.fetch,
      transport,
    });
    const open = async () =>
      openKaeno({
        storage: await openNodeSqliteStorage(storagePath),
        models,
        assistant: {
          model: { provider: "faux", modelId: "faux-1" },
          instructions: "Code carefully.",
          tools: GITHUB_TOOLS,
          bindings: [githubBinding(installationId)],
        },
        extensions: [{ ...extension, environment: () => env }],
      });
    core = await open();
    let counter = 0;
    let prompt = "";
    const invoke = async (name: string, args: JsonObject) => {
      const opened = core;
      if (!opened) {
        throw new Error("closed");
      }
      let result = "";
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall(name, args)], {
          stopReason: "toolUse",
        }),
        async (request) => {
          prompt = getCurrentSystemPrompt(request.messages);
          result = JSON.stringify(
            request.messages.findLast(
              (message) => message.role === "toolResult",
            ),
          );
          return fauxAssistantMessage("DONE");
        },
      ]);
      const id = await opened.threads.getOrCreateConversation("github-test");
      const task = await opened.harness.commit(
        (tx) =>
          opened.turns.admitUserTurn(
            tx,
            id,
            "Do the requested operation",
            `request-${counter++}`,
          ),
        context,
      );
      await opened.harness.waitForTask(task, context);
      return result;
    };
    const list = await invoke(GITHUB_TOOLS[0], {});
    expect(list).toContain("owner/private");
    expect(list).toContain("owner/other");
    expect(prompt).toContain("Use github_checkout");
    expect(prompt).not.toContain("secret-token");
    const rejected = await invoke(GITHUB_TOOLS[1], { repository: 99 });
    expect(rejected).toContain("HTTP 422");
    expect(
      api.requests.some((request) => request.path === "/repositories/99"),
    ).toBe(false);
    const checkout = await invoke(GITHUB_TOOLS[1], { repository: 34 });
    expect(checkout).toContain("Simulated crash after checkout rename");
    const path = join(workspace, ".kaeno-github/34");
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("original\n");
    expect(await git(path, "remote", "-v")).toBe("");
    await writeFile(join(path, "README.md"), "changed\n");
    await writeFile(join(path, "binary.dat"), Buffer.from([0, 255, 1, 128]));
    await writeFile(join(path, "ignored.txt"), "do not publish");
    await rm(join(path, "removed.txt"));
    await writeFile(join(path, "run.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(path, "run.sh"), 0o755);
    await symlink("README.md", join(path, "readme-link"));
    expect(await invoke(GITHUB_TOOLS[1], { repository: 34 })).not.toContain(
      '"isError":true',
    );
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("changed\n");
    expect(
      await invoke(GITHUB_TOOLS[1], { repository: 34, branch: "other" }),
    ).toContain("different branch");
    api.failNextCreate();
    const publishArgs = {
      repository: 34,
      title: "Fix private project",
      body: "Verified locally",
    };
    expect(await invoke(GITHUB_TOOLS[2], publishArgs)).toContain("HTTP 502");
    expect(api.pulls).toHaveLength(1);
    const firstHead = await git(
      remote,
      "rev-parse",
      `refs/heads/${api.pulls[0].head.ref}`,
    );
    await writeFile(join(path, "README.md"), "later edit\n");
    await core.close();
    const database = await readFile(storagePath);
    expect(database.includes(Buffer.from("secret-token"))).toBe(false);
    expect(database.includes(Buffer.from(privateKey))).toBe(false);
    core = await open();
    const resumed = await invoke(GITHUB_TOOLS[2], publishArgs);
    expect(resumed).toContain("https://github.com/owner/private/pull/1");
    expect(api.pulls).toHaveLength(1);
    expect(
      await git(remote, "rev-parse", `refs/heads/${api.pulls[0].head.ref}`),
    ).toBe(firstHead);
    expect(await git(remote, "show", `${firstHead}:README.md`)).toBe("changed");
    expect(await git(remote, "ls-tree", "--name-only", firstHead)).toContain(
      "binary.dat",
    );
    expect(
      await git(remote, "ls-tree", "--name-only", firstHead),
    ).not.toContain("ignored.txt");
    expect(
      await git(remote, "ls-tree", "--name-only", firstHead),
    ).not.toContain("removed.txt");
    expect(await git(remote, "ls-tree", firstHead, "run.sh")).toContain(
      "100755",
    );
    expect(await git(remote, "ls-tree", firstHead, "readme-link")).toContain(
      "120000",
    );
    const binary = await execute(
      "git",
      ["-C", remote, "show", `${firstHead}:binary.dat`],
      { encoding: "buffer" },
    );
    expect(binary.stdout).toEqual(Buffer.from([0, 255, 1, 128]));
    expect(await invoke(GITHUB_TOOLS[2], publishArgs)).not.toContain(
      '"isError":true',
    );
    const secondHead = await git(
      remote,
      "rev-parse",
      `refs/heads/${api.pulls[0].head.ref}`,
    );
    expect(secondHead).not.toBe(firstHead);
    expect(await git(remote, "rev-parse", `${secondHead}^`)).toBe(firstHead);
    expect(await git(remote, "show", `${secondHead}:README.md`)).toBe(
      "later edit",
    );
    expect(await invoke(GITHUB_TOOLS[2], publishArgs)).not.toContain(
      '"isError":true',
    );
    expect(
      await git(remote, "rev-parse", `refs/heads/${api.pulls[0].head.ref}`),
    ).toBe(secondHead);
    api.pulls[0].draft = false;
    await writeFile(join(path, "README.md"), "not yet reviewed\n");
    expect(await invoke(GITHUB_TOOLS[2], publishArgs)).toContain("non-draft");
    expect(
      await git(remote, "rev-parse", `refs/heads/${api.pulls[0].head.ref}`),
    ).toBe(secondHead);
    api.deny();
    expect(await invoke(GITHUB_TOOLS[2], publishArgs)).toContain("HTTP 403");
    expect(await invoke(GITHUB_TOOLS[0], {})).toContain("HTTP 403");
  } finally {
    await core?.close();
    if (environmentServer) {
      const server = environmentServer;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects unexpected remote heads instead of overwriting them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-github-conflict-"));
  try {
    await git(directory, "init", "-b", "main");
    await writeFile(join(directory, "file"), "initial");
    await git(directory, "add", ".");
    await git(
      directory,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-m",
      "Initial",
    );
    const initial = await git(directory, "rev-parse", "HEAD");
    await git(directory, "branch", "kaeno-export");
    const bundlePath = join(directory, "source.bundle");
    await git(
      directory,
      "bundle",
      "create",
      bundlePath,
      "refs/heads/kaeno-export",
    );
    const host = new HostGit();
    const bundle = await readFile(bundlePath);
    await expect(
      host.publish(directory, "main", bundle, initial, null, "secret"),
    ).resolves.toBeUndefined();
    await git(
      directory,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "--allow-empty",
      "-m",
      "Concurrent",
    );
    const concurrent = await git(directory, "rev-parse", "HEAD");
    await expect(
      host.publish(directory, "main", bundle, initial, initial, "secret"),
    ).rejects.toThrow("changed unexpectedly");
    expect(await git(directory, "rev-parse", "HEAD")).toBe(concurrent);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("inherits installation permissions and discovers all installation repositories without local allowlists", async () => {
  const api = githubApi();
  const client = new GitHubClient({
    appId: "123",
    privateKey,
    fetch: api.fetch,
  });
  const token = await client.token(installationId);
  expect(api.requests[0].body).toEqual({});
  expect(
    (await client.repositories(token)).map((repository) => repository.id),
  ).toEqual([34, 56]);
  await client.token(installationId, 34);
  expect(api.requests.at(-1)?.body).toEqual({ repository_ids: [34] });
  await expect(client.token(installationId, 99)).rejects.toThrow("HTTP 422");
});

it("does not expose API response secrets in authorization failures", async () => {
  const api = githubApi();
  const client = new GitHubClient({
    appId: "123",
    privateKey,
    fetch: api.fetch,
  });
  api.deny();
  await expect(client.token(installationId)).rejects.toThrow("HTTP 403");
  await expect(client.token(installationId)).rejects.not.toThrow(
    "secret-token",
  );
});
