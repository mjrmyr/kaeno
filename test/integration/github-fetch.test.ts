import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type JsonObject } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it, vi } from "vitest";
import { openKaeno } from "../../src/core/application/index.ts";
import {
  githubBinding,
  githubExtension,
  GITHUB_TOOLS,
  HostGit,
  type RepositoryTransport,
} from "../../src/extensions/github/index.ts";
import { ask, startTicket, until } from "../mocks/router.ts";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";

const execute = promisify(execFile);
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
const repository = {
  id: 34,
  full_name: "owner/private",
  default_branch: "main",
};

async function git(path: string, ...args: string[]) {
  const result = await execute("git", ["-C", path, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_MERGE_AUTOEDIT: "no",
    },
  });
  return result.stdout.trim();
}

async function fixture(options: { work?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-github-fetch-"));
  const remote = join(directory, "remote.git");
  const owner = join(directory, "owner");
  await execute("git", ["init", "--bare", "--initial-branch=main", remote]);
  await execute("git", ["clone", remote, owner]);
  await writeFile(join(owner, "shared.txt"), "initial\n");
  await git(owner, "add", ".");
  await git(owner, "commit", "-m", "Initial");
  await git(owner, "push", "origin", "main");
  const env = new NodeExecutionEnv({ cwd: directory });
  const host = new HostGit();
  const transport: RepositoryTransport = {
    checkout: vi.fn<RepositoryTransport["checkout"]>(
      async (url, ref, token, signal) => {
        expect(url).toBe("https://github.com/owner/private.git");
        expect(token).toBe("host-only-token");
        return host.checkout(remote, ref, token, signal);
      },
    ),
    publish: vi.fn<RepositoryTransport["publish"]>(
      async (_url, branch, bundle, sha, expected, token, signal) =>
        host.publish(remote, branch, bundle, sha, expected, token, signal),
    ),
  };
  let pull: JsonObject | undefined;
  const comments: JsonObject[] = [];
  let loseCommentResponse = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/access_tokens")) {
      expect(JSON.parse(String(init?.body))).toEqual({ repository_ids: [34] });
      return Response.json({ token: "host-only-token" });
    }
    if (url.pathname === "/repositories/34") {
      return Response.json(repository);
    }
    if (url.pathname === "/repos/owner/private/pulls") {
      if (init?.method === "POST") {
        const args = JSON.parse(String(init.body));
        expect(args.draft).toBe(false);
        pull = {
          number: 12,
          node_id: "PR_node",
          html_url: "https://github.com/owner/private/pull/12",
          state: "open",
          draft: false,
          head: { ref: args.head, repo: { id: 34 } },
          base: { ref: args.base },
        };
        return Response.json(pull);
      }
      return Response.json(pull ? [pull] : []);
    }
    if (url.pathname === "/repos/owner/private/pulls/12") {
      return Response.json({
        ...pull,
        title: "Changes",
        merged: false,
        head: { ref: "work", sha: "a".repeat(40), repo: repository },
        base: { ref: "main", sha: "b".repeat(40), repo: repository },
      });
    }
    if (url.pathname === "/repos/owner/private/issues/12/comments") {
      if (init?.method === "POST") {
        const comment = {
          id: comments.length + 1,
          html_url: `https://github.com/owner/private/pull/12#issuecomment-${comments.length + 1}`,
          ...JSON.parse(String(init.body)),
        };
        comments.push(comment);
        if (loseCommentResponse) {
          loseCommentResponse = false;
          throw new Error("lost comment response");
        }
        return Response.json(comment);
      }
      return Response.json(comments);
    }
    throw new Error(`Unexpected GitHub request: ${url.pathname}`);
  });
  const extension = githubExtension({
    appId: "123",
    installationId: 12,
    privateKey,
    fetch,
    transport,
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  async function open() {
    return openKaeno({
      storage: await openNodeSqliteStorage(join(directory, "core.sqlite")),
      models,
      assistant: {
        model: { provider: "faux", modelId: "faux-1" },
        instructions: "Use GitHub",
        tools: [...GITHUB_TOOLS],
        bindings: [githubBinding(12)],
      },
      extensions: [{ ...extension.runtime, environment: () => env }],
      ...(options.work
        ? {
            work: {
              agents: [
                {
                  id: "coder",
                  description: "Codes",
                  setup: {
                    model: { provider: "faux", modelId: "faux-1" },
                    instructions: "WORKER",
                    tools: [...GITHUB_TOOLS],
                    bindings: [githubBinding(12)],
                  },
                },
              ],
              tools: [...GITHUB_TOOLS],
              maxConcurrent: 1,
            },
          }
        : {}),
    });
  }
  let core = await open();
  let trigger = 0;
  async function call(
    name: string,
    args: JsonObject = { repository: 34 },
  ): Promise<JsonObject> {
    let result: { isError: boolean; text: string } | undefined;
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall(name, { ...args, basis: `t${++trigger}` })],
        {
          stopReason: "toolUse",
        },
      ),
      async (request) => {
        const message = request.messages.findLast(
          (value) => value.role === "toolResult",
        );
        if (message?.role === "toolResult") {
          result = {
            isError: message.isError,
            text: JSON.stringify(message.content),
          };
        }
        return fauxAssistantMessage("Done");
      },
    ]);
    expect(await ask(core, name)).toBe("Done");
    if (!result) {
      throw new Error("No tool result");
    }
    const content = JSON.parse(result.text);
    if (result.isError) {
      throw new Error(content[0].text);
    }
    expect(result.text).not.toContain("host-only-token");
    return JSON.parse(content[0].text);
  }
  const checkout = options.work
    ? { path: directory }
    : await call("github_checkout");
  const path = String(checkout.path);
  async function publish() {
    return call("github_publish", {
      repository: 34,
      title: "Changes",
      body: "Tested",
    });
  }
  async function initialPublish() {
    await writeFile(join(path, "worker.txt"), "worker\n");
    return publish();
  }
  async function ownerPush(
    branch: string,
    file = "owner.txt",
    value = "owner\n",
  ) {
    await git(owner, "fetch", "origin", branch);
    await git(owner, "checkout", "-B", "work", "FETCH_HEAD");
    await writeFile(join(owner, file), value);
    await git(owner, "add", ".");
    await git(owner, "commit", "-m", "Owner changes");
    await git(owner, "push", "origin", `HEAD:refs/heads/${branch}`);
    return git(owner, "rev-parse", "HEAD");
  }
  return {
    path,
    remote,
    owner,
    env,
    transport,
    call,
    publish,
    initialPublish,
    ownerPush,
    faux,
    comments,
    fetch,
    get core() {
      return core;
    },
    loseCommentResponse() {
      loseCommentResponse = true;
    },
    async restart() {
      await core.close();
      core = await open();
    },
    async close() {
      await core.close();
      await env.cleanup(context);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("publishes snapshots with the kaeno bot author and committer identity", async () => {
  const fx = await fixture();
  try {
    const published = await fx.initialPublish();
    expect(
      await git(
        fx.remote,
        "show",
        "-s",
        "--format=%an <%ae>%n%cn <%ce>",
        String(published.sha),
      ),
    ).toBe("kaeno <bot@kaeno.io>\nkaeno <bot@kaeno.io>");
  } finally {
    await fx.close();
  }
});

it("fetches without touching local edits, survives restart, and publishes on the incorporated owner's commit", async () => {
  const fx = await fixture();
  try {
    const first = await fx.initialPublish();
    const owner = await fx.ownerPush(String(first.branch));
    await writeFile(join(fx.path, "local.txt"), "in progress\n");
    const head = await git(fx.path, "rev-parse", "HEAD");
    const status = await git(fx.path, "status", "--porcelain");
    const fetched = await fx.call("github_fetch");
    expect(fetched.sha).toBe(owner);
    expect(fetched.ref).toBe("refs/remotes/kaeno/work");
    expect(await git(fx.path, "rev-parse", "HEAD")).toBe(head);
    expect(await git(fx.path, "status", "--porcelain")).toBe(status);
    expect(await readFile(join(fx.path, "local.txt"), "utf8")).toBe(
      "in progress\n",
    );
    expect(await git(fx.path, "remote", "-v")).toBe("");
    await fx.restart();
    await expect(fx.publish()).rejects.toThrow("merge or rebase");
    await fx.call("github_fetch"); // Repeating fetch preserves the same files and ref.
    await git(fx.path, "add", ".");
    await git(fx.path, "commit", "-m", "Preserve local edits");
    await git(fx.path, "merge", "refs/remotes/kaeno/work");
    const second = await fx.publish();
    expect(await git(fx.remote, "rev-parse", `${second.sha}^`)).toBe(owner);
    expect(await git(fx.remote, "show", `${second.sha}:owner.txt`)).toBe(
      "owner",
    );
    expect(await git(fx.remote, "show", `${second.sha}:local.txt`)).toBe(
      "in progress",
    );
    await writeFile(join(fx.path, "local.txt"), "next edit\n");
    const third = await fx.publish();
    expect(await git(fx.remote, "rev-parse", `${third.sha}^`)).toBe(second.sha);
  } finally {
    await fx.close();
  }
});

it("lets the worker resolve Git conflicts and refuses to snapshot an unfinished merge", async () => {
  const fx = await fixture();
  try {
    const first = await fx.initialPublish();
    const owner = await fx.ownerPush(
      String(first.branch),
      "shared.txt",
      "owner version\n",
    );
    await writeFile(join(fx.path, "shared.txt"), "worker version\n");
    await git(fx.path, "add", ".");
    await git(fx.path, "commit", "-m", "Local work");
    await fx.call("github_fetch");
    await expect(
      git(fx.path, "merge", "refs/remotes/kaeno/work"),
    ).rejects.toThrow();
    await expect(fx.publish()).rejects.toThrow();
    await writeFile(join(fx.path, "shared.txt"), "resolved together\n");
    await git(fx.path, "add", ".");
    // Even staged resolutions must not be published before the merge is finished.
    await expect(fx.publish()).rejects.toThrow("finish or abort");
    await git(fx.path, "commit", "-m", "Resolve owner changes");
    const result = await fx.publish();
    expect(await git(fx.remote, "rev-parse", `${result.sha}^`)).toBe(owner);
    expect(await git(fx.remote, "show", `${result.sha}:shared.txt`)).toBe(
      "resolved together",
    );
  } finally {
    await fx.close();
  }
});

it("recovers from a concurrent remote push by explicitly fetching instead of retrying a stale publish intent", async () => {
  const fx = await fixture();
  try {
    const first = await fx.initialPublish();
    await fx.ownerPush(String(first.branch));
    await fx.call("github_fetch");
    await git(fx.path, "add", ".");
    await git(fx.path, "commit", "-m", "Preserve local edits");
    await git(fx.path, "merge", "refs/remotes/kaeno/work");
    await writeFile(join(fx.path, "local.txt"), "more work\n");
    const newest = await fx.ownerPush(
      String(first.branch),
      "another.txt",
      "new push\n",
    );
    await expect(fx.publish()).rejects.toThrow("remote work branch changed");
    await fx.restart();
    await expect(fx.publish()).rejects.toThrow("remote work branch changed");
    await fx.call("github_fetch");
    await git(fx.path, "merge", "refs/remotes/kaeno/work");
    const result = await fx.publish();
    expect(await git(fx.remote, "rev-parse", `${result.sha}^`)).toBe(newest);
    expect(await git(fx.remote, "show", `${result.sha}:local.txt`)).toBe(
      "more work",
    );
    expect(await git(fx.remote, "show", `${result.sha}:another.txt`)).toBe(
      "new push",
    );
  } finally {
    await fx.close();
  }
});

function loseNextPublishResponse(transport: RepositoryTransport) {
  const publish = vi.mocked(transport.publish);
  const original = publish.getMockImplementation();
  if (!original) {
    throw new Error("Missing publish implementation");
  }
  publish.mockImplementationOnce(async (...args) => {
    await original(...args);
    throw new Error("Lost publish response");
  });
  return publish;
}

it("keeps ordinary publish retries pinned to their original snapshot after response loss and restart", async () => {
  const fx = await fixture();
  try {
    const publish = loseNextPublishResponse(fx.transport);
    await expect(fx.initialPublish()).rejects.toThrow("Lost publish response");
    const originalSha = publish.mock.calls[0]?.[3];
    await writeFile(join(fx.path, "worker.txt"), "edited after failure\n");
    await fx.restart();
    const retry = await fx.publish();
    expect(retry.sha).toBe(originalSha);
    expect(await git(fx.remote, "show", `${retry.sha}:worker.txt`)).toBe(
      "worker",
    );
    expect(await readFile(join(fx.path, "worker.txt"), "utf8")).toBe(
      "edited after failure\n",
    );
  } finally {
    await fx.close();
  }
});

it("can fetch after an interrupted first publication even when the owner already built on its snapshot", async () => {
  const fx = await fixture();
  try {
    const publish = loseNextPublishResponse(fx.transport);
    await expect(fx.initialPublish()).rejects.toThrow("Lost publish response");
    const branch = publish.mock.calls[0]?.[1];
    if (!branch) {
      throw new Error("No published branch");
    }
    const owner = await fx.ownerPush(branch);
    await writeFile(join(fx.path, "local.txt"), "keep this edit\n");
    await fx.restart();
    await fx.call("github_fetch");
    await git(fx.path, "add", ".");
    await git(fx.path, "commit", "-m", "Preserve local work");
    await git(fx.path, "merge", "refs/remotes/kaeno/work");
    const result = await fx.publish();
    expect(await git(fx.remote, "rev-parse", `${result.sha}^`)).toBe(owner);
    expect(await git(fx.remote, "show", `${result.sha}:local.txt`)).toBe(
      "keep this edit",
    );
  } finally {
    await fx.close();
  }
});

it("repeats an interrupted import without changing HEAD or local files", async () => {
  const fx = await fixture();
  try {
    const first = await fx.initialPublish();
    const owner = await fx.ownerPush(String(first.branch));
    const execute = fx.env.exec.bind(fx.env);
    const spy = vi.spyOn(fx.env, "exec");
    let interrupted = false;
    spy.mockImplementation(async (command, options, ctx) => {
      const result = await execute(command, options, ctx);
      if (
        !interrupted &&
        Array.isArray(command) &&
        command.includes("update-ref") &&
        command.includes("refs/remotes/kaeno/work")
      ) {
        interrupted = true;
        throw new Error("Interrupted after updating fetched ref");
      }
      return result;
    });
    const head = await git(fx.path, "rev-parse", "HEAD");
    const status = await git(fx.path, "status", "--porcelain");
    await expect(fx.call("github_fetch")).rejects.toThrow(
      "Interrupted after updating fetched ref",
    );
    spy.mockRestore();
    await fx.restart();
    expect((await fx.call("github_fetch")).sha).toBe(owner);
    expect(await git(fx.path, "rev-parse", "HEAD")).toBe(head);
    expect(await git(fx.path, "status", "--porcelain")).toBe(status);
    await expect(fx.publish()).rejects.toThrow("merge or rebase");
  } finally {
    await fx.close();
  }
});

it("rejects fetching before publication and rejects deleted or rewritten work branches", async () => {
  const fx = await fixture();
  try {
    await expect(fx.call("github_fetch")).rejects.toThrow(
      "publish a work branch",
    );
    const first = await fx.initialPublish();
    const old = await git(fx.remote, "rev-parse", "main");
    await git(fx.remote, "update-ref", `refs/heads/${first.branch}`, old);
    await expect(fx.call("github_fetch")).rejects.toThrow(
      "history was rewritten",
    );
    expect(await git(fx.path, "status", "--porcelain")).toContain("worker.txt");
    await git(fx.remote, "update-ref", "-d", `refs/heads/${first.branch}`);
    await expect(fx.call("github_fetch")).rejects.toThrow(
      "Git operation failed",
    );
  } finally {
    await fx.close();
  }
});

it("automatically follows a published PR, survives restart, and wakes its worker to comment without follow_thread", async () => {
  const fx = await fixture({ work: true });
  let step = 0;
  let published: JsonObject | undefined;
  fx.faux.setResponses(
    Array.from({ length: 40 }, () => async (request) => {
      if (!getCurrentSystemPrompt(request.messages).includes("WORKER")) {
        return fauxAssistantMessage("Noted");
      }
      const last = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      function call(name: string, args: JsonObject) {
        return fauxAssistantMessage([fauxToolCall(name, args)], {
          stopReason: "toolUse",
        });
      }
      if (step++ === 0) {
        return call("github_checkout", { repository: 34 });
      }
      if (step === 2) {
        if (
          last?.role !== "toolResult" ||
          last.isError ||
          last.content[0]?.type !== "text"
        ) {
          throw new Error(`checkout failed: ${JSON.stringify(last)}`);
        }
        const checkout = JSON.parse(last.content[0].text);
        await writeFile(join(checkout.path, "worker.txt"), "worker change\n");
        return call("github_publish", {
          repository: 34,
          title: "Changes",
          body: "Tested",
        });
      }
      if (step === 3) {
        if (
          last?.role !== "toolResult" ||
          last.isError ||
          last.content[0]?.type !== "text"
        ) {
          throw new Error(`publish failed: ${JSON.stringify(last)}`);
        }
        published = JSON.parse(last.content[0].text);
        return fauxAssistantMessage("Published");
      }
      if (step === 4) {
        return call("github_comment", {
          repository: 34,
          pullRequest: 12,
          body: "Checked residual references; no further code changes needed.",
        });
      }
      return fauxAssistantMessage("Replied on GitHub");
    }),
  );
  try {
    const ticket = await startTicket(fx.core, {
      agent: "coder",
      content: "Publish changes",
    });
    await until(
      async () =>
        (await fx.core.router.ticket(ticket, context)).status === "idle",
      "worker to publish",
    );
    expect(published).toMatchObject({
      following: true,
      draft: false,
      thread: "github:owner/private#12",
    });
    expect((await fx.core.router.ticket(ticket, context)).followed).toEqual([
      "github:owner/private#12",
    ]);
    await fx.restart();
    const result = await fx.core.harness.commit(
      (tx) =>
        fx.core.router.receive(tx, {
          key: "github:comment-1",
          source: "github",
          threads: ["github:owner/private#12"],
          actor: "owner",
          authority: "system",
          content: "Any residual references?",
        }),
      context,
    );
    expect(result.path).toBe("tickets");
    await until(() => fx.comments.length === 1, "worker to post a PR reply");
    await until(
      async () =>
        (await fx.core.router.ticket(ticket, context)).status === "idle",
      "worker to settle",
    );
    const saved = await fx.core.router.ticket(ticket, context);
    expect(saved.assignments).toHaveLength(2);
    expect(saved.systemWakes).toBe(1);
    expect(fx.comments[0].body).toContain("Checked residual references");
    const duplicate = await fx.core.harness.commit(
      (tx) =>
        fx.core.router.receive(tx, {
          key: "github:comment-1",
          source: "github",
          threads: ["github:owner/private#12"],
          actor: "owner",
          authority: "system",
          content: "Any residual references?",
        }),
      context,
    );
    expect(duplicate.duplicate).toBe(true);
    expect(fx.comments).toHaveLength(1);
  } finally {
    await fx.close();
  }
});

it("reconciles a posted PR comment after response loss, restart and a fresh tool call", async () => {
  const fx = await fixture();
  try {
    const published = await fx.initialPublish();
    expect(published.following).toBe(false); // A standalone assistant has no ticket.
    fx.loseCommentResponse();
    await expect(
      fx.call("github_comment", {
        repository: 34,
        pullRequest: 12,
        body: "Review addressed",
      }),
    ).rejects.toThrow("request failed");
    expect(fx.comments).toHaveLength(1);
    await fx.restart();
    const comment = await fx.call("github_comment", {
      repository: 34,
      pullRequest: 12,
      body: "New text after failed attempt",
    });
    expect(comment.id).toBe(1);
    expect(fx.comments).toHaveLength(1);
    expect(fx.comments[0].body).toContain("Review addressed");
    await fx.call("github_comment", {
      repository: 34,
      pullRequest: 12,
      body: "Another intentional reply",
    });
    expect(fx.comments).toHaveLength(2);
    expect(fx.comments[1].body).toContain("Another intentional reply");
  } finally {
    await fx.close();
  }
});
