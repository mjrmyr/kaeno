import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { githubAdapter } from "./index.ts";

const SECRET = "github-webhook-secret-with-32-chars";
const repository = { full_name: "mjrmyr/kaeno" };
const sender = { login: "mjrmyr" };
const pull = {
  number: 12,
  title: "Fix the parser",
  html_url: "https://github.com/mjrmyr/kaeno/pull/12",
  head: { ref: "kaeno/fix", sha: "0123456789abcdef" },
};

function read(kind: string, payload: object) {
  const body = Buffer.from(JSON.stringify(payload));
  return githubAdapter(SECRET, "kaeno-app[bot]").read(
    {
      "x-github-event": kind,
      "x-github-delivery": "d1",
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    },
    body,
  );
}

it("describes comments, reviews and issues on the issue or pull request's thread", () => {
  expect(
    read("issue_comment", {
      action: "created",
      sender,
      repository,
      issue: { ...pull, pull_request: {} },
      comment: { body: "Please rebase.", html_url: "https://c/1" },
    }),
  ).toEqual({
    id: "d1",
    threads: ["mjrmyr/kaeno#12"],
    actor: "mjrmyr",
    text: "mjrmyr commented on pull request mjrmyr/kaeno#12:\nPlease rebase.\nhttps://c/1",
    closes: false,
  });
  expect(
    read("pull_request_review", {
      action: "submitted",
      sender,
      repository,
      pull_request: pull,
      review: {
        state: "CHANGES_REQUESTED",
        body: null,
        html_url: "https://r/1",
      },
    })?.text,
  ).toBe(
    "mjrmyr reviewed pull request mjrmyr/kaeno#12: changes requested.\nhttps://r/1",
  );
  expect(
    read("pull_request_review_comment", {
      action: "created",
      sender,
      repository,
      pull_request: pull,
      comment: {
        body: "Off by one.",
        html_url: "https://c/2",
        path: "src/parse.ts",
        line: 40,
      },
    })?.text,
  ).toBe(
    "mjrmyr commented on src/parse.ts:40 in pull request mjrmyr/kaeno#12:\nOff by one.\nhttps://c/2",
  );
  const issue = {
    number: 7,
    title: "Crash on start",
    html_url: "https://i/7",
    body: "x".repeat(5000),
  };
  const opened = read("issues", {
    action: "opened",
    sender,
    repository,
    issue,
  });
  expect(opened?.text).toContain("mjrmyr opened issue mjrmyr/kaeno#7");
  expect(opened?.text).toContain(`${"x".repeat(4000)}…\nhttps://i/7`);
  expect(
    read("issues", { action: "closed", sender, repository, issue }),
  ).toMatchObject({ threads: ["mjrmyr/kaeno#7"], closes: true });
  expect(
    read("issue_comment", {
      action: "deleted",
      sender,
      repository,
      issue: pull,
      comment: { body: "gone", html_url: "https://c/3" },
    }),
  ).toBeNull();
});
