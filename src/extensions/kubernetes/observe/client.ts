import { z } from "zod";
import { apiRequest, type ApiOptions } from "../api.ts";

const STATUS_MESSAGES: Record<number, string> = {
  401: "unauthorized; check the service account token",
  403: "forbidden by RBAC",
  404: "not found",
};

export class ClusterApiError extends Error {
  readonly status: number;
  constructor(path: string, status: number) {
    super(
      `Kubernetes GET ${path.split("?")[0]}: ${STATUS_MESSAGES[status] ?? `HTTP ${status}`}`,
    );
    this.status = status;
  }
}

export interface ListQuery {
  readonly namespace?: string;
  readonly labelSelector?: string;
  readonly fieldSelector?: string;
  readonly limit?: number;
}

export class ObserverClient {
  private readonly options: ApiOptions;
  constructor(options: ApiOptions) {
    this.options = options;
  }

  private async get(path: string, signal?: AbortSignal): Promise<string> {
    const { status, text } = await apiRequest(
      this.options,
      "GET",
      path,
      undefined,
      signal,
    );
    if (status < 200 || status >= 300) {
      throw new ClusterApiError(path, status);
    }
    return text;
  }

  async object(
    group: string,
    resource: string,
    name: string,
    namespace: string | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const scope = namespace
      ? `/namespaces/${encodeURIComponent(namespace)}`
      : "";
    return JSON.parse(
      await this.get(
        `${group}${scope}/${resource}/${encodeURIComponent(name)}`,
        signal,
      ),
    );
  }

  async list(
    group: string,
    resource: string,
    query: ListQuery,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const scope = query.namespace
      ? `/namespaces/${encodeURIComponent(query.namespace)}`
      : "";
    const params = new URLSearchParams();
    if (query.labelSelector) {
      params.set("labelSelector", query.labelSelector);
    }
    if (query.fieldSelector) {
      params.set("fieldSelector", query.fieldSelector);
    }
    if (query.limit) {
      params.set("limit", String(query.limit));
    }
    const search = params.size > 0 ? `?${params}` : "";
    return (
      z
        .object({ items: z.array(z.unknown()).nullish() })
        .parse(
          JSON.parse(
            await this.get(`${group}${scope}/${resource}${search}`, signal),
          ),
        ).items ?? []
    );
  }

  async log(
    namespace: string,
    pod: string,
    options: {
      container?: string;
      tailLines: number;
      sinceSeconds?: number;
      previous?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<string> {
    const params = new URLSearchParams({
      tailLines: String(options.tailLines),
      timestamps: "true",
    });
    if (options.container) {
      params.set("container", options.container);
    }
    if (options.sinceSeconds) {
      params.set("sinceSeconds", String(options.sinceSeconds));
    }
    if (options.previous) {
      params.set("previous", "true");
    }
    return this.get(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${params}`,
      signal,
    );
  }
}
