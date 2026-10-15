import { z } from "zod";
import { SANDBOX_QUOTA, type QuotaLimits } from "./resources.ts";
const containerStatusSchema = z.object({
  name: z.string(),
  state: z
    .object({
      terminated: z
        .object({
          exitCode: z.number(),
          message: z.string().optional(),
          reason: z.string().optional(),
        })
        .optional(),
      waiting: z
        .object({
          reason: z.string().optional(),
          message: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export const podSchema = z.object({
  metadata: z.object({
    name: z.string(),
    annotations: z.record(z.string(), z.string()).optional(),
    labels: z.record(z.string(), z.string()).optional(),
  }),
  spec: z
    .object({
      containers: z
        .array(
          z.object({
            image: z.string().optional(),
            env: z
              .array(
                z.object({
                  name: z.string(),
                  value: z.string().optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
      volumes: z
        .array(
          z.object({
            name: z.string(),
            persistentVolumeClaim: z
              .object({ claimName: z.string() })
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  status: z
    .object({
      conditions: z
        .array(z.object({ type: z.string(), status: z.string() }))
        .optional(),
      phase: z.string().optional(),
      reason: z.string().optional(),
      initContainerStatuses: z.array(containerStatusSchema).optional(),
      containerStatuses: z.array(containerStatusSchema).optional(),
    })
    .optional(),
});
export interface Pod extends z.infer<typeof podSchema> {}
export interface SandboxClient {
  readonly namespace: string;
  getPod(name: string): Promise<Pod | undefined>;
  createPod(pod: unknown): Promise<void>;
  deletePod(name: string): Promise<void>;
  listSandboxPods(): Promise<Pod[]>;
  /** Container logs; undefined once the pod is gone. */
  getPodLog(name: string): Promise<string | undefined>;
  /** `spec.hard` of the sandbox ResourceQuota, verified to charge sandboxes only. */
  readSandboxQuota(): Promise<QuotaLimits>;
}
export const SANDBOX_LABEL = "app.kubernetes.io/name=kaeno-sandbox";
export class KubernetesClient {
  readonly namespace: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly readToken: () => Promise<string>;
  private readonly api: string;
  private readonly pods: string;
  constructor(
    namespace: string,
    fetch: typeof globalThis.fetch,
    readToken: () => Promise<string>,
    api = "https://kubernetes.default.svc",
  ) {
    this.namespace = namespace;
    this.fetch = fetch;
    this.readToken = readToken;
    this.api = api;
    this.pods = `/api/v1/namespaces/${namespace}/pods`;
  }
  private async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const token = (await this.readToken()).trim();
    const response = await this.fetch(this.api + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (
      response.status === 404 ||
      (response.status === 409 && method === "POST")
    ) {
      return undefined;
    }
    const payload = await response.text();
    if (!response.ok) {
      throw new Error(
        `${method} ${path} → ${response.status}: ${payload.slice(0, 300)}`,
      );
    }
    if (!payload) {
      return undefined;
    }
    const value: unknown = JSON.parse(payload);
    return value;
  }
  async getPod(name: string): Promise<Pod | undefined> {
    const value = await this.call("GET", `${this.pods}/${name}`);
    if (value === undefined) {
      return undefined;
    }
    return podSchema.parse(value);
  }
  async createPod(pod: unknown): Promise<void> {
    await this.call("POST", this.pods, pod);
  }
  async deletePod(name: string): Promise<void> {
    await this.call("DELETE", `${this.pods}/${name}?gracePeriodSeconds=5`);
  }
  /** Pod logs are plain text, not JSON — fetched outside the JSON `call` helper. */
  async getPodLog(name: string): Promise<string | undefined> {
    const token = (await this.readToken()).trim();
    const response = await this.fetch(`${this.api}${this.pods}/${name}/log`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      const payload = await response.text();
      throw new Error(
        `GET ${this.pods}/${name}/log → ${response.status}: ${payload.slice(0, 300)}`,
      );
    }
    return response.text();
  }
  async readSandboxQuota(): Promise<QuotaLimits> {
    const path = `/api/v1/namespaces/${this.namespace}/resourcequotas/${SANDBOX_QUOTA}`;
    const value = await this.call("GET", path);
    if (value === undefined) {
      throw new Error(
        `ResourceQuota ${SANDBOX_QUOTA} not found; kaeno sizes its sandbox pool from it`,
      );
    }
    const quota = z
      .object({
        spec: z.object({
          scopes: z.array(z.string()).default([]),
          scopeSelector: z.unknown().optional(),
          hard: z.record(z.string(), z.string()).default({}),
        }),
      })
      .parse(value).spec;
    // Terminating = pods with activeDeadlineSeconds = sandboxes. Any other scope would also
    // charge the orchestrator (or miss sandboxes), so the derived pool size would be wrong.
    if (
      quota.scopes.length !== 1 ||
      quota.scopes[0] !== "Terminating" ||
      quota.scopeSelector !== undefined
    ) {
      throw new Error(
        `ResourceQuota ${SANDBOX_QUOTA} must have exactly scopes: ["Terminating"]`,
      );
    }
    return quota.hard;
  }
  async listSandboxPods(): Promise<Pod[]> {
    const value = await this.call(
      "GET",
      `${this.pods}?labelSelector=${encodeURIComponent(SANDBOX_LABEL)}`,
    );
    return z
      .object({ items: z.array(podSchema).default([]) })
      .parse(value ?? {}).items;
  }
}
export function isReady(pod: Pick<Pod, "status"> | undefined): boolean {
  return (
    pod?.status?.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    ) ?? false
  );
}
export function failedReason(
  pod: Pick<Pod, "status"> | undefined,
): string | undefined {
  for (const status of [
    ...(pod?.status?.initContainerStatuses ?? []),
    ...(pod?.status?.containerStatuses ?? []),
  ]) {
    const ended = status.state?.terminated;
    if (ended?.exitCode && status.name === "skills") {
      return `skills init exited ${ended.exitCode}: ${ended.message ?? ended.reason ?? "copy failed"}`;
    }
    const waiting = status.state?.waiting;
    if (
      waiting?.reason &&
      [
        "ErrImagePull",
        "ImagePullBackOff",
        "CreateContainerConfigError",
        "InvalidImageName",
        "CrashLoopBackOff",
      ].includes(waiting.reason)
    ) {
      return `${status.name}: ${waiting.reason}: ${waiting.message ?? ""}`;
    }
  }
  if (pod?.status?.phase === "Failed" || pod?.status?.phase === "Succeeded") {
    return `pod ${pod.status.phase}: ${pod.status.reason ?? ""}`;
  }
  return undefined;
}
