import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineExtension } from "@earendil-works/pi-durable";
import type { EnvTarget } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  parseTaskId,
  parseConversationId,
  type KaenoExtension,
  type Stored,
  type WorkEnvironment,
  type WorkEnvironmentRuntime,
  type WorkInstance,
} from "../../core/application/index.ts";
import { ApiError, failure, KubernetesClient } from "./client.ts";
import {
  assertIdentity,
  OWNER_LABEL,
  SANDBOX_LABEL,
  sandboxPod,
  type Reservation,
} from "./pod.ts";
import { capacity, resourcesSchema } from "./resources.ts";

const dnsName = z
  .string()
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
export const configurationSchema = z
  .object({
    api: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          url.pathname === "/" &&
          !url.search &&
          !url.hash
        );
      }, "Use a Kubernetes API origin")
      .default("https://kubernetes.default.svc"),
    namespace: dnsName,
    owner: dnsName.max(32),
    image: z.string().trim().min(1),
    resources: resourcesSchema,
    quota: dnsName.default("kaeno-sandbox"),
    service: dnsName.default("kaeno-sandbox"),
    serviceAccount: dnsName.default("kaeno-sandbox"),
    /** Optional RuntimeClass, e.g. Kata Containers for per-pod microVM isolation. */
    runtimeClassName: dnsName.optional(),
    readyTimeoutMs: z.number().int().positive().default(240_000),
  })
  .strict();
export type KubernetesConfiguration = z.input<typeof configurationSchema>;
export interface KubernetesExtensionOptions extends KubernetesConfiguration {
  readToken(): Promise<string>;
  ca?: string;
  /** Injectable API transport for tests or owner-supplied authentication/TLS. */
  fetch?: typeof globalThis.fetch;
  createEnvironment(input: {
    url: string;
    token: string;
    id: string;
    cwd: string;
  }): ExecutionEnv;
}

const Sandboxes = defineDoc<{
  target: string;
  reservations: Stored<Reservation>[];
}>({
  kind: "kaeno.kubernetes-sandboxes",
  version: 1,
  scope: "session",
  initial: () => ({ target: "", reservations: [] }),
});

/** Optional native extension plus the consumer-owned WORK lifecycle. */
export function kubernetesExtension(options: KubernetesExtensionOptions): {
  extension: KaenoExtension;
  environment: WorkEnvironment;
} {
  const { readToken, ca, fetch, createEnvironment, ...raw } = options;
  const config = configurationSchema.parse(raw);
  const client = new KubernetesClient({
    ...config,
    api: config.api.replace(/\/$/, ""),
    readToken,
    ca,
    fetch,
  });
  return {
    extension: { durable: defineExtension({ name: "kaeno-kubernetes" }) },
    environment: new KubernetesWorkEnvironment(
      config,
      client,
      createEnvironment,
    ),
  };
}

class KubernetesWorkEnvironment implements WorkEnvironment {
  readonly cwd = "/workspace";
  readonly identity: string;
  private readonly target: string;
  private readonly config: z.output<typeof configurationSchema>;
  private readonly client: KubernetesClient;
  private readonly createEnvironment: KubernetesExtensionOptions["createEnvironment"];
  constructor(
    config: z.output<typeof configurationSchema>,
    client: KubernetesClient,
    createEnvironment: KubernetesExtensionOptions["createEnvironment"],
  ) {
    this.config = config;
    this.client = client;
    this.createEnvironment = createEnvironment;
    this.target = JSON.stringify({
      api: config.api.replace(/\/$/, ""),
      namespace: config.namespace,
      owner: config.owner,
      resources: config.resources,
      quota: config.quota,
      service: config.service,
      serviceAccount: config.serviceAccount,
      // Omitted when unset so identities saved before this option still match.
      ...(config.runtimeClassName === undefined
        ? {}
        : { runtimeClassName: config.runtimeClassName }),
    });
    this.identity = `kubernetes:${this.target}`;
  }

  private assertTarget(target: string): void {
    if (target && target !== this.target) {
      throw new Error(
        "Kubernetes saved cluster or sandbox configuration differs; restore it before resuming work",
      );
    }
  }

  async capacity(context: Context): Promise<number> {
    const signal = context.abortSignal;
    const [hard, overhead] = await Promise.all([
      this.client.quota(this.config.quota, signal),
      this.config.runtimeClassName === undefined
        ? undefined
        : this.client.runtimeClass(this.config.runtimeClassName, signal),
    ]);
    return capacity(hard, this.config.resources, overhead);
  }

  async ensure(
    work: WorkInstance,
    runtime: WorkEnvironmentRuntime,
    context: Context,
  ): Promise<void> {
    const reservation = await runtime.commit(async (tx) => {
      const state = await tx.doc(Sandboxes);
      this.assertTarget(state.target);
      state.target = this.target;
      let saved = state.reservations.find(
        (entry) => entry.workId === Number(work.workId),
      );
      if (!saved) {
        if (
          state.reservations.filter((entry) => entry.phase === "waiting")
            .length >= 128
        ) {
          throw new Error(
            "Kubernetes sandbox queue has 128 pending works; reduce fanout or retry later",
          );
        }
        saved = {
          workId: Number(work.workId),
          conversationId: Number(work.conversationId),
          pod: `${this.config.owner}-work-${work.workId}`,
          token: randomBytes(32).toString("hex"),
          image: this.config.image,
          phase: "waiting",
        };
        state.reservations.push(saved);
      }
      return { ...saved };
    }, context);
    const signal = context.abortSignal;
    for (;;) {
      signal?.throwIfAborted();
      const slots = await this.capacity(context);
      const pods = await this.client.pods(SANDBOX_LABEL, signal);
      const existing = pods.find(
        (pod) => pod.metadata.name === reservation.pod,
      );
      if (existing) {
        assertIdentity(existing, reservation, this.config);
      }
      const granted = await runtime.commit(async (tx) => {
        const state = await tx.doc(Sandboxes);
        const own = state.reservations.find(
          (entry) => entry.pod === reservation.pod,
        );
        if (!own) {
          throw new Error(
            "Kubernetes reservation was released during admission",
          );
        }
        if (own.phase === "held") {
          return true;
        }
        const held = new Set(
          state.reservations
            .filter((entry) => entry.phase === "held")
            .map((entry) => entry.pod),
        );
        const foreign = pods.filter(
          (pod) =>
            !held.has(pod.metadata.name) &&
            pod.metadata.name !== reservation.pod,
        ).length;
        const next = state.reservations.find(
          (entry) => entry.phase === "waiting",
        );
        if (
          !existing &&
          (next?.pod !== reservation.pod || held.size + foreign >= slots)
        ) {
          return false;
        }
        own.phase = "held";
        return true;
      }, context);
      if (granted) {
        break;
      }
      await delay(250, undefined, { signal });
    }
    // Quota accounting can lag deletion. Bound retries without re-acquiring capacity.
    for (let attempt = 1; attempt <= 5; attempt++) {
      signal?.throwIfAborted();
      const existing = await this.client.pod(reservation.pod, signal);
      if (existing) {
        assertIdentity(existing, reservation, this.config);
        break;
      }
      try {
        await this.client.create(sandboxPod(reservation, this.config), signal);
        break;
      } catch (error) {
        if (!(error instanceof ApiError) || !error.quotaExceeded) {
          throw error;
        }
        if (attempt === 5) {
          await this.release(work, runtime);
          throw new Error("Kubernetes quota still exceeded after 5 attempts", {
            cause: error,
          });
        }
        await delay(1000, undefined, { signal });
      }
    }
    const deadline = Date.now() + this.config.readyTimeoutMs;
    while (Date.now() < deadline) {
      const pod = await this.client.pod(reservation.pod, signal);
      if (!pod) {
        throw new Error(
          `Kubernetes sandbox ${reservation.pod} disappeared before becoming ready`,
        );
      }
      assertIdentity(pod, reservation, this.config);
      const reason = failure(pod);
      if (reason) {
        throw new Error(
          `Kubernetes sandbox ${reservation.pod} failed: ${reason}`,
        );
      }
      if (
        pod.status.conditions.some(
          (condition) =>
            condition.type === "Ready" && condition.status === "True",
        )
      ) {
        return;
      }
      await delay(1000, undefined, { signal });
    }
    throw new Error(
      `Kubernetes sandbox ${reservation.pod} not ready before timeout`,
    );
  }

  async release(
    work: WorkInstance,
    runtime: WorkEnvironmentRuntime,
  ): Promise<void> {
    const state = await runtime.snapshot(Sandboxes, BACKGROUND_CONTEXT);
    if (!state) {
      return;
    }
    this.assertTarget(state.target);
    const reservation = state.reservations.find(
      (entry) => entry.workId === Number(work.workId),
    );
    if (!reservation) {
      return;
    }
    const pod = await this.client.pod(reservation.pod);
    if (pod) {
      assertIdentity(pod, reservation, this.config);
      await this.client.remove(reservation.pod);
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!(await this.client.pod(reservation.pod))) {
        await runtime.commit(async (tx) => {
          const saved = await tx.doc(Sandboxes);
          saved.reservations = saved.reservations.filter(
            (entry) => entry.pod !== reservation.pod,
          );
        }, BACKGROUND_CONTEXT);
        return;
      }
      await delay(250);
    }
    throw new Error(
      `Kubernetes sandbox ${reservation.pod} still terminating; capacity remains reserved`,
    );
  }

  async reconcile(
    live: readonly WorkInstance[],
    runtime: WorkEnvironmentRuntime,
  ): Promise<void> {
    const state = await runtime.snapshot(Sandboxes, BACKGROUND_CONTEXT);
    if (state) {
      this.assertTarget(state.target);
    }
    const active = new Set(live.map((work) => Number(work.workId)));
    // Recheck tasks to avoid deleting a newly admitted work missing from the caller's earlier scan.
    const unfinished = async (workId: number): Promise<boolean> => {
      if (active.has(workId)) {
        return true;
      }
      const task = await runtime.commit(
        (tx) => tx.task(parseTaskId(workId)),
        BACKGROUND_CONTEXT,
      );
      return task !== undefined && task.state.status !== "terminal";
    };
    for (const reservation of state?.reservations ?? []) {
      if (!(await unfinished(reservation.workId))) {
        await this.release(
          {
            workId: parseTaskId(reservation.workId),
            conversationId: parseConversationId(reservation.conversationId),
          },
          runtime,
        );
      }
    }
    for (const pod of await this.client.pods(
      `${SANDBOX_LABEL},${OWNER_LABEL}=${this.config.owner}`,
    )) {
      if (pod.metadata.labels[OWNER_LABEL] !== this.config.owner) {
        continue;
      }
      const workId = Number(pod.metadata.annotations["kaeno.io/work"]);
      if (
        Number.isSafeInteger(workId) &&
        workId > 0 &&
        (await unfinished(workId))
      ) {
        continue;
      }
      // Owner-scoped orphan sweep. Never touch another installation's pods.
      await this.client.remove(pod.metadata.name);
    }
  }

  async executionEnvironment(
    target: EnvTarget,
    context: Context,
  ): Promise<ExecutionEnv | undefined> {
    const state = await target.read.snapshot(Sandboxes, context);
    if (!state) {
      return undefined;
    }
    this.assertTarget(state.target);
    const reservation = state.reservations.find(
      (entry) => entry.conversationId === Number(target.conversationId),
    );
    if (!reservation || reservation.phase !== "held") {
      return undefined;
    }
    return this.createEnvironment({
      url: `http://${reservation.pod}.${this.config.service}.${this.config.namespace}.svc.cluster.local:7070`,
      token: reservation.token,
      id: `kubernetes:${this.config.namespace}/${reservation.pod}`,
      cwd: target.cwd ?? this.cwd,
    });
  }
}
