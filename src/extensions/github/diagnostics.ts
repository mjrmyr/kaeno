import { z } from "zod";

// GitHub content is untrusted. Select fields rather than forwarding raw API bodies.
const text = z.string().transform((value) => value.slice(0, 4096));
const nullableText = text.nullable();
const id = z.number().int().positive();
const commit = z.string().regex(/^[a-fA-F0-9]{40}$/);
const ref = z.object({
  ref: text,
  sha: commit,
  repo: z.object({ id, full_name: text }).nullable(),
});
export const pullDetailsSchema = z.object({
  number: id,
  html_url: text,
  title: text,
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean(),
  head: ref,
  base: ref,
});
export const checkSchema = z.object({
  id,
  name: text,
  head_sha: commit,
  status: text,
  conclusion: nullableText,
  html_url: nullableText,
  details_url: nullableText,
  started_at: nullableText,
  completed_at: nullableText,
  output: z.object({
    title: nullableText,
    summary: nullableText,
    text: nullableText,
    annotations_count: z.number().int().nonnegative(),
  }),
});
export const annotationSchema = z.object({
  path: text,
  start_line: z.number().int(),
  end_line: z.number().int(),
  annotation_level: text,
  title: nullableText,
  message: text,
  raw_details: nullableText,
});
export const statusSchema = z.object({
  id,
  state: text,
  context: text,
  description: nullableText,
  target_url: nullableText,
  created_at: text,
  updated_at: text,
});
export const runSchema = z.object({
  id,
  name: nullableText,
  head_branch: nullableText,
  head_sha: commit,
  run_number: z.number().int(),
  run_attempt: z.number().int(),
  event: text,
  status: text,
  conclusion: nullableText,
  workflow_id: id,
  html_url: text,
  created_at: text,
  updated_at: text,
});
export const jobSchema = z.object({
  id,
  run_id: id,
  name: text,
  head_sha: commit,
  status: text,
  conclusion: nullableText,
  started_at: nullableText,
  completed_at: nullableText,
  html_url: nullableText,
  steps: z
    .array(
      z.object({
        name: text,
        number: z.number().int(),
        status: text,
        conclusion: nullableText,
        started_at: nullableText,
        completed_at: nullableText,
      }),
    )
    .max(1000),
});

export interface GitHubPage {
  page: number;
  perPage: number;
}
export function pageQuery(page: GitHubPage): URLSearchParams {
  return new URLSearchParams({
    page: String(page.page),
    per_page: String(page.perPage),
  });
}
export interface GitHubPageResult<T> {
  items: T[];
  page: number;
  perPage: number;
  nextPage: number | null;
  totalCount?: number;
}
export interface GitHubLog {
  text: string;
  bytes: number;
  truncated: boolean;
}
export function pageResult<T>(
  items: T[],
  page: GitHubPage,
  total?: number,
): GitHubPageResult<T> {
  return {
    items,
    page: page.page,
    perPage: page.perPage,
    // Array endpoints don't provide totals: a full page may have a next page.
    nextPage: (
      total === undefined
        ? items.length === page.perPage
        : page.page * page.perPage < total
    )
      ? page.page + 1
      : null,
    ...(total === undefined ? {} : { totalCount: total }),
  };
}

/** Only GitHub's HTTPS Actions log storage; never a caller-supplied URL. */
export function logLocation(location: string | null): URL {
  let url: URL;
  try {
    url = new URL(location ?? "");
  } catch {
    throw new Error("GitHub: invalid log redirect");
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !(
      /^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname) ||
      url.hostname === "results-receiver.actions.githubusercontent.com"
    )
  ) {
    throw new Error("GitHub: unsupported log redirect host");
  }
  return url;
}

/** Read at most limit bytes, cancelling the stream rather than buffering the whole log. */
export async function boundedLog(
  response: Response,
  limit: number,
): Promise<GitHubLog> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const remaining = limit - size;
        chunks.push(value.subarray(0, remaining));
        size += Math.min(value.length, remaining);
        if (value.length > remaining) {
          truncated = true;
          break;
        }
      }
    }
  } finally {
    await reader?.cancel();
  }
  return {
    text: Buffer.concat(chunks).toString("utf8"),
    bytes: size,
    truncated,
  };
}
