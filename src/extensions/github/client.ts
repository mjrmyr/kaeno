import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import {
  annotationSchema,
  boundedLog,
  checkSchema,
  jobSchema,
  logLocation,
  pageQuery,
  pageResult,
  pullDetailsSchema,
  runSchema,
  statusSchema,
  type GitHubPage,
  type GitHubPageResult,
  type GitHubLog,
} from "./diagnostics.ts";

const repositorySchema = z.object({
  id: z.number().int().positive(),
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  default_branch: z.string().min(1),
});
export type GitHubRepository = z.infer<typeof repositorySchema>;
const pullSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  node_id: z.string().min(1),
  head: z.object({
    ref: z.string(),
    repo: z.object({ id: z.number() }).nullable(),
  }),
  base: z.object({ ref: z.string() }),
});
export type GitHubPull = z.infer<typeof pullSchema>;

/** Authentication and API parsing stay on the host. Response bodies never enter errors. */
export class GitHubClient {
  private readonly key: KeyObject;
  private readonly appId: string;
  private readonly fetch: typeof globalThis.fetch;
  constructor(options: {
    appId: string;
    privateKey: string;
    fetch?: typeof globalThis.fetch;
  }) {
    this.appId = z.string().regex(/^\d+$/).parse(options.appId);
    this.key = createPrivateKey(options.privateKey);
    if (this.key.asymmetricKeyType !== "rsa") {
      throw new Error("GitHub App requires an RSA private key");
    }
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId }),
    ).toString("base64url");
    const unsigned = `${header}.${payload}`;
    return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), this.key).toString("base64url")}`;
  }

  private async request(
    path: string,
    token: string,
    signal: AbortSignal | undefined,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.fetch(`https://api.github.com${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "kaeno-github",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    }).catch(() => {
      throw new Error(
        "GitHub: request failed or timed out; retry or check installation access",
      );
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `GitHub API HTTP ${response.status}; check installation access and repository permissions`,
      );
    }
    return response.json().catch(() => {
      throw new Error("GitHub: invalid API response");
    });
  }

  async token(
    installationId: number,
    repositoryId?: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.request(
      `/app/installations/${installationId}/access_tokens`,
      this.jwt(),
      signal,
      repositoryId === undefined ? {} : { repository_ids: [repositoryId] },
    );
    return z.object({ token: z.string().min(1) }).parse(response).token;
  }

  async repositories(
    token: string,
    signal?: AbortSignal,
  ): Promise<GitHubRepository[]> {
    const repositories: GitHubRepository[] = [];
    for (let page = 1; ; page++) {
      const result = z
        .object({ repositories: z.array(repositorySchema) })
        .parse(
          await this.request(
            `/installation/repositories?per_page=100&page=${page}`,
            token,
            signal,
          ),
        );
      repositories.push(...result.repositories);
      if (result.repositories.length < 100) {
        return repositories;
      }
    }
  }

  async repository(
    token: string,
    id: number,
    signal?: AbortSignal,
  ): Promise<GitHubRepository> {
    const repository = repositorySchema.parse(
      await this.request(`/repositories/${id}`, token, signal),
    );
    if (repository.id !== id) {
      throw new Error("GitHub returned a different repository");
    }
    return repository;
  }

  async pull(
    token: string,
    repository: GitHubRepository,
    number: number,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof pullDetailsSchema>> {
    return pullDetailsSchema.parse(
      await this.request(
        `/repos/${repository.full_name}/pulls/${number}`,
        token,
        signal,
      ),
    );
  }

  async checks(
    token: string,
    repository: GitHubRepository,
    sha: string,
    page: GitHubPage,
    signal?: AbortSignal,
  ): Promise<GitHubPageResult<z.infer<typeof checkSchema>>> {
    const result = z
      .object({
        total_count: z.number(),
        check_runs: z.array(checkSchema).max(page.perPage),
      })
      .parse(
        await this.request(
          `/repos/${repository.full_name}/commits/${sha}/check-runs?${pageQuery(page)}`,
          token,
          signal,
        ),
      );
    return pageResult(result.check_runs, page, result.total_count);
  }

  async annotations(
    token: string,
    repository: GitHubRepository,
    check: number,
    page: GitHubPage,
    signal?: AbortSignal,
  ): Promise<GitHubPageResult<z.infer<typeof annotationSchema>>> {
    const items = z
      .array(annotationSchema)
      .max(page.perPage)
      .parse(
        await this.request(
          `/repos/${repository.full_name}/check-runs/${check}/annotations?${pageQuery(page)}`,
          token,
          signal,
        ),
      );
    return pageResult(items, page);
  }

  async statuses(
    token: string,
    repository: GitHubRepository,
    sha: string,
    page: GitHubPage,
    signal?: AbortSignal,
  ): Promise<GitHubPageResult<z.infer<typeof statusSchema>>> {
    const items = z
      .array(statusSchema)
      .max(page.perPage)
      .parse(
        await this.request(
          `/repos/${repository.full_name}/commits/${sha}/statuses?${pageQuery(page)}`,
          token,
          signal,
        ),
      );
    return pageResult(items, page);
  }

  async runs(
    token: string,
    repository: GitHubRepository,
    sha: string | undefined,
    page: GitHubPage,
    signal?: AbortSignal,
  ): Promise<GitHubPageResult<z.infer<typeof runSchema>>> {
    const query = pageQuery(page);
    if (sha) {
      query.set("head_sha", sha);
    }
    const result = z
      .object({
        total_count: z.number(),
        workflow_runs: z.array(runSchema).max(page.perPage),
      })
      .parse(
        await this.request(
          `/repos/${repository.full_name}/actions/runs?${query}`,
          token,
          signal,
        ),
      );
    return pageResult(result.workflow_runs, page, result.total_count);
  }

  async jobs(
    token: string,
    repository: GitHubRepository,
    run: number,
    page: GitHubPage,
    signal?: AbortSignal,
  ): Promise<GitHubPageResult<z.infer<typeof jobSchema>>> {
    const result = z
      .object({
        total_count: z.number(),
        jobs: z.array(jobSchema).max(page.perPage),
      })
      .parse(
        await this.request(
          `/repos/${repository.full_name}/actions/runs/${run}/jobs?${pageQuery(page)}`,
          token,
          signal,
        ),
      );
    return pageResult(result.jobs, page, result.total_count);
  }

  async logs(
    token: string,
    repository: GitHubRepository,
    job: number,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<GitHubLog & { untrusted: boolean }> {
    const timeout = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000);
    try {
      const response = await this.fetch(
        `https://api.github.com/repos/${repository.full_name}/actions/jobs/${job}/logs`,
        {
          redirect: "manual",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "kaeno-github",
          },
          signal: timeout,
        },
      );
      if (response.status !== 302) {
        await response.body?.cancel();
        throw new Error(`GitHub logs HTTP ${response.status}`);
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      const url = logLocation(location);
      // Signed storage URL only. Never forward installation credentials or follow another redirect.
      const download = await this.fetch(url, {
        redirect: "error",
        signal: timeout,
      });
      if (!download.ok) {
        await download.body?.cancel();
        throw new Error(`GitHub logs HTTP ${download.status}`);
      }
      const result = await boundedLog(download, maxBytes);
      return {
        ...result,
        text: result.text.split(token).join("[REDACTED]"),
        untrusted: true,
      };
    } catch {
      // Fetch errors can include signed URLs. Do not surface them, response bodies, or credentials.
      throw new Error(
        "GitHub: unable to retrieve job logs; check installation Actions read permission, job ID, and log retention (or retry if unavailable)",
      );
    }
  }

  /** Reconcile a lost POST response using an invocation-specific marker before posting again. */
  async comment(
    token: string,
    repository: GitHubRepository,
    number: number,
    body: string,
    marker: string,
    signal?: AbortSignal,
  ): Promise<{ id: number; html_url: string }> {
    // Issue comments share this endpoint; verify the target really is a pull request.
    await this.pull(token, repository, number, signal);
    const schema = z.object({
      id: z.number().int().positive(),
      html_url: z.string().url(),
      body: z.string().nullish(),
    });
    const path = `/repos/${repository.full_name}/issues/${number}/comments`;
    for (let page = 1; ; page++) {
      const comments = z
        .array(schema)
        .parse(
          await this.request(
            `${path}?per_page=100&page=${page}`,
            token,
            signal,
          ),
        );
      const existing = comments.find((comment) =>
        comment.body?.endsWith(marker),
      );
      if (existing) {
        return { id: existing.id, html_url: existing.html_url };
      }
      if (comments.length < 100) {
        break;
      }
    }
    const created = schema.parse(
      await this.request(path, token, signal, { body: `${body}\n\n${marker}` }),
    );
    return { id: created.id, html_url: created.html_url };
  }

  async findWorkPull(
    token: string,
    repository: GitHubRepository,
    branch: string,
    base: string,
    signal?: AbortSignal,
  ): Promise<GitHubPull | undefined> {
    const owner = repository.full_name.split("/")[0];
    // Reconcile before creating: a prior request may have succeeded before the host crashed.
    const query = new URLSearchParams({
      state: "all",
      head: `${owner}:${branch}`,
      per_page: "100",
    });
    const pulls = z
      .array(pullSchema)
      .parse(
        await this.request(
          `/repos/${repository.full_name}/pulls?${query}`,
          token,
          signal,
        ),
      );
    const existing = pulls.find(
      (pull) =>
        pull.head.ref === branch && pull.head.repo?.id === repository.id,
    );
    if (existing) {
      if (existing.state !== "open" || existing.base.ref !== base) {
        throw new Error(
          "GitHub: existing work PR is closed or has a different base; start new work",
        );
      }
      return existing;
    }
    return undefined;
  }

  async workPull(
    token: string,
    repository: GitHubRepository,
    branch: string,
    base: string,
    title: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<GitHubPull> {
    const existing = await this.findWorkPull(
      token,
      repository,
      branch,
      base,
      signal,
    );
    const pull =
      existing ??
      pullSchema.parse(
        await this.request(
          `/repos/${repository.full_name}/pulls`,
          token,
          signal,
          { head: branch, base, title, body, draft: false },
        ),
      );
    if (pull.draft) {
      const result = await this.request("/graphql", token, signal, {
        query:
          "mutation Ready($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
        variables: { id: pull.node_id },
      });
      z.object({
        data: z.object({
          markPullRequestReadyForReview: z.object({
            pullRequest: z.object({ isDraft: z.literal(false) }),
          }),
        }),
      }).parse(result);
    }
    return { ...pull, draft: false };
  }
}
