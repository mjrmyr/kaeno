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

/** Capture files, not arbitrary local commit history; parent is the last extension-published commit. */
export async function snapshotCheckout(
  env: ExecutionEnv,
  path: string,
  parent: string,
  title: string,
  date: string,
  context: Context,
): Promise<string> {
  const index = getOrThrow(
    await env.createTempFile({ prefix: "kaeno-github-index-" }, context),
  );
  // Git expects a missing index or a valid index, not an empty file.
  getOrThrow(await env.remove(index, { force: true }, context));
  const variables = {
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: "Kaeno",
    GIT_AUTHOR_EMAIL: "kaeno@localhost",
    GIT_COMMITTER_NAME: "Kaeno",
    GIT_COMMITTER_EMAIL: "kaeno@localhost",
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
