import { z } from "zod";
import { apiRequest, type ApiOptions } from "./api.ts";

const containerStatus = z.object({
  name: z.string(),
  state: z
    .object({
      terminated: z
        .object({
          exitCode: z.number(),
          reason: z.string().optional(),
          message: z.string().optional(),
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
const podSchema = z.object({
  metadata: z.object({
    name: z.string(),
    labels: z.record(z.string(), z.string()).default({}),
    annotations: z.record(z.string(), z.string()).default({}),
    deletionTimestamp: z.string().nullable().optional(),
  }),
  spec: z.object({
    runtimeClassName: z.string().optional(),
    containers: z.array(z.object({ image: z.string() })),
  }),
  status: z
    .object({
      conditions: z
        .array(z.object({ type: z.string(), status: z.string() }))
        .default([]),
      phase: z.string().optional(),
      reason: z.string().optional(),
      containerStatuses: z.array(containerStatus).default([]),
      initContainerStatuses: z.array(containerStatus).default([]),
    })
    .default({
      conditions: [],
      containerStatuses: [],
      initContainerStatuses: [],
    }),
});
export type Pod = z.infer<typeof podSchema>;
export class ApiError extends Error {
  readonly status: number;
  readonly quotaExceeded: boolean;
  constructor(status: number, quotaExceeded: boolean, message: string) {
    super(message);
    this.status = status;
    this.quotaExceeded = quotaExceeded;
  }
}

interface ClientOptions extends ApiOptions {
  namespace: string;
}
export class KubernetesClient {
  private readonly options: ClientOptions;
  constructor(options: ClientOptions) {
    this.options = options;
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // Relative paths are namespace-local core resources; absolute paths are cluster-scoped.
    const { status, text } = await apiRequest(
      this.options,
      method,
      path.startsWith("/")
        ? path
        : `/api/v1/namespaces/${this.options.namespace}/${path}`,
      body,
      signal,
    );
    if (status === 404 && (method === "GET" || method === "DELETE")) {
      return undefined;
    }
    if (status === 409 && method === "POST") {
      return undefined;
    }
    if (status < 200 || status >= 300) {
      // API diagnostics may echo submitted env vars. Never include the response body/token.
      throw new ApiError(
        status,
        status === 403 && text.includes("exceeded quota"),
        `Kubernetes ${method} ${path.split("?")[0]} failed (HTTP ${status})`,
      );
    }
    return text ? JSON.parse(text) : undefined;
  }

  async pod(name: string, signal?: AbortSignal): Promise<Pod | undefined> {
    const value = await this.call("GET", `pods/${name}`, undefined, signal);
    return value === undefined ? undefined : podSchema.parse(value);
  }
  async create(manifest: object, signal?: AbortSignal): Promise<void> {
    await this.call("POST", "pods", manifest, signal);
  }
  async remove(name: string): Promise<void> {
    await this.call("DELETE", `pods/${name}?gracePeriodSeconds=5`);
  }
  async pods(selector: string, signal?: AbortSignal): Promise<Pod[]> {
    const value = await this.call(
      "GET",
      `pods?labelSelector=${encodeURIComponent(selector)}`,
      undefined,
      signal,
    );
    return z
      .object({ items: z.array(podSchema).default([]) })
      .parse(value ?? {}).items;
  }
  async quota(
    name: string,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    const value = await this.call(
      "GET",
      `resourcequotas/${name}`,
      undefined,
      signal,
    );
    if (value === undefined) {
      throw new Error(`Kubernetes ResourceQuota ${name} not found`);
    }
    const { spec } = z
      .object({
        spec: z.object({
          scopes: z.array(z.string()),
          scopeSelector: z.unknown().optional(),
          hard: z.record(z.string(), z.string()),
        }),
      })
      .parse(value);
    if (
      spec.scopes.length !== 1 ||
      spec.scopes[0] !== "Terminating" ||
      spec.scopeSelector !== undefined
    ) {
      throw new Error(
        `Kubernetes ResourceQuota ${name} must have exactly scopes: ["Terminating"]`,
      );
    }
    return spec.hard;
  }
  async runtimeClass(
    name: string,
    signal?: AbortSignal,
  ): Promise<{ cpu?: string; memory?: string }> {
    const value = await this.call(
      "GET",
      `/apis/node.k8s.io/v1/runtimeclasses/${name}`,
      undefined,
      signal,
    );
    if (value === undefined) {
      throw new Error(`Kubernetes RuntimeClass ${name} not found`);
    }
    const { overhead } = z
      .object({
        overhead: z
          .object({
            podFixed: z
              .object({ cpu: z.string(), memory: z.string() })
              .partial()
              .optional(),
          })
          .optional(),
      })
      .parse(value);
    return overhead?.podFixed ?? {};
  }
}

export function failure(pod: Pod): string | undefined {
  if (pod.metadata.deletionTimestamp) {
    return "pod is terminating";
  }
  for (const container of [
    ...pod.status.initContainerStatuses,
    ...pod.status.containerStatuses,
  ]) {
    const ended = container.state?.terminated;
    if (ended && ended.exitCode !== 0) {
      return `${container.name} exited ${ended.exitCode}`;
    }
    const reason = container.state?.waiting?.reason;
    if (
      reason &&
      [
        "ErrImagePull",
        "ImagePullBackOff",
        "CreateContainerConfigError",
        "InvalidImageName",
        "CrashLoopBackOff",
      ].includes(reason)
    ) {
      return `${container.name}: ${reason}`;
    }
  }
  if (["Failed", "Succeeded"].includes(pod.status.phase ?? "")) {
    return `pod ${pod.status.phase}`;
  }
  return undefined;
}
