// Untrusted output, in one place. Moved (not copied) from browser/extension.ts's inline loop and
// its zod resultSchema; Browser's existing result tests must pass unchanged against this.

import type { ToolExecutionResult } from "@earendil-works/pi-durable";

/** One policy for every MCP tool. Not options: no per-server knobs to drift. */
export const RESULT_LIMITS = {
  textBytes: 32_768,
  images: 1,
  imageBase64Chars: 2_800_000,
} as const;

/**
 * Parse with the SDK CallToolResultSchema at this boundary, then bound and redact.
 *
 * text                     -> kept, cumulative 32 KiB, then "[<source> text truncated at 32 KiB]"
 * image                    -> first one within the cap; others "[Image omitted: response limit]"
 * resource (embedded text) -> its text, counted against the cap
 * resource (blob), audio,
 * resource_link            -> "[<kind> omitted]" (never fetched; resources are out of scope)
 * structuredContent        -> JSON text only when no text part exists
 * isError                  -> preserved (the model sees the server's error text, bounded)
 *
 * Invariant: output size is bounded whatever the server does; nothing is interpreted;
 * `redact` runs over every text part, so a server echoing a token back cannot leak it.
 */
export function boundResult(
  source: string,
  raw: unknown,
  redact: (text: string) => string,
): ToolExecutionResult {
  void [source, raw, redact];
  throw new Error("not implemented");
}

export type McpFailure =
  | "timeout"
  | "cancelled"
  | "unavailable"
  | "protocol"
  | "refused"
  | "retired"
  /** Host: the server's live contract no longer matches the pin (remote.ts drift check). */
  | "drift"
  /** Work: envd's baked contract digest differs from the host's (contractDigest). */
  | "image_skew"
  /** Host: OAuth token expired and unrefreshable; names `npm run auth -- login mcp <id>`. */
  | "auth_required";

/**
 * The only way an MCP failure reaches the model: `<server>: <kind>: <detail>`, detail <= 500
 * chars, redacted. Never raw SDK errors, response bodies or headers (GitHub precedent).
 * `refused` = a recipe declined the call before any upstream I/O.
 */
export function toolError(
  server: string,
  kind: McpFailure,
  detail: string,
  redact: (text: string) => string = (text) => text,
): Error {
  void [server, kind, detail, redact];
  throw new Error("not implemented");
}
