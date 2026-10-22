import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

export const RESULT_LIMITS = {
  textBytes: 32_768,
  imageBase64Chars: 2_800_000,
} as const;
export type McpFailure =
  | "timeout"
  | "cancelled"
  | "unavailable"
  | "protocol"
  | "not_loaded"
  | "auth_required"
  | "limit";
export class McpError extends Error {
  readonly kind: McpFailure;
  constructor(kind: McpFailure) {
    super(kind);
    this.kind = kind;
    this.name = "McpError";
  }
}

export function redactor(secrets: readonly string[]): (text: string) => string {
  // Also cover a server echoing just the bearer token, without its scheme.
  const raw = secrets.flatMap((value) => [
    value,
    value.replace(/^Bearer\s+/i, ""),
  ]);
  const values = [
    ...new Set(
      raw.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
    ),
  ]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  return (text) =>
    values.reduce(
      (result, value) => result.replaceAll(value, "[REDACTED]"),
      text,
    );
}

/** Fixed diagnostics, never upstream SDK errors/headers/URLs/bodies. */
export function toolError(server: string, kind: McpFailure): Error {
  const detail: Record<McpFailure, string> = {
    timeout: "deadline exceeded; the operation may have partially run",
    cancelled: "cancelled; the operation may have partially run",
    unavailable: "connection unavailable; the operation may have partially run",
    protocol: "invalid MCP response",
    not_loaded: "not loaded at startup; no request was sent",
    auth_required:
      "credentials rejected or unavailable; review host header files",
    limit: "MCP response or request limit exceeded",
  };
  return new Error(`${server}: ${kind}: ${detail[kind]}`);
}

/** Resources, links, audio and blobs are omitted, never dereferenced. */
export function boundResult(
  raw: unknown,
  redact: (text: string) => string,
): ToolExecutionResult {
  const result = CallToolResultSchema.parse(raw);
  const content: NonNullable<ToolExecutionResult["content"]> = [];
  let bytes = 0;
  let truncated = false;
  function text(value: string) {
    const buffer = Buffer.from(redact(value));
    const remaining = RESULT_LIMITS.textBytes - bytes;
    // TextDecoder drops an incomplete final UTF-8 character instead of growing beyond the byte cap.
    const bounded = new TextDecoder("utf-8", { fatal: false }).decode(
      buffer.subarray(0, remaining),
      { stream: true },
    );
    bytes += Buffer.byteLength(bounded);
    truncated ||= buffer.length > remaining;
    if (bounded) {
      content.push({ type: "text", text: bounded });
    }
  }
  for (const part of result.content) {
    if (part.type === "text") {
      text(part.text);
    } else if (
      part.type === "image" &&
      part.data.length <= RESULT_LIMITS.imageBase64Chars &&
      /^image\/(png|jpeg|gif|webp)$/.test(part.mimeType) &&
      !content.some((item) => item.type === "image")
    ) {
      content.push({ type: "image", data: part.data, mimeType: part.mimeType });
    } else {
      text(`[${part.type} omitted: response policy]`);
    }
  }
  if (
    result.structuredContent &&
    !result.content.some((part) => part.type === "text")
  ) {
    text(JSON.stringify(result.structuredContent));
  }
  if (truncated) {
    content.push({ type: "text", text: "[MCP text truncated at 32 KiB]" });
  }
  return { content, isError: result.isError };
}
