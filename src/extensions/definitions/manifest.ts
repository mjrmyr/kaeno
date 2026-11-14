import type { JsonValue } from "@earendil-works/chord";
import { parseDocument } from "yaml";
import { z } from "zod";

/** A problem with one definition, reported instead of silently skipping it. */
export interface Diagnostic {
  readonly location: string;
  readonly message: string;
}

/** A Markdown manifest split into YAML frontmatter and body. Frontmatter is data only. */
export interface Manifest {
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

/**
 * Parse `---\nyaml\n---\nbody`. No aliases, no custom tags, duplicate keys rejected, and only
 * JSON values accepted, so frontmatter cannot execute or reference anything.
 */
export function parseManifest(text: string, location: string): Manifest {
  const match = FRONTMATTER.exec(text);
  if (!match) {
    throw new Error(`${location}: missing YAML frontmatter`);
  }
  let raw: unknown;
  try {
    const document = parseDocument(match[1], {
      uniqueKeys: true,
      customTags: [],
      strict: true,
    });
    const problem = document.errors[0] ?? document.warnings[0];
    if (problem) {
      throw problem;
    }
    raw = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Error(
      `${location}: invalid frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const metadata = z.record(z.string(), jsonValue).safeParse(raw);
  if (!metadata.success) {
    throw new Error(
      `${location}: frontmatter must be a mapping of JSON values`,
    );
  }
  return { metadata: metadata.data, body: text.slice(match[0].length).trim() };
}

/** Required nonempty discovery metadata for skills. */
export function discoveryMetadata(
  manifest: Manifest,
  location: string,
): { name: string; description: string } {
  const parsed = z
    .object({
      name: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      description: z.string().trim().min(1).max(1024),
    })
    .safeParse(manifest.metadata);
  if (!parsed.success) {
    throw new Error(
      `${location}: "name" (letters, digits, ".", "_", "-") and a nonempty "description" are required`,
    );
  }
  return parsed.data;
}
