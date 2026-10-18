import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { z } from "zod";

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
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `GitHub API HTTP ${response.status}; check installation access and repository permissions`,
      );
    }
    return response.json();
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

  async findDraftPull(
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
      if (
        existing.state !== "open" ||
        !existing.draft ||
        existing.base.ref !== base
      ) {
        throw new Error(
          "GitHub: existing work PR is closed, non-draft, or has a different base; start new work",
        );
      }
      return existing;
    }
    return undefined;
  }

  async draftPull(
    token: string,
    repository: GitHubRepository,
    branch: string,
    base: string,
    title: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<GitHubPull> {
    const existing = await this.findDraftPull(
      token,
      repository,
      branch,
      base,
      signal,
    );
    if (existing) {
      return existing;
    }
    return pullSchema.parse(
      await this.request(
        `/repos/${repository.full_name}/pulls`,
        token,
        signal,
        { head: branch, base, title, body, draft: true },
      ),
    );
  }
}
