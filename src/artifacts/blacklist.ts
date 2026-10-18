/** Projected skill trees are read-only inputs, never workspace output. */
const SKILL_ROOT = "/workspace/.agents/skills";

/** Sandbox directories captured per run, keyed by their sandbox-absolute mount points. */
export const WORKSPACE_ROOT = "/workspace";
export const HOME_ROOT = "/home/agent";
export const CAPTURE_ROOTS = [WORKSPACE_ROOT, HOME_ROOT] as const;
export type CaptureRoot = (typeof CAPTURE_ROOTS)[number];

/**
 * Hardcoded per-run capture cap. The collector counts bytes while streaming and stops at
 * this many, marking the manifest truncated. The sandbox is never trusted to respect any
 * limit: worst-case abuse costs exactly this much node disk, once.
 */
export const CAPTURE_CAP_BYTES = 64 * 1024 * 1024;

/** Directory names never captured, at any depth: dependency/tool caches and git history. */
const EXCLUDED_NAMES = new Set([
  "node_modules",
  ".venv",
  "__pycache__",
  ".cache",
  ".npm",
  "target",
  ".git",
]);

/** Never captured: credentials that setupSsh copies into the home directory. */
const HOME_SSH_ROOT = "/home/agent/.ssh";

function startsWithSegment(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Total capture policy for one sandbox-absolute path. Blacklisted paths are never
 * persisted: dependency/tool caches, git history, materialized skill trees (recorded
 * via treeHash in the work blueprint and re-derivable from the skill cache), and
 * credentials. Sandboxed agents never learn this policy exists.
 */
export function isBlacklisted(sandboxPath: string): boolean {
  if (sandboxPath.split("/").some((segment) => EXCLUDED_NAMES.has(segment))) {
    return true;
  }
  return (
    startsWithSegment(sandboxPath, SKILL_ROOT) ||
    startsWithSegment(sandboxPath, HOME_SSH_ROOT)
  );
}
