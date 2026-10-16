import { createReadStream } from "node:fs";
import { readdir, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  HOME_ROOT,
  WORKSPACE_ROOT,
  isBlacklisted,
} from "../artifacts/index.ts";

/** A capture root mapped to its sandbox directory: `dir` is walked, `name` is the artifact target prefix. */
export interface CaptureRootMapping {
  name: "workspace" | "home";
  dir: string;
}

export const DEFAULT_CAPTURE_ROOTS: readonly CaptureRootMapping[] = [
  { name: "workspace", dir: WORKSPACE_ROOT },
  { name: "home", dir: HOME_ROOT },
];

/** Decoded chunk size for streamed file contents; the cap counts decoded bytes, not base64. */
const CHUNK_BYTES = 256 * 1024;

const fileFrameSchema = z.strictObject({
  type: z.literal("file"),
  target: z.string().min(1),
  size: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
  mtimeMs: z.number(),
});
const chunkFrameSchema = z.strictObject({
  type: z.literal("chunk"),
  target: z.string().min(1),
  data: z.string(),
});
const symlinkFrameSchema = z.strictObject({
  type: z.literal("symlink"),
  target: z.string().min(1),
  pointsTo: z.string(),
});
const statFrameSchema = z.strictObject({
  type: z.literal("stat"),
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export const captureFrameSchema = z.discriminatedUnion("type", [
  fileFrameSchema,
  chunkFrameSchema,
  symlinkFrameSchema,
  statFrameSchema,
]);
export type CaptureFrame = z.infer<typeof captureFrameSchema>;

interface CaptureState {
  bytes: number;
  skipped: number;
  truncated: boolean;
}

/**
 * Streams one run's evidence as capture frames. Files are sent whole or not at all:
 * when the cap is reached the walk stops (truncated) rather than persisting partial
 * files. Symlinks are recorded with their targets but never followed — a link may
 * point outside the capture roots (for example at mounted credentials). Directories
 * on the blacklist prune their whole subtree.
 */
export async function streamCapture(options: {
  roots: readonly CaptureRootMapping[];
  capBytes: number;
  requestLog: string;
  write: (frame: CaptureFrame) => void;
}): Promise<void> {
  const state: CaptureState = { bytes: 0, skipped: 0, truncated: false };
  const budget = (): number => options.capBytes - state.bytes;
  const emitContent = (target: string, content: Buffer): void => {
    options.write({
      type: "file",
      target,
      size: content.byteLength,
      mode: 0o100644,
      mtimeMs: Date.now(),
    });
    for (let offset = 0; offset < content.byteLength; offset += CHUNK_BYTES) {
      options.write({
        type: "chunk",
        target,
        data: content.subarray(offset, offset + CHUNK_BYTES).toString("base64"),
      });
    }
    state.bytes += content.byteLength;
  };
  // The request log lands first so it survives even when the tree walk hits the cap immediately.
  const log = Buffer.from(options.requestLog, "utf8");
  if (log.byteLength > 0) {
    if (log.byteLength > budget()) {
      state.truncated = true;
    } else {
      emitContent("envd.log", log);
    }
  }
  if (!state.truncated) {
    for (const mapping of options.roots) {
      if (
        !(await walkTree(
          mapping,
          "",
          budget,
          emitContent,
          state,
          options.write,
        ))
      ) {
        break;
      }
    }
  }
  options.write({
    type: "stat",
    truncated: state.truncated,
    bytes: state.bytes,
    skipped: state.skipped,
  });
}

async function walkTree(
  mapping: CaptureRootMapping,
  relative: string,
  budget: () => number,
  emitContent: (target: string, content: Buffer) => void,
  state: CaptureState,
  write: (frame: CaptureFrame) => void,
): Promise<boolean> {
  const directory = relative ? join(mapping.dir, relative) : mapping.dir;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    // A missing capture root is not a failure: evidence simply is not there (yet).
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const sandboxPath = join(directory, entry.name);
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const target = `${mapping.name}/${childRelative}`;
    if (isBlacklisted(sandboxPath)) {
      state.skipped += 1;
      continue;
    }
    if (entry.isDirectory()) {
      if (
        !(await walkTree(
          mapping,
          childRelative,
          budget,
          emitContent,
          state,
          write,
        ))
      ) {
        return false;
      }
    } else if (entry.isSymbolicLink()) {
      write({
        type: "symlink",
        target,
        pointsTo: await readlink(sandboxPath),
      });
    } else if (entry.isFile()) {
      const info = await stat(sandboxPath);
      if (info.size > budget()) {
        state.truncated = true;
        return false;
      }
      write({
        type: "file",
        target,
        size: info.size,
        mode: info.mode & 0o7777,
        mtimeMs: info.mtimeMs,
      });
      for await (const chunk of createReadStream(sandboxPath, {
        highWaterMark: CHUNK_BYTES,
      })) {
        write({
          type: "chunk",
          target,
          data: chunk.toString("base64"),
        });
      }
      state.bytes += info.size;
    }
    // Other entry kinds (sockets, fifos) are not evidence and are ignored.
  }
  return true;
}
