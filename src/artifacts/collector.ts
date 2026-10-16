import type { CaptureFrame } from "../execution/index.ts";
import { WORKSPACE_MANIFEST_FILE, type RunHandle } from "./store.ts";

/** Anything that can stream capture frames; RemoteExecutionEnv in production. */
export interface CaptureTransport {
  collect(signal?: AbortSignal): AsyncIterable<CaptureFrame>;
}

function concatParts(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

/**
 * Drains one run's capture stream into the artifact store: complete files only
 * (a stream that dies mid-file drops that file), symlink evidence and the
 * workspace manifest recorded as text. Terminal stat values become the manifest
 * counters; a stream without a terminal stat is an error, never silent success.
 */
export async function collectArtifacts(
  transport: CaptureTransport,
  handle: RunHandle,
  signal?: AbortSignal,
): Promise<void> {
  const listing: string[] = [];
  let open: { target: string; parts: Uint8Array[] } | undefined;
  const flush = async (): Promise<void> => {
    if (!open) {
      return;
    }
    await handle.write(open.target, concatParts(open.parts));
    open = undefined;
  };
  const listed = (target: string): boolean =>
    target.startsWith("workspace/") || target.startsWith("home/");
  for await (const frame of transport.collect(signal)) {
    switch (frame.type) {
      case "file": {
        await flush();
        open = { target: frame.target, parts: [] };
        if (listed(frame.target)) {
          listing.push(
            `${frame.size}\t${new Date(frame.mtimeMs).toISOString()}\t${frame.target}`,
          );
        }
        break;
      }
      case "chunk": {
        if (open && open.target === frame.target) {
          open.parts.push(new Uint8Array(Buffer.from(frame.data, "base64")));
        }
        break;
      }
      case "symlink": {
        listing.push(`symlink\t${frame.target} -> ${frame.pointsTo}`);
        break;
      }
      case "stat": {
        await flush();
        handle.recordSkipped(frame.skipped);
        if (frame.truncated) {
          handle.markTruncated();
        }
        if (listing.length > 0) {
          await handle.write(
            WORKSPACE_MANIFEST_FILE,
            `${listing.join("\n")}\n`,
          );
        }
        return;
      }
    }
  }
  throw new Error("capture stream ended without a stat frame");
}
