import { expect, it } from "vitest";
import {
  githubBinding,
  githubPrompt,
  readGitHubInstallation,
  GITHUB_TOOLS,
} from "./index.ts";

it("binds only an installation and rejects old policy-bearing bindings", () => {
  const binding = githubBinding(12);
  expect(binding).toEqual({
    owner: "kaeno-github",
    version: 2,
    value: { installationId: 12 },
  });
  expect(readGitHubInstallation(binding)).toBe(12);
  expect(readGitHubInstallation(undefined)).toBeUndefined();
  expect(() =>
    readGitHubInstallation({
      ...binding,
      version: 1,
      value: {
        policy: "coder",
        installationId: 12,
        repositoryIds: [34],
        permissions: ["read"],
      },
    }),
  ).toThrow("unsupported");
  expect(() =>
    readGitHubInstallation({ ...binding, value: { installationId: "bad" } }),
  ).toThrow();
  expect(() => githubBinding(0)).toThrow();
});

it("advertises only selected tools and distinguishes missing assignment from missing tools", () => {
  expect(githubPrompt([], true)).toBeUndefined();
  expect(githubPrompt([GITHUB_TOOLS[0]], false)).toContain(
    "no installation is assigned",
  );
  const discovery = githubPrompt([GITHUB_TOOLS[0]], true);
  expect(discovery).toContain("Use github_list_repositories");
  expect(discovery).not.toContain("Use github_checkout");
  expect(discovery).not.toContain("Use github_publish");
  expect(discovery).not.toContain("Use github_fetch");
  expect(discovery).not.toContain("Use github_comment");
  const publishing = githubPrompt(["github_publish"], true);
  expect(publishing).toContain("ready-for-review");
  expect(publishing).toContain("automatically follows");
  expect(publishing).not.toContain("Use github_comment");
  const commenting = githubPrompt(["github_comment"], true);
  expect(commenting).toContain("Use github_comment");
  expect(commenting).toContain("do not post on GitHub");
  const fetching = githubPrompt(["github_fetch"], true);
  expect(fetching).toContain("refs/remotes/kaeno/work");
  expect(fetching).toContain("merge or rebase");
  expect(fetching).not.toContain("Use github_publish");
  expect(githubPrompt(GITHUB_TOOLS, true)).toContain("Use github_publish");
  expect(githubPrompt(GITHUB_TOOLS, true)).toContain(
    "GitHub controls accessible repositories and permissions",
  );
});

it("explains ticket publication selection without a resume tool", () => {
  const prompt = githubPrompt(["github_checkout"], true);
  expect(prompt).toContain("pullRequest");
  expect(prompt).toContain("newPublication: true");
  expect(prompt).toContain("own files and accepted head");
  expect(GITHUB_TOOLS).not.toContain("github_resume");
});
