import { z } from "zod";
import type { Binding } from "../application/index.ts";

export const GITHUB_EXTENSION = "kaeno-github";
export const GITHUB_TOOLS = [
  "github_list_repositories",
  "github_checkout",
  "github_publish",
] as const;

const installationSchema = z
  .object({ installationId: z.number().int().positive() })
  .strict();

/** Assign an installation, not a second set of repository permissions. */
export function githubBinding(installationId: number): Binding {
  return {
    owner: GITHUB_EXTENSION,
    version: 2,
    value: installationSchema.parse({ installationId }),
  };
}

export function readGitHubInstallation(
  binding: Binding | undefined,
): number | undefined {
  if (!binding) {
    return undefined;
  }
  if (binding.owner !== GITHUB_EXTENSION || binding.version !== 2) {
    throw new Error("GitHub: unsupported binding");
  }
  return installationSchema.parse(binding.value).installationId;
}

export function githubPrompt(
  tools: readonly string[],
  assigned: boolean,
): string | undefined {
  const selected = GITHUB_TOOLS.filter((tool) => tools.includes(tool));
  if (selected.length === 0) {
    return undefined;
  }
  if (!assigned) {
    return "GitHub tools are selected, but no installation is assigned. Ask the owner to configure access.";
  }
  const lines = [
    "GitHub installation access is assigned. GitHub controls accessible repositories and permissions.",
  ];
  if (selected.includes("github_list_repositories")) {
    lines.push(
      "Use github_list_repositories to discover accessible project names and default branches.",
    );
  }
  if (selected.includes("github_checkout")) {
    lines.push(
      "Use github_checkout to prepare a repository in your sandbox. It returns the checkout path and base commit. Edit and test there with your coding tools.",
    );
  }
  if (selected.includes("github_publish")) {
    lines.push(
      "Use github_publish to snapshot local changes, publish a work branch, and create or reuse a draft PR. Commit locally only if useful; publishing includes uncommitted, non-ignored changes.",
    );
  }
  lines.push(
    "Skills explain workflows; they do not grant access. These tools cannot merge PRs, force-push, or administer repositories. Never request credentials in a prompt.",
  );
  return lines.join("\n");
}
