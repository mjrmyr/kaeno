import { z } from "zod";

export const serverIdSchema = z.string().regex(/^[a-z][a-z0-9]{0,15}$/);
export const upstreamSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine((name) => name !== "__proto__", "Unsupported object key");
export const toolPolicySchema = z
  .object({
    upstream: upstreamSchema,
    readOnly: z.boolean().default(false),
    replay: z.enum(["safe", "unsafe"]).default("unsafe"),
    executionMode: z.enum(["parallel", "sequential"]).default("sequential"),
  })
  .strict();
export interface ToolPolicy {
  readonly upstream: string;
  readonly readOnly?: boolean;
  readonly replay?: "safe" | "unsafe";
  readonly executionMode?: "parallel" | "sequential";
}

export const toolContractSchema = z
  .object({
    description: z.string().max(4096),
    inputSchema: z
      .object({ type: z.literal("object") })
      .catchall(z.unknown())
      .refine(
        (schema) => Buffer.byteLength(JSON.stringify(schema)) <= 32_768,
        "Schema exceeds 32 KiB",
      ),
  })
  .strict();
export type ToolContract = z.infer<typeof toolContractSchema>;

/** Full resource identity, never origin-only. Rejections never echo the supplied URL. */
export function endpointOf(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid MCP endpoint");
  }
  if (
    url.username ||
    url.password ||
    url.href.includes("#") ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  ) {
    throw new Error(
      "MCP endpoint requires HTTPS (or loopback HTTP), no userinfo or fragment",
    );
  }
  for (const key of url.searchParams.keys()) {
    if (
      /(token|secret|password|passwd|credential|auth|session|api.?key|signature|^sig$|^key$|^code$)/i.test(
        key,
      )
    ) {
      throw new Error(
        "MCP endpoint has a credential-like query key; use header files",
      );
    }
  }
  return url.href;
}

export function toolName(id: string, upstream: string): string {
  const name = upstream.startsWith(`${id}_`) ? upstream : `${id}_${upstream}`;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error("Invalid derived MCP tool name");
  }
  return name;
}
