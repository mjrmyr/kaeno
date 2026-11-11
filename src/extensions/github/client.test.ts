import { generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { GitHubClient } from "./index.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
const repository = {
  id: 34,
  full_name: "owner/private",
  default_branch: "main",
};
const pull = {
  number: 12,
  html_url: "https://github.com/owner/private/pull/12",
  state: "open",
  draft: false,
  node_id: "PR_node",
  head: { ref: "kaeno/work", repo: { id: 34 } },
  base: { ref: "main" },
};
function setup(handler: (url: URL, init?: RequestInit) => Response) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer host-token",
    );
    expect(init?.redirect).toBe("error");
    return handler(new URL(String(input)), init);
  });
  return {
    client: new GitHubClient({ appId: "123", privateKey, fetch }),
    fetch,
  };
}

it("creates ready-for-review PRs, never drafts", async () => {
  const { client, fetch } = setup((_url, init) => {
    if (init?.method === "POST") {
      return Response.json(pull);
    }
    return Response.json([]);
  });
  expect(
    await client.workPull(
      "host-token",
      repository,
      "kaeno/work",
      "main",
      "Changes",
      "Tested",
    ),
  ).toMatchObject({ draft: false, number: 12 });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
    head: "kaeno/work",
    base: "main",
    title: "Changes",
    body: "Tested",
    draft: false,
  });
});

it("reuses a ready PR without creating another or changing its review state", async () => {
  const { client, fetch } = setup(() => Response.json([pull]));
  expect(
    await client.workPull(
      "host-token",
      repository,
      "kaeno/work",
      "main",
      "Changes",
      "Tested",
    ),
  ).toMatchObject({ draft: false });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("converts an existing draft to ready and converges after a lost mutation response", async () => {
  let draft = true;
  let loseResponse = true;
  const { client, fetch } = setup((url) => {
    if (url.pathname === "/graphql") {
      draft = false;
      if (loseResponse) {
        loseResponse = false;
        throw new Error("lost response");
      }
      return Response.json({
        data: {
          markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
        },
      });
    }
    return Response.json([{ ...pull, draft }]);
  });
  await expect(
    client.workPull(
      "host-token",
      repository,
      "kaeno/work",
      "main",
      "Changes",
      "Tested",
    ),
  ).rejects.toThrow("request failed");
  expect(
    await client.workPull(
      "host-token",
      repository,
      "kaeno/work",
      "main",
      "Changes",
      "Tested",
    ),
  ).toMatchObject({ draft: false });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).variables).toEqual({
    id: "PR_node",
  });
});

it("marks an existing draft ready without creating another PR", async () => {
  const { client, fetch } = setup((url) =>
    url.pathname === "/graphql"
      ? Response.json({
          data: {
            markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
          },
        })
      : Response.json([{ ...pull, draft: true }]),
  );
  expect(
    await client.workPull(
      "host-token",
      repository,
      "kaeno/work",
      "main",
      "Changes",
      "Tested",
    ),
  ).toMatchObject({ draft: false, number: 12 });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("checks conversion succeeded rather than claiming a failed mutation made the PR ready", async () => {
  const { client } = setup((url) =>
    url.pathname === "/graphql"
      ? Response.json({
          data: {
            markPullRequestReadyForReview: { pullRequest: { isDraft: true } },
          },
        })
      : Response.json([{ ...pull, draft: true }]),
  );
  await expect(
    client.workPull(
      "host-token",
      repository,
      "kaeno/work",
      "main",
      "Changes",
      "Tested",
    ),
  ).rejects.toThrow();
});

it.each([{ state: "closed" }, { base: { ref: "other" } }])(
  "still rejects unsafe existing work PRs: %j",
  async (change) => {
    const { client, fetch } = setup(() =>
      Response.json([{ ...pull, ...change }]),
    );
    await expect(
      client.workPull(
        "host-token",
        repository,
        "kaeno/work",
        "main",
        "Changes",
        "Tested",
      ),
    ).rejects.toThrow("existing work PR");
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("finds a prior comment on later pages without posting again", async () => {
  const marker = "<!-- kaeno-comment:invocation -->";
  const comment = {
    id: 1,
    html_url: "https://github.com/owner/private/pull/12#issuecomment-1",
    body: "Other comment",
  };
  const { client, fetch } = setup((url, init) => {
    expect(init?.method).toBe("GET");
    if (url.pathname.endsWith("/pulls/12")) {
      return Response.json({
        ...pull,
        title: "Changes",
        merged: false,
        head: { ref: "work", sha: "a".repeat(40), repo: repository },
        base: { ref: "main", sha: "b".repeat(40), repo: repository },
      });
    }
    if (url.searchParams.get("page") === "1") {
      return Response.json(
        Array.from({ length: 100 }, (_, index) => ({
          ...comment,
          id: index + 1,
        })),
      );
    }
    return Response.json([
      { ...comment, id: 101, body: `Already posted\n\n${marker}` },
    ]);
  });
  expect(
    await client.comment("host-token", repository, 12, "Retry", marker),
  ).toMatchObject({ id: 101 });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("does not post an issue comment when the target is not an accessible pull request", async () => {
  const { client, fetch } = setup(
    () => new Response("private error", { status: 404 }),
  );
  await expect(
    client.comment("host-token", repository, 12, "Reply", "marker"),
  ).rejects.toThrow("HTTP 404");
  expect(fetch).toHaveBeenCalledTimes(1);
});
