import { z } from "zod";

export const threadKey = z.string().regex(/^[A-Za-z0-9:_.-]{1,200}$/);
const threadSchema = z.object({
  key: threadKey,
  conversationId: z.number().or(z.string()),
  createdAt: z.number(),
});
const replySchema = z.object({
  id: z.number().int().positive(),
  requestId: z.string(),
  text: z.string(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user") }),
    z.object({
      kind: z.literal("activity-result"),
      activityId: z.number().or(z.string()),
      label: z.string().optional(),
    }),
  ]),
  epoch: z.number(),
});
const pageSchema = z.object({
  replies: z.array(replySchema),
  next: z.number(),
  truncated: z.boolean(),
});
const admissionSchema = z.object({ taskId: z.number().or(z.string()) });
export type Thread = z.infer<typeof threadSchema>;
export type Reply = z.infer<typeof replySchema>;

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`/v1${path}`, {
    ...options,
    signal: options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(
      `Kaeno returned HTTP ${response.status}. Check the host and try again.`,
    );
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success)
    throw new Error(
      "The host returned an unsupported response. Check that UI and host versions match.",
    );
  return parsed.data;
}

export const api = {
  threads: (signal?: AbortSignal) =>
    request("/threads", z.array(threadSchema), { signal }),
  replies: (key: string, signal?: AbortSignal) =>
    request(`/threads/${encodeURIComponent(key)}/replies?after=0`, pageSchema, {
      signal,
    }),
  send: (key: string, text: string, requestId: string) =>
    request(`/threads/${encodeURIComponent(key)}/turn`, admissionSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, requestId }),
    }),
  stop: (key: string) =>
    request(`/threads/${encodeURIComponent(key)}/stop`, admissionSchema, {
      method: "POST",
    }),
};
