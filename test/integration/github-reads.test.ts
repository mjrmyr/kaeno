import { generateKeyPairSync } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { MemoryStorage, type JsonObject } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openKaeno } from "../../src/core/application/index.ts";
import { expect, it, vi } from "vitest";
import {
  githubBinding,
  githubExtension,
  GITHUB_TOOLS,
} from "../../src/extensions/github/index.ts";
const GITHUB_READ_TOOLS = GITHUB_TOOLS.slice(3);

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
const repo = { id: 34, full_name: "owner/private", default_branch: "main" };
const sha = "a".repeat(40);
const ref = { ref: "feature", sha, repo };
const pull = {
  number: 23,
  html_url: "https://github.com/owner/private/pull/23",
  title: "Fix",
  state: "open",
  draft: true,
  merged: false,
  head: ref,
  base: { ...ref, ref: "main" },
};
const check = {
  id: 7,
  name: "tests",
  head_sha: sha,
  status: "completed",
  conclusion: "failure",
  html_url: null,
  details_url: null,
  started_at: null,
  completed_at: null,
  output: {
    title: "Failed",
    summary: "x".repeat(5000),
    text: null,
    annotations_count: 1,
  },
};
const annotation = {
  path: "src/a.ts",
  start_line: 1,
  end_line: 2,
  annotation_level: "failure",
  title: null,
  message: "untrusted failure",
  raw_details: null,
};
const status = {
  id: 8,
  state: "failure",
  context: "ci",
  description: "failed",
  target_url: null,
  created_at: "now",
  updated_at: "now",
};
const run = {
  id: 9,
  name: "CI",
  head_branch: "feature",
  head_sha: sha,
  run_number: 3,
  run_attempt: 1,
  event: "pull_request",
  status: "completed",
  conclusion: "failure",
  workflow_id: 10,
  html_url: "https://github.com/owner/private/actions/runs/9",
  created_at: "now",
  updated_at: "now",
};
const job = {
  id: 11,
  run_id: 9,
  name: "unit",
  head_sha: sha,
  status: "completed",
  conclusion: "failure",
  started_at: null,
  completed_at: null,
  html_url: null,
  steps: [
    {
      name: "test",
      number: 1,
      status: "completed",
      conclusion: "failure",
      started_at: null,
      completed_at: null,
    },
  ],
};
const signedUrl =
  "https://productionresultssa1.blob.core.windows.net/logs/job?sig=secret";

function setup(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  assigned: number | null = 12,
) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) =>
    handler(new URL(String(input)), init),
  );
  const extension = githubExtension({
    appId: "123",
    installationId: 12,
    privateKey,
    fetch,
  });
  const call = async (name: string, args: JsonObject) => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    let output: string | undefined;
    let error = false;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(name, args)], {
        stopReason: "toolUse",
      }),
      async (request) => {
        const result = request.messages.findLast(
          (message) => message.role === "toolResult",
        );
        if (result?.role === "toolResult") {
          const content = result.content[0];
          if (content?.type === "text") {
            output = content.text;
          }
          error = result.isError;
        }
        return fauxAssistantMessage("Done");
      },
    ]);
    const core = await openKaeno({
      storage: new MemoryStorage(),
      models,
      extensions: [extension],
      assistant: {
        model: { provider: "faux", modelId: "faux-1" },
        instructions: "Read diagnostics",
        tools: [name],
        bindings: assigned === null ? [] : [githubBinding(assigned)],
      },
    });
    try {
      const id = await core.threads.getOrCreateConversation("reads");
      const task = await core.harness.commit(
        (tx) => core.turns.admitUserTurn(tx, id, "Read", "read"),
        context,
      );
      await core.harness.waitForTask(task, context);
      if (error) {
        throw new Error(output);
      }
      if (output === undefined) {
        throw new Error("Missing tool output");
      }
      return JSON.parse(output);
    } finally {
      await core.close();
    }
  };
  return { fetch, extension, call };
}
function auth(url: URL, init?: RequestInit) {
  if (url.pathname.endsWith("access_tokens")) {
    return Response.json({ token: "installation-secret" });
  }
  expect(new Headers(init?.headers).get("authorization")).toBe(
    "Bearer installation-secret",
  );
  expect(init?.redirect).toBe("error");
  if (url.pathname === "/repositories/34") {
    return Response.json(repo);
  }
}

it("registers all diagnostics as read-only native tools with bounded input schemas", () => {
  const { extension } = setup(() => Response.json({}));
  for (const name of GITHUB_READ_TOOLS) {
    expect(GITHUB_TOOLS).toContain(name);
    expect(extension.readOnlyTools).toContain(name);
    const tool = extension.durable.tools?.find((tool) => tool.name === name);
    expect(tool?.replay).toBe("safe");
    expect(tool?.parameters).toMatchObject({
      properties: { repository: { minimum: 1 } },
    });
  }
});

it("reads PR head branch/SHA and paginated checks, annotations, statuses, runs and jobs through scoped authorization", async () => {
  const { call, fetch } = setup((url, init) => {
    const authorized = auth(url, init);
    if (authorized) {
      return authorized;
    }
    expect(url.searchParams.get("page")).toBe(
      url.pathname.endsWith("/pulls/23") ? null : "2",
    );
    expect(url.searchParams.get("per_page")).toBe(
      url.pathname.endsWith("/pulls/23") ? null : "1",
    );
    if (url.pathname.endsWith("/pulls/23")) {
      return Response.json({ ...pull, body: "not forwarded" });
    }
    if (url.pathname.endsWith(`/${sha}/check-runs`)) {
      return Response.json({ total_count: 3, check_runs: [check] });
    }
    if (url.pathname.endsWith("/check-runs/7/annotations")) {
      return Response.json([annotation]);
    }
    if (url.pathname.endsWith(`/${sha}/statuses`)) {
      return Response.json([status]);
    }
    if (url.pathname.endsWith("/actions/runs")) {
      return Response.json({ total_count: 2, workflow_runs: [run] });
    }
    if (url.pathname.endsWith("/actions/runs/9/jobs")) {
      return Response.json({ total_count: 2, jobs: [job] });
    }
    throw new Error(`Unexpected path ${url.pathname}`);
  });
  const result = await call("github_get_pull_request", {
    repository: 34,
    pullRequest: 23,
  });
  expect(result.head).toEqual({
    ...ref,
    repo: { id: 34, full_name: "owner/private" },
  });
  expect(result.body).toBeUndefined();
  const args = { repository: 34, sha, page: 2, perPage: 1 };
  const checks = await call("github_list_check_runs", args);
  expect(checks.nextPage).toBe(3);
  expect(checks.items[0].output.summary).toHaveLength(4096);
  expect(
    await call("github_list_check_annotations", { ...args, checkRun: 7 }),
  ).toMatchObject({ items: [annotation], nextPage: 3 });
  expect(await call("github_list_commit_statuses", args)).toMatchObject({
    items: [status],
    nextPage: 3,
  });
  expect(await call("github_list_workflow_runs", args)).toMatchObject({
    items: [run],
    nextPage: null,
  });
  expect(
    await call("github_list_workflow_jobs", { ...args, run: 9 }),
  ).toMatchObject({ items: [job], nextPage: null });
  expect(
    fetch.mock.calls.filter(([url]) => String(url).endsWith("access_tokens")),
  ).toHaveLength(6);
  const mintCalls = fetch.mock.calls.filter(([url]) =>
    String(url).endsWith("access_tokens"),
  );
  expect(mintCalls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual(
    Array(6).fill({ repository_ids: [34] }),
  );
  const runsCall = fetch.mock.calls.find(([url]) =>
    new URL(String(url)).pathname.endsWith("/actions/runs"),
  );
  expect(new URL(String(runsCall?.[0])).searchParams.get("head_sha")).toBe(sha);
});

it.each(GITHUB_READ_TOOLS)(
  "denies unassigned and mismatched installations before network access: %s",
  async (name) => {
    for (const assigned of [0, 99]) {
      const { call, fetch } = setup(
        () => {
          throw new Error("must not fetch");
        },
        assigned === 0 ? null : assigned,
      );
      await expect(
        call(name, {
          repository: 34,
          sha,
          pullRequest: 23,
          checkRun: 7,
          run: 9,
          job: 11,
        }),
      ).rejects.toThrow(assigned === 0 ? "not assigned" : "installation");
      expect(fetch).not.toHaveBeenCalled();
    }
  },
);

it.each([403, 404])(
  "does not return API error bodies for denied or absent repositories (%s)",
  async (code) => {
    const { call } = setup(
      () => new Response("installation-secret private body", { status: code }),
    );
    await expect(
      call("github_get_pull_request", { repository: 34, pullRequest: 23 }),
    ).rejects.toThrow(`HTTP ${code}`);
    await expect(
      call("github_get_pull_request", { repository: 34, pullRequest: 23 }),
    ).rejects.not.toThrow("installation-secret");
  },
);

it("rejects a mismatched repository before reading its resources", async () => {
  const { call, fetch } = setup((url) =>
    url.pathname.endsWith("access_tokens")
      ? Response.json({ token: "token" })
      : Response.json({ ...repo, id: 35 }),
  );
  await expect(
    call("github_get_pull_request", { repository: 34, pullRequest: 23 }),
  ).rejects.toThrow("different repository");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("downloads bounded logs without forwarding authorization or exposing signed URLs", async () => {
  const { call, fetch } = setup((url, init) => {
    if (url.pathname.endsWith("/logs") && url.hostname === "api.github.com") {
      return new Response(null, {
        status: 302,
        headers: { location: signedUrl },
      });
    }
    if (url.hostname.endsWith(".blob.core.windows.net")) {
      return new Response("installation-secret\n0123456789");
    }
    return auth(url, init) ?? Response.json({});
  });
  const result = await call("github_get_job_logs", {
    repository: 34,
    job: 11,
    maxBytes: 23,
  });
  expect(result).toEqual({
    text: "[REDACTED]\n012",
    bytes: 23,
    truncated: true,
    untrusted: true,
  });
  expect(JSON.stringify(result)).not.toContain("sig=secret");
  expect(fetch.mock.calls[2]?.[1]).toMatchObject({
    redirect: "manual",
    headers: { authorization: "Bearer installation-secret" },
  });
  expect(fetch.mock.calls[3]?.[1]?.headers).toBeUndefined();
  expect(fetch.mock.calls[3]?.[1]?.redirect).toBe("error");
});

it.each([
  "http://productionresultssa1.blob.core.windows.net/log",
  "https://evil.example/log",
  "https://api.github.com/log",
  "https://productionresultssa1.blob.core.windows.net.evil.example/log",
  "https://user:pass@productionresultssa1.blob.core.windows.net/log",
  "https://127.0.0.1/log",
  "not a URL",
])("rejects unsafe log locations: %s", async (location) => {
  const { call, fetch } = setup((url, init) => {
    if (url.pathname.endsWith("/logs")) {
      return new Response(null, { status: 302, headers: { location } });
    }
    return auth(url, init) ?? Response.json({});
  });
  await expect(
    call("github_get_job_logs", { repository: 34, job: 11 }),
  ).rejects.toThrow("unable to retrieve job logs");
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([403, 404, 410, 500, 302])(
  "sanitizes unavailable/unsafe log downloads (%s)",
  async (code) => {
    const { call, fetch } = setup((url, init) => {
      if (url.pathname.endsWith("/logs")) {
        return new Response("secret", {
          status: code,
          headers: { location: "https://evil.example/?secret" },
        });
      }
      return auth(url, init) ?? Response.json({});
    });
    await expect(
      call("github_get_job_logs", { repository: 34, job: 11 }),
    ).rejects.toThrow("unable to retrieve job logs");
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);

it("bounds streaming logs, cancels excess data and handles empty/exact logs", async () => {
  const cancel = vi.fn<() => void>();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("0123456789"));
    },
    cancel,
  });
  const responses = [
    new Response(stream),
    new Response("abc"),
    new Response(null),
  ];
  const { call } = setup((url, init) => {
    if (url.hostname.endsWith(".blob.core.windows.net")) {
      const response = responses.shift();
      if (!response) {
        throw new Error("Missing response");
      }
      return response;
    }
    if (url.pathname.endsWith("/logs")) {
      return new Response(null, {
        status: 302,
        headers: { location: signedUrl },
      });
    }
    return auth(url, init) ?? Response.json({});
  });
  const args = { repository: 34, job: 11, maxBytes: 3 };
  expect(await call("github_get_job_logs", args)).toEqual({
    text: "012",
    bytes: 3,
    truncated: true,
    untrusted: true,
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(await call("github_get_job_logs", args)).toEqual({
    text: "abc",
    bytes: 3,
    truncated: false,
    untrusted: true,
  });
  expect(await call("github_get_job_logs", args)).toEqual({
    text: "",
    bytes: 0,
    truncated: false,
    untrusted: true,
  });
});

it.each([
  ["github_list_check_runs", { sha: "../bad" }],
  ["github_list_commit_statuses", { sha, perPage: 101 }],
  ["github_list_workflow_runs", { page: 0 }],
  ["github_get_job_logs", { job: 11, maxBytes: 262145 }],
  ["github_get_pull_request", { pullRequest: 0 }],
])(
  "validates bounded read inputs before network access: %s",
  async (name, args) => {
    const { call, fetch } = setup(() => {
      throw new Error("must not fetch");
    });
    await expect(call(name, { repository: 34, ...args })).rejects.toThrow(
      "Validation failed",
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(GITHUB_READ_TOOLS)(
  "honors repository permission/not-found failures for each read: %s",
  async (name) => {
    const { call, fetch } = setup(
      (url, init) =>
        auth(url, init) ?? new Response("secret error body", { status: 403 }),
    );
    await expect(
      call(name, {
        repository: 34,
        sha,
        pullRequest: 23,
        checkRun: 7,
        run: 9,
        job: 11,
      }),
    ).rejects.toThrow(
      name === "github_get_job_logs"
        ? "unable to retrieve job logs"
        : "HTTP 403",
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);

it.each(["network", "json"])(
  "sanitizes raw %s failures without exposing credentials or response content",
  async (kind) => {
    const { call } = setup(() => {
      if (kind === "network") {
        throw new Error("installation-secret private response");
      }
      return new Response("installation-secret private response");
    });
    await expect(
      call("github_get_pull_request", { repository: 34, pullRequest: 23 }),
    ).rejects.not.toThrow("installation-secret");
  },
);

it("does not follow log-storage redirects and sanitizes download failures", async () => {
  const { call, fetch } = setup((url, init) => {
    if (url.hostname.endsWith(".blob.core.windows.net")) {
      throw new Error(`Redirect refused: ${signedUrl} installation-secret`);
    }
    if (url.pathname.endsWith("/logs")) {
      return new Response(null, {
        status: 302,
        headers: { location: signedUrl },
      });
    }
    return auth(url, init) ?? Response.json({});
  });
  await expect(
    call("github_get_job_logs", { repository: 34, job: 11 }),
  ).rejects.toThrow("unable to retrieve job logs");
  expect(fetch.mock.calls[3]?.[1]).toMatchObject({ redirect: "error" });
});
