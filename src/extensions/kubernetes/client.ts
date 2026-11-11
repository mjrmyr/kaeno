import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { z } from "zod";

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
    volumes: z
      .array(
        z.object({
          name: z.string(),
          persistentVolumeClaim: z.object({ claimName: z.string() }).optional(),
        }),
      )
      .default([]),
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
const claimSchema = z.object({
  metadata: z.object({
    name: z.string(),
    uid: z.string().min(1),
    labels: z.record(z.string(), z.string()).default({}),
    annotations: z.record(z.string(), z.string()).default({}),
    deletionTimestamp: z.string().nullable().optional(),
  }),
  spec: z.object({
    accessModes: z.array(z.string()),
    volumeMode: z.string().default("Filesystem"),
  }),
  status: z.object({ phase: z.string().optional() }).default({}),
});
export type PersistentVolumeClaim = z.infer<typeof claimSchema>;
export class ApiError extends Error {
  readonly status: number;
  readonly quotaExceeded: boolean;
  constructor(status: number, quotaExceeded: boolean, message: string) {
    super(message);
    this.status = status;
    this.quotaExceeded = quotaExceeded;
  }
}

/** Token is read for every request so projected service-account rotation is respected. */
interface ClientOptions {
  api: string;
  namespace: string;
  readToken(): Promise<string>;
  ca?: string;
  fetch?: typeof globalThis.fetch;
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
    const token = (await this.options.readToken()).trim();
    // Relative paths are namespace-local core resources; absolute paths are cluster-scoped.
    const url = path.startsWith("/")
      ? `${this.options.api}${path}`
      : `${this.options.api}/api/v1/namespaces/${this.options.namespace}/${path}`;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    };
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    const textBody = body === undefined ? undefined : JSON.stringify(body);
    let status: number;
    let text: string;
    if (this.options.fetch) {
      const response = await this.options.fetch(url, {
        method,
        headers,
        body: textBody,
        signal: requestSignal,
      });
      status = response.status;
      text = await response.text();
    } else {
      // Native HTTPS supports a cluster's private CA without disabling certificate verification.
      const result = await new Promise<{ status: number; text: string }>(
        (resolve, reject) => {
          const transport =
            new URL(url).protocol === "https:" ? httpsRequest : httpRequest;
          const request = transport(
            url,
            { method, headers, ca: this.options.ca, signal: requestSignal },
            (response) => {
              const chunks: Buffer[] = [];
              let bytes = 0;
              response.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > 4 * 1024 * 1024) {
                  response.destroy(
                    new Error("Kubernetes response exceeds 4 MiB"),
                  );
                } else {
                  chunks.push(chunk);
                }
              });
              response.on("error", reject);
              response.on("end", () =>
                resolve({
                  status: response.statusCode ?? 500,
                  text: Buffer.concat(chunks).toString("utf8"),
                }),
              );
            },
          );
          request.on("error", reject);
          request.end(textBody);
        },
      );
      status = result.status;
      text = result.text;
    }
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
  async claim(
    name: string,
    signal?: AbortSignal,
  ): Promise<PersistentVolumeClaim | undefined> {
    const value = await this.call(
      "GET",
      `persistentvolumeclaims/${name}`,
      undefined,
      signal,
    );
    return value === undefined ? undefined : claimSchema.parse(value);
  }
  async createClaim(manifest: object, signal?: AbortSignal): Promise<void> {
    await this.call("POST", "persistentvolumeclaims", manifest, signal);
  }
  async removeClaim(name: string, uid: string): Promise<void> {
    await this.call("DELETE", `persistentvolumeclaims/${name}`, {
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid },
    });
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
