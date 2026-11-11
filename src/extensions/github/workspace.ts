import type { Context } from "@earendil-works/chord";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { commitSchema, MAX_BUNDLE_BYTES } from "./git.ts";

export async function workspaceGit(
  env: ExecutionEnv,
  path: string,
  args: readonly string[],
  context: Context,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  let output = "";
  const result = getOrThrow(
    await env.exec(
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-C",
        path,
        ...args,
      ],
      {
        env: {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_TERMINAL_PROMPT: "0",
          ...extraEnv,
        },
        timeout: 120_000,
        onOutput: (chunk, _context, info) => {
          if (info.stream === "stdout") {
            output += chunk;
            if (Buffer.byteLength(output) > 1024 * 1024) {
              throw new Error("Git output limit exceeded");
            }
          }
        },
      },
      context,
    ),
  );
  if (result.exitCode !== 0) {
    throw new Error(
      "GitHub workspace Git failed; inspect the checkout with your coding tools",
    );
  }
  return output.trim();
}

/** Only the extension's staging path is disposable. Never reset an existing checkout. */
export async function installCheckout(
  env: ExecutionEnv,
  path: string,
  bundle: Uint8Array,
  context: Context,
): Promise<void> {
  if (getOrThrow(await env.exists(path, context))) {
    return;
  }
  const staging = `${path}.preparing`;
  getOrThrow(
    await env.remove(staging, { recursive: true, force: true }, context),
  );
  getOrThrow(await env.createDir(staging, { recursive: true }, context));
  const bundlePath = `${staging}/source.bundle`;
  getOrThrow(await env.writeFile(bundlePath, bundle, context));
  await workspaceGit(
    env,
    staging,
    [
      "clone",
      "--quiet",
      "--no-local",
      "--branch",
      "kaeno-base",
      "--",
      bundlePath,
      `${staging}/checkout`,
    ],
    context,
  );
  await workspaceGit(
    env,
    `${staging}/checkout`,
    ["remote", "remove", "origin"],
    context,
  );
  getOrThrow(await env.renameFile(`${staging}/checkout`, path, context));
  getOrThrow(
    await env.remove(staging, { recursive: true, force: true }, context),
  );
}

/** Import objects without changing HEAD, the index or working files. Safe to repeat. */
export async function importFetchedBranch(
  env: ExecutionEnv,
  path: string,
  bundle: Uint8Array,
  sha: string,
  previous: string,
  context: Context,
): Promise<void> {
  const bundlePath = getOrThrow(
    await env.createTempFile({ prefix: "kaeno-github-fetch-" }, context),
  );
  try {
    getOrThrow(await env.writeFile(bundlePath, bundle, context));
    await workspaceGit(
      env,
      path,
      ["fetch", "--no-tags", "--", bundlePath, "refs/heads/kaeno-base"],
      context,
    );
    const received = await workspaceGit(
      env,
      path,
      ["rev-parse", "FETCH_HEAD^{commit}"],
      context,
    );
    if (received !== sha) {
      throw new Error(
        "GitHub: fetched bundle does not match the saved fetch intent",
      );
    }
    const ancestor = await workspaceGit(
      env,
      path,
      ["merge-base", previous, sha],
      context,
    );
    if (ancestor !== previous) {
      throw new Error(
        "GitHub: work branch history was rewritten; refusing to adopt it",
      );
    }
    await workspaceGit(
      env,
      path,
      ["update-ref", "refs/remotes/kaeno/work", sha],
      context,
    );
  } finally {
    getOrThrow(await env.remove(bundlePath, { force: true }, context));
  }
}

/** A fetched head must be integrated; an accepted fetched parent must also include the shared publication. */
export async function requireIntegratedHead(
  env: ExecutionEnv,
  path: string,
  sha: string,
  context: Context,
  head = "HEAD",
): Promise<void> {
  const ancestor = await workspaceGit(
    env,
    path,
    ["merge-base", sha, head],
    context,
  );
  if (ancestor !== sha) {
    throw new Error(
      "GitHub: merge or rebase onto the fetched work branch before publishing",
    );
  }
}

/** Capture files, not arbitrary local commit history; parent is the accepted remote head. */
export async function snapshotCheckout(
  env: ExecutionEnv,
  path: string,
  parent: string,
  title: string,
  date: string,
  context: Context,
): Promise<string> {
  // Snapshotting uses a separate index, so explicitly check the worker's real merge state.
  const unmerged = await workspaceGit(
    env,
    path,
    ["ls-files", "--unmerged"],
    context,
  );
  for (const marker of [
    "MERGE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
  ]) {
    const markerPath = await workspaceGit(
      env,
      path,
      ["rev-parse", "--path-format=absolute", "--git-path", marker],
      context,
    );
    if (getOrThrow(await env.exists(markerPath, context))) {
      throw new Error(
        "GitHub: finish or abort the in-progress Git operation before publishing",
      );
    }
  }
  if (unmerged) {
    throw new Error(
      "GitHub: resolve and stage merge conflicts before publishing",
    );
  }
  const index = getOrThrow(
    await env.createTempFile({ prefix: "kaeno-github-index-" }, context),
  );
  // Git expects a missing index or a valid index, not an empty file.
  getOrThrow(await env.remove(index, { force: true }, context));
  const variables = {
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: "kaeno",
    GIT_AUTHOR_EMAIL: "bot@kaeno.io",
    GIT_COMMITTER_NAME: "kaeno",
    GIT_COMMITTER_EMAIL: "bot@kaeno.io",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  try {
    await workspaceGit(env, path, ["read-tree", parent], context, variables);
    await workspaceGit(
      env,
      path,
      ["add", "--all", "--", "."],
      context,
      variables,
    );
    const tree = commitSchema.parse(
      await workspaceGit(env, path, ["write-tree"], context, variables),
    );
    const previous = await workspaceGit(
      env,
      path,
      ["rev-parse", `${parent}^{tree}`],
      context,
      variables,
    );
    if (tree === previous) {
      return parent;
    }
    return commitSchema.parse(
      await workspaceGit(
        env,
        path,
        ["commit-tree", tree, "-p", parent, "-m", title],
        context,
        variables,
      ),
    );
  } finally {
    getOrThrow(await env.remove(index, { force: true }, context));
  }
}

export async function exportCheckout(
  env: ExecutionEnv,
  path: string,
  sha: string,
  context: Context,
): Promise<Uint8Array> {
  const bundlePath = getOrThrow(
    await env.createTempFile({ prefix: "kaeno-github-bundle-" }, context),
  );
  try {
    await workspaceGit(
      env,
      path,
      ["update-ref", "refs/heads/kaeno-export", sha],
      context,
    );
    await workspaceGit(
      env,
      path,
      ["bundle", "create", bundlePath, "refs/heads/kaeno-export"],
      context,
    );
    const reader = getOrThrow(
      await env.openBinaryReader(bundlePath, { noFollow: true }, context),
    );
    try {
      const info = getOrThrow(await reader.info(context));
      if (info.size > MAX_BUNDLE_BYTES) {
        throw new Error("GitHub publish exceeds the 100 MiB bundle limit");
      }
      return getOrThrow(await reader.read(0, info.size, context));
    } finally {
      await reader.close(context);
    }
  } finally {
    getOrThrow(await env.remove(bundlePath, { force: true }, context));
  }
}
