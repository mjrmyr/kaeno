import { z } from "zod";
import {
  signed,
  WebhookUnauthorized,
  type WebhookAdapter,
  type WebhookEvent,
} from "./webhooks.ts";

/** GitHub's own CI reports as this actor, so trust can name it like any other account. */
export const GITHUB_ACTIONS = "github-actions";
const EXCERPT = 4000;

type Reported = Omit<WebhookEvent, "id">;

const account = z.object({ login: z.string().min(1) });
const repository = z.object({
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
});
const activity = z.object({
  action: z.string(),
  sender: account,
  repository,
});
const pullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
  merged: z.boolean().nullish(),
  head: z.object({ ref: z.string(), sha: z.string() }),
});
const issue = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
  body: z.string().nullish(),
  pull_request: z.unknown().optional(),
});
const comment = z.object({ body: z.string(), html_url: z.string() });

const PULL_ACTIONS = new Map([
  ["opened", "opened"],
  ["reopened", "reopened"],
  ["ready_for_review", "marked as ready for review"],
  ["converted_to_draft", "converted to a draft"],
]);

function excerpt(text: string | null | undefined): string {
  const trimmed = (text ?? "").trim();
  return trimmed.length > EXCERPT ? `${trimmed.slice(0, EXCERPT)}…` : trimmed;
}

function lines(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join("\n");
}

function reported(
  actor: string,
  thread: string,
  text: string,
  closes = false,
): Reported {
  return { threads: [thread], actor, text, closes };
}

function describePull(payload: unknown): Reported | null {
  const {
    action,
    sender,
    repository: repo,
    pull_request: pull,
  } = activity.extend({ pull_request: pullRequest }).parse(payload);
  const thread = `${repo.full_name}#${pull.number}`;
  const subject = `pull request ${thread} "${pull.title}"`;
  if (action === "synchronize") {
    return reported(
      sender.login,
      thread,
      lines(
        `${sender.login} pushed to ${subject}; ${pull.head.ref} is now at ${pull.head.sha.slice(0, 7)}.`,
        pull.html_url,
      ),
    );
  }
  if (action === "closed") {
    return reported(
      sender.login,
      thread,
      `${sender.login} ${pull.merged ? "merged" : "closed"} ${subject}.`,
      true,
    );
  }
  const done = PULL_ACTIONS.get(action);
  return done
    ? reported(
        sender.login,
        thread,
        lines(`${sender.login} ${done} ${subject}.`, pull.html_url),
      )
    : null;
}

function describeIssue(payload: unknown): Reported | null {
  const {
    action,
    sender,
    repository: repo,
    issue: subject,
  } = activity.extend({ issue }).parse(payload);
  const thread = `${repo.full_name}#${subject.number}`;
  const name = `issue ${thread} "${subject.title}"`;
  if (action === "opened") {
    return reported(
      sender.login,
      thread,
      lines(
        `${sender.login} opened ${name}:`,
        excerpt(subject.body),
        subject.html_url,
      ),
    );
  }
  if (action === "reopened") {
    return reported(sender.login, thread, `${sender.login} reopened ${name}.`);
  }
  if (action === "closed") {
    return reported(
      sender.login,
      thread,
      `${sender.login} closed ${name}.`,
      true,
    );
  }
  return null;
}

function describeComment(payload: unknown): Reported | null {
  const parsed = activity.extend({ issue, comment }).parse(payload);
  if (parsed.action !== "created") {
    return null;
  }
  const thread = `${parsed.repository.full_name}#${parsed.issue.number}`;
  const kind = parsed.issue.pull_request ? "pull request" : "issue";
  return reported(
    parsed.sender.login,
    thread,
    lines(
      `${parsed.sender.login} commented on ${kind} ${thread}:`,
      excerpt(parsed.comment.body),
      parsed.comment.html_url,
    ),
  );
}

function describeReview(payload: unknown): Reported | null {
  const parsed = activity
    .extend({
      pull_request: pullRequest,
      review: z.object({
        state: z.string(),
        body: z.string().nullish(),
        html_url: z.string(),
      }),
    })
    .parse(payload);
  if (parsed.action !== "submitted") {
    return null;
  }
  const thread = `${parsed.repository.full_name}#${parsed.pull_request.number}`;
  const verdict = parsed.review.state.toLowerCase().replaceAll("_", " ");
  return reported(
    parsed.sender.login,
    thread,
    lines(
      `${parsed.sender.login} reviewed pull request ${thread}: ${verdict}.`,
      excerpt(parsed.review.body),
      parsed.review.html_url,
    ),
  );
}

function describeReviewComment(payload: unknown): Reported | null {
  const parsed = activity
    .extend({
      pull_request: pullRequest,
      comment: comment.extend({
        path: z.string(),
        line: z.number().int().nullish(),
      }),
    })
    .parse(payload);
  if (parsed.action !== "created") {
    return null;
  }
  const thread = `${parsed.repository.full_name}#${parsed.pull_request.number}`;
  const place =
    parsed.comment.line === null || parsed.comment.line === undefined
      ? parsed.comment.path
      : `${parsed.comment.path}:${parsed.comment.line}`;
  return reported(
    parsed.sender.login,
    thread,
    lines(
      `${parsed.sender.login} commented on ${place} in pull request ${thread}:`,
      excerpt(parsed.comment.body),
      parsed.comment.html_url,
    ),
  );
}

function describeWorkflow(payload: unknown): Reported | null {
  const parsed = activity
    .extend({
      workflow_run: z.object({
        name: z.string(),
        conclusion: z.string().nullish(),
        head_sha: z.string(),
        html_url: z.string(),
        pull_requests: z.array(
          z.object({ number: z.number().int().positive() }),
        ),
      }),
    })
    .parse(payload);
  const run = parsed.workflow_run;
  if (parsed.action !== "completed" || run.pull_requests.length === 0) {
    return null;
  }
  return {
    threads: run.pull_requests.map(
      (pull) => `${parsed.repository.full_name}#${pull.number}`,
    ),
    actor: GITHUB_ACTIONS,
    text: lines(
      `Workflow "${run.name}" ${run.conclusion ?? "finished"} at ${run.head_sha.slice(0, 7)}.`,
      run.html_url,
    ),
    closes: false,
  };
}

const DESCRIBERS = new Map([
  ["pull_request", describePull],
  ["issues", describeIssue],
  ["issue_comment", describeComment],
  ["pull_request_review", describeReview],
  ["pull_request_review_comment", describeReviewComment],
  ["workflow_run", describeWorkflow],
]);

/**
 * GitHub's webhook deliveries, signed by GitHub with `X-Hub-Signature-256`. Threads are `<owner>/<repo>#<number>`,
 * shared by an issue or pull request and its comments, reviews and CI runs. The actor is the GitHub account
 * that acted, so a push to a pull request is attributed to whoever pushed, not to the commit's author.
 * Events by `self`, the account Kaeno itself acts as, are dropped: Kaeno already knows what it did.
 */
export function githubAdapter(secret: string, self?: string): WebhookAdapter {
  return {
    read(headers, body) {
      if (!signed(headers["x-hub-signature-256"], secret, body)) {
        throw new WebhookUnauthorized("Invalid signature");
      }
      const id = z
        .string()
        .regex(/^[A-Za-z0-9-]{1,100}$/)
        .parse(headers["x-github-delivery"]);
      const describe = DESCRIBERS.get(
        z.string().parse(headers["x-github-event"]),
      );
      const event = describe?.(JSON.parse(body.toString("utf8"))) ?? null;
      if (!event || event.actor === self) {
        return null;
      }
      return { id, ...event };
    },
  };
}
