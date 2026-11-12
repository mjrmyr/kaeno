import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  defineDocFamily,
  defineTask,
  defineExtension,
  type ConversationId,
  MemoryStorage,
  type JsonObject,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { expect, it, vi } from "vitest";
import { openKaeno } from "../../src/core/application/index.ts";
import { ConversationBindings } from "../../src/core/conversation/index.ts";
import { WorkScope } from "../../src/core/work/index.ts";
import { TicketRef } from "../../src/core/router/index.ts";
import {
  githubBinding,
  githubExtension,
  HostGit,
  type RepositoryTransport,
} from "../../src/extensions/github/index.ts";

const execute = promisify(execFile);
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
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

// Invoke native tools against real durable conversation documents and isolated
// execution environments. Scheduling/ancestry is covered by ticket-ownership
// and github-fetch; this seam isolates publication ownership from model timing.
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-publications-"));
  const remote = join(directory, "remote.git");
  const initial = join(directory, "initial");
  await execute("git", ["init", "--bare", "--initial-branch=main", remote]);
  await execute("git", ["clone", remote, initial]);
  await writeFile(join(initial, "base.txt"), "base\n");
  await git(initial, "add", ".");
  await git(initial, "commit", "-m", "Initial");
  await git(initial, "push", "origin", "main");
  const repo = { id: 34, full_name: "owner/private", default_branch: "main" };
  const pulls = new Map<string, JsonObject>();
  const host = new HostGit();
  const transport: RepositoryTransport = {
    checkout: vi.fn<RepositoryTransport["checkout"]>(
      async (_url, ref, token, signal) =>
        host.checkout(remote, ref, token, signal),
    ),
    publish: vi.fn<RepositoryTransport["publish"]>(
      async (_url, branch, bundle, sha, expected, token, signal) =>
        host.publish(remote, branch, bundle, sha, expected, token, signal),
    ),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/access_tokens")) {
      expect(JSON.parse(String(init?.body))).toEqual({ repository_ids: [34] });
      return Response.json({ token: "host-only" });
    }
    if (url.pathname === "/repositories/34") {
      return Response.json(repo);
    }
    if (url.pathname === "/repos/owner/private/pulls") {
      if (init?.method === "POST") {
        const args = JSON.parse(String(init.body));
        const number = pulls.size + 75;
        const pull = {
          number,
          node_id: `PR_${number}`,
          html_url: `https://github.com/owner/private/pull/${number}`,
          state: "open",
          draft: false,
          head: { ref: args.head, repo },
          base: { ref: args.base },
        };
        pulls.set(args.head, pull);
        return Response.json(pull);
      }
      const branch = url.searchParams.get("head")?.replace(/^owner:/, "");
      return Response.json(
        branch && pulls.has(branch) ? [pulls.get(branch)] : [],
      );
    }
    throw new Error(`Unexpected GitHub request ${url.pathname}`);
  });
  const extension = githubExtension({
    appId: "123",
    installationId: 12,
    privateKey,
    fetch,
    transport,
  });
  const ancestryTask = defineTask<
    { parent: JsonObject },
    { phase: "run" },
    null
  >({
    name: "test.publication-parent",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime, taskContext) => {
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          taskContext,
        );
      },
    },
    abort: async () => {},
  });
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models: createModels(),
    assistant: {
      model: { provider: "faux", modelId: "faux-1" },
      instructions: "Test",
    },
    extensions: [
      extension.runtime,
      {
        durable: defineExtension({
          name: "test-ancestry",
          tasks: [ancestryTask],
        }),
      },
    ],
  });
  // No router ticket fixture is required to test the extension's subscription
  // boundary; core ancestry/follow behavior has its own tests.
  const follow = vi.fn<typeof core.followThread>(async () => true);
  core.followThread = follow;
  await extension.runtime.start?.(core, new AbortController().signal);
  let next = 0;
  async function worker(
    ticket = "k1",
    assigned = true,
    parent?: ConversationId,
  ) {
    const conversation = await core.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );
    await core.harness.commit(async (tx) => {
      (await tx.doc(TicketRef, conversation.id)).ticket = parent
        ? null
        : ticket;
      (await tx.doc(ConversationBindings, conversation.id)).bindings = assigned
        ? [{ ...githubBinding(12) }]
        : [];
    }, context);
    if (parent) {
      await core.harness.commit(async (tx) => {
        const workId = await tx.createTask(
          ancestryTask,
          { parent: { kind: "work", conversationId: parent } },
          {
            ownership: { kind: "conversation" },
            conversationId: conversation.id,
          },
        );
        (await tx.doc(WorkScope, conversation.id)).workId = workId;
      }, context);
    }
    const cwd = join(directory, `worker-${++next}`);
    await mkdir(cwd);
    const env = new NodeExecutionEnv({ cwd });
    async function call(name: string, args: JsonObject = {}) {
      const memo = new Map<string, unknown>();
      const api: ToolExecutionApi = Object.assign(Object.create(null), {
        conversationId: conversation.id,
        env,
        snapshot: core.harness.snapshot.bind(core.harness),
        commit: core.harness.commit.bind(core.harness),
        memo: async (key: string, candidate: unknown, _context?: unknown) => {
          if (_context === undefined) {
            return memo.get(key);
          }
          if (!memo.has(key)) {
            memo.set(key, candidate);
          }
          return memo.get(key);
        },
      });
      const tool = extension.runtime.durable.tools?.find(
        (value) => value.name === name,
      );
      if (!tool) {
        throw new Error(`Missing tool ${name}`);
      }
      const result = await tool.execute(
        { repository: 34, ...args },
        api,
        context,
      );
      const content = result.content?.[0];
      if (content?.type !== "text") {
        throw new Error("Missing text result");
      }
      return JSON.parse(content.text);
    }
    return {
      id: conversation.id,
      path: join(cwd, ".kaeno-github/34"),
      call,
      publish: () =>
        call("github_publish", { title: "Change", body: "Verified" }),
    };
  }
  return {
    core,
    worker,
    remote,
    pulls,
    follow,
    transport,
    extension,
    close: async () => {
      await core.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("continues a ticket publication in fresh workers without accepting its head into stale files", async () => {
  const fixtureState = await fixture();
  try {
    const firstWorker = await fixtureState.worker();
    await firstWorker.call("github_checkout");
    await writeFile(join(firstWorker.path, "firstWorker.txt"), "A\n");
    const first = await firstWorker.publish();
    const secondWorker = await fixtureState.worker("k1", true, firstWorker.id);
    expect(
      (
        await fixtureState.core.harness.snapshot(
          TicketRef,
          secondWorker.id,
          context,
        )
      )?.ticket,
    ).toBeNull();
    const checkout = await secondWorker.call("github_checkout");
    expect(checkout.branch).toBe(first.branch);
    expect(checkout.sha).toBe(first.sha);
    expect(
      await readFile(join(secondWorker.path, "firstWorker.txt"), "utf8"),
    ).toBe("A\n");
    await writeFile(join(secondWorker.path, "secondWorker.txt"), "B\n");
    const second = await secondWorker.publish();
    expect(second.number).toBe(first.number);
    expect(await git(fixtureState.remote, "rev-parse", `${second.sha}^`)).toBe(
      first.sha,
    );
    await writeFile(join(firstWorker.path, "local.txt"), "local\n");
    const head = await git(firstWorker.path, "rev-parse", "HEAD");
    const pushes = vi.mocked(fixtureState.transport.publish).mock.calls.length;
    await expect(firstWorker.publish()).rejects.toThrow(
      "advanced in another worker",
    );
    expect(vi.mocked(fixtureState.transport.publish).mock.calls).toHaveLength(
      pushes,
    );
    expect(await git(firstWorker.path, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(firstWorker.path, "local.txt"), "utf8")).toBe(
      "local\n",
    );
    await firstWorker.call("github_fetch");
    expect(await git(firstWorker.path, "rev-parse", "HEAD")).toBe(head);
    await expect(firstWorker.publish()).rejects.toThrow("merge or rebase");
    await git(firstWorker.path, "add", ".");
    await git(firstWorker.path, "commit", "-m", "Preserve A");
    await git(firstWorker.path, "merge", "refs/remotes/kaeno/work");
    const third = await firstWorker.publish();
    expect(await git(fixtureState.remote, "rev-parse", `${third.sha}^`)).toBe(
      second.sha,
    );
    expect(
      await git(fixtureState.remote, "show", `${third.sha}:secondWorker.txt`),
    ).toBe("B");
    expect(
      await git(fixtureState.remote, "show", `${third.sha}:local.txt`),
    ).toBe("local");
    expect(fixtureState.follow).toHaveBeenCalledTimes(3);
  } finally {
    await fixtureState.close();
  }
});

it("selects parallel publications explicitly, ignores closed PRs, and never transfers across tickets", async () => {
  const fixtureState = await fixture();
  try {
    const firstWorker = await fixtureState.worker();
    await firstWorker.call("github_checkout");
    await writeFile(join(firstWorker.path, "one.txt"), "one\n");
    const first = await firstWorker.publish();
    const secondWorker = await fixtureState.worker();
    await secondWorker.call("github_checkout", { newPublication: true });
    await writeFile(join(secondWorker.path, "two.txt"), "two\n");
    const second = await secondWorker.publish();
    expect(second.branch).not.toBe(first.branch);
    const selectorWorker = await fixtureState.worker();
    await expect(selectorWorker.call("github_checkout")).rejects.toThrow(
      "multiple ticket publications",
    );
    expect(
      (
        await selectorWorker.call("github_checkout", {
          pullRequest: first.number,
        })
      ).branch,
    ).toBe(first.branch);
    const other = await fixtureState.worker("k2");
    await expect(
      other.call("github_checkout", { pullRequest: first.number }),
    ).rejects.toThrow("not an open publication of this ticket");
    const closed = fixtureState.pulls.get(first.branch);
    if (!closed) {
      throw new Error("Missing PR");
    }
    closed.state = "closed";
    const continuingWorker = await fixtureState.worker();
    expect((await continuingWorker.call("github_checkout")).branch).toBe(
      second.branch,
    );
    const closedSecond = fixtureState.pulls.get(second.branch);
    if (!closedSecond) {
      throw new Error("Missing PR");
    }
    closedSecond.state = "closed";
    const nextWorker = await fixtureState.worker();
    expect((await nextWorker.call("github_checkout")).branch).not.toBe(
      second.branch,
    );
    await writeFile(join(nextWorker.path, "next.txt"), "next\n");
    expect((await nextWorker.publish()).number).toBe(77);
  } finally {
    await fixtureState.close();
  }
});

it("internally migrates legacy records without needing the publisher's files or granting authorization", async () => {
  const fixtureState = await fixture();
  try {
    const firstWorker = await fixtureState.worker();
    await firstWorker.call("github_checkout");
    await writeFile(join(firstWorker.path, "legacy.txt"), "legacy\n");
    const first = await firstWorker.publish();
    const Publications = defineDocFamily<JsonObject, null>({
      kind: "kaeno.github-publications",
      version: 1,
      scope: "session",
      family: true,
      initial: () => ({ publications: {} }),
    });
    await fixtureState.core.harness.commit(async (tx) => {
      (await tx.doc(Publications, "k1", null)).publications = {};
    }, context);
    await rm(firstWorker.path, { recursive: true, force: true });
    await fixtureState.extension.runtime.start?.(
      fixtureState.core,
      new AbortController().signal,
    );
    await fixtureState.extension.runtime.start?.(
      fixtureState.core,
      new AbortController().signal,
    );
    const secondWorker = await fixtureState.worker();
    expect(
      (
        await secondWorker.call("github_checkout", {
          pullRequest: first.number,
        })
      ).sha,
    ).toBe(first.sha);
    expect(await readFile(join(secondWorker.path, "legacy.txt"), "utf8")).toBe(
      "legacy\n",
    );
    const denied = await fixtureState.worker("k1", false);
    await expect(
      denied.call("github_checkout", { pullRequest: first.number }),
    ).rejects.toThrow("installation is not assigned");
  } finally {
    await fixtureState.close();
  }
});

it("keeps shared-ticket response-loss retries pinned to worker-local intent", async () => {
  const fixtureState = await fixture();
  try {
    const worker = await fixtureState.worker();
    await worker.call("github_checkout");
    await writeFile(join(worker.path, "intent.txt"), "original\n");
    const publish = vi.mocked(fixtureState.transport.publish);
    const original = publish.getMockImplementation();
    if (!original) {
      throw new Error("Missing transport");
    }
    publish.mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("lost publish response");
    });
    await expect(worker.publish()).rejects.toThrow("lost publish response");
    const pinned = publish.mock.calls[0]?.[3];
    await writeFile(join(worker.path, "intent.txt"), "later edit\n");
    const recovered = await worker.publish();
    expect(recovered.sha).toBe(pinned);
    expect(
      await git(fixtureState.remote, "show", `${recovered.sha}:intent.txt`),
    ).toBe("original");
    const next = await worker.publish();
    expect(next.sha).not.toBe(pinned);
    expect(
      await git(fixtureState.remote, "show", `${next.sha}:intent.txt`),
    ).toBe("later edit");
  } finally {
    await fixtureState.close();
  }
});

it("does not regress shared metadata when two workers race ordinary pushes", async () => {
  const fixtureState = await fixture();
  try {
    const firstWorker = await fixtureState.worker();
    await firstWorker.call("github_checkout");
    await writeFile(join(firstWorker.path, "initial.txt"), "initial\n");
    const initial = await firstWorker.publish();
    const secondWorker = await fixtureState.worker();
    const thirdWorker = await fixtureState.worker();
    await secondWorker.call("github_checkout");
    await thirdWorker.call("github_checkout");
    await writeFile(join(secondWorker.path, "second.txt"), "second\n");
    await writeFile(join(thirdWorker.path, "third.txt"), "third\n");
    const results = await Promise.allSettled([
      secondWorker.publish(),
      thirdWorker.publish(),
    ]);
    const successes = results.filter((result) => result.status === "fulfilled");
    expect(successes).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const winner = successes[0];
    if (winner?.status !== "fulfilled") {
      throw new Error("Missing winner");
    }
    const remoteHead = await git(
      fixtureState.remote,
      "rev-parse",
      initial.branch,
    );
    expect(remoteHead).toBe(winner.value.sha);
    const freshWorker = await fixtureState.worker();
    expect((await freshWorker.call("github_checkout")).sha).toBe(remoteHead);
  } finally {
    await fixtureState.close();
  }
});
