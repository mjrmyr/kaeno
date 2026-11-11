import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineExtension } from "@earendil-works/pi-durable";
import type { ConversationId, EnvTarget } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  parseTaskId,
  type KaenoExtension,
  type Stored,
  type WorkEnvironment,
  type WorkEnvironmentRuntime,
  type WorkInstance,
} from "../../core/application/index.ts";
import { condition, failure, KubernetesClient } from "./client.ts";
import {
  assertIdentity,
  CONVERSATION_ANNOTATION,
  OWNER_LABEL,
  SANDBOX_LABEL,
  sandboxManifest,
  type Reservation,
} from "./sandbox.ts";
import { capacity, resourcesSchema } from "./resources.ts";

const dnsName = z
  .string()
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const workspaceSchema = z
  .object({
    size: z
      .string()
      .regex(/^[1-9]\d*(?:Mi|Gi|Ti)$/)
      .default("5Gi"),
    storageClassName: z
      .string()
      .max(253)
      .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
      .optional(),
  })
  .strict()
  .default({ size: "5Gi" });
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
    workspace: workspaceSchema,
    quota: dnsName.default("kaeno-sandbox"),
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
  version: 2,
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
  private readonly transitions = new Map<number, Promise<unknown>>();
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
      workspace: config.workspace,
      quota: config.quota,
      serviceAccount: config.serviceAccount,
      ...(config.runtimeClassName === undefined
        ? {}
        : { runtimeClassName: config.runtimeClassName }),
    });
    this.identity = `kubernetes:${this.target}`;
  }

  /**
   * Saved reservations name sandboxes under the target they were created with, so the target may
   * only change once none remain. With an empty queue nothing is tracked, and the next
   * `ensure` adopts the configured target.
   */
  private assertTarget(state: {
    target: string;
    reservations: readonly unknown[];
  }): void {
    if (
      state.target &&
      state.target !== this.target &&
      state.reservations.length > 0
    ) {
      throw new Error(
        `Kubernetes saved cluster or sandbox configuration differs while ${state.reservations.length} sandbox reservation(s) remain; restore it until that work finishes`,
      );
    }
  }

  private inOrder<T>(
    conversation: number,
    transition: () => Promise<T>,
  ): Promise<T> {
    const previous = this.transitions.get(conversation) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(transition);
    this.transitions.set(conversation, current);
    return current.finally(() => {
      if (this.transitions.get(conversation) === current) {
        this.transitions.delete(conversation);
      }
    });
  }

  private async reservation(
    conversation: number,
    runtime: WorkEnvironmentRuntime,
  ): Promise<Stored<Reservation> | undefined> {
    const state = await runtime.snapshot(Sandboxes, BACKGROUND_CONTEXT);
    if (!state) {
      return undefined;
    }
    this.assertTarget(state);
    return state.reservations.find(
      (entry) => entry.conversationId === conversation,
    );
  }

  private async update(
    sandbox: string,
    runtime: WorkEnvironmentRuntime,
    change: (entry: Stored<Reservation>) => void,
  ): Promise<void> {
    await runtime.commit(async (tx) => {
      const state = await tx.doc(Sandboxes);
      const entry = state.reservations.find((item) => item.sandbox === sandbox);
      if (entry) {
        change(entry);
      }
    }, BACKGROUND_CONTEXT);
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

  ensure(
    work: WorkInstance,
    runtime: WorkEnvironmentRuntime,
    context: Context,
  ): Promise<void> {
    return this.inOrder(Number(work.conversationId), () =>
      this.admit(work, runtime, context),
    );
  }

  private async admit(
    work: WorkInstance,
    runtime: WorkEnvironmentRuntime,
    context: Context,
  ): Promise<void> {
    const reservation = await runtime.commit(async (tx) => {
      const state = await tx.doc(Sandboxes);
      this.assertTarget(state);
      state.target = this.target;
      const index = state.reservations.findIndex(
        (entry) => entry.conversationId === Number(work.conversationId),
      );
      let saved = index === -1 ? undefined : state.reservations[index];
      if (saved?.phase === "suspended") {
        saved = { ...saved, phase: "waiting", fqdn: null };
        state.reservations.splice(index, 1);
        state.reservations.push(saved);
      }
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
          conversationId: Number(work.conversationId),
          holder: Number(work.workId),
          sandbox: `${this.config.owner}-conv-${work.conversationId}`,
          token: randomBytes(32).toString("hex"),
          image: this.config.image,
          phase: "waiting",
          admitted: false,
          fqdn: null,
        };
        state.reservations.push(saved);
      }
      saved.holder = Number(work.workId);
      return { ...saved };
    }, context);
    const name = reservation.sandbox;
    const signal = context.abortSignal;
    let existing;
    for (;;) {
      signal?.throwIfAborted();
      const slots = await this.capacity(context);
      const pods = await this.client.pods(SANDBOX_LABEL, signal);
      existing = await this.client.sandbox(name, signal);
      if (existing) {
        assertIdentity(existing, reservation, this.config);
      } else if (reservation.admitted) {
        // An admitted sandbox may hold work. Never silently replace its volume after loss.
        throw new Error(
          `Kubernetes sandbox ${name} disappeared; its workspace cannot be restored`,
        );
      }
      const granted = await runtime.commit(async (tx) => {
        const state = await tx.doc(Sandboxes);
        const own = state.reservations.find((entry) => entry.sandbox === name);
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
            .map((entry) => entry.sandbox),
        );
        const foreign = pods.filter(
          (pod) => !held.has(pod.metadata.name) && pod.metadata.name !== name,
        ).length;
        const next = state.reservations.find(
          (entry) => entry.phase === "waiting",
        );
        const running = pods.some((pod) => pod.metadata.name === name);
        if (
          !running &&
          (next?.sandbox !== name || held.size + foreign >= slots)
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
    if (!existing) {
      await this.client.createSandbox(
        sandboxManifest(reservation, this.config),
        signal,
      );
    } else if (existing.spec.operatingMode !== "Running") {
      await this.client.operate(name, "Running", signal);
    }
    await this.update(name, runtime, (entry) => {
      entry.admitted = true;
    });
    const deadline = Date.now() + this.config.readyTimeoutMs;
    let pending = "";
    while (Date.now() < deadline) {
      const sandbox = await this.client.sandbox(name, signal);
      if (!sandbox) {
        throw new Error(
          `Kubernetes sandbox ${name} disappeared before becoming ready`,
        );
      }
      assertIdentity(sandbox, reservation, this.config);
      const pod = await this.client.pod(name, signal);
      const reason = pod && failure(pod);
      if (reason) {
        throw new Error(`Kubernetes sandbox ${name} failed: ${reason}`);
      }
      const ready = condition(sandbox, "Ready");
      if (ready?.status === "True" && sandbox.status.serviceFQDN) {
        const fqdn = sandbox.status.serviceFQDN;
        await this.update(name, runtime, (entry) => {
          entry.fqdn = fqdn;
        });
        return;
      }
      pending = ready?.reason
        ? ` (${ready.reason}${ready.message ? `: ${ready.message}` : ""})`
        : "";
      await delay(1000, undefined, { signal });
    }
    throw new Error(
      `Kubernetes sandbox ${name} not ready before timeout${pending}`,
    );
  }

  async check(
    work: WorkInstance,
    runtime: WorkEnvironmentRuntime,
    context: Context,
  ): Promise<string | undefined> {
    const reservation = await this.reservation(
      Number(work.conversationId),
      runtime,
    );
    if (!reservation || reservation.phase !== "held") {
      return `Kubernetes sandbox reservation for work #${work.workId} is missing`;
    }
    const signal = context.abortSignal;
    const sandbox = await this.client.sandbox(reservation.sandbox, signal);
    if (!sandbox) {
      return `Kubernetes sandbox ${reservation.sandbox} disappeared; its workspace cannot be restored`;
    }
    assertIdentity(sandbox, reservation, this.config);
    const pod = await this.client.pod(reservation.sandbox, signal);
    if (!pod) {
      return `Kubernetes sandbox ${reservation.sandbox} unavailable: pod missing`;
    }
    const reason = failure(pod);
    return reason
      ? `Kubernetes sandbox ${reservation.sandbox} unavailable: ${reason}${pod.status.reason ? ` (${pod.status.reason})` : ""}`
      : undefined;
  }

  suspend(work: WorkInstance, runtime: WorkEnvironmentRuntime): Promise<void> {
    return this.inOrder(Number(work.conversationId), async () => {
      const reservation = await this.reservation(
        Number(work.conversationId),
        runtime,
      );
      if (
        reservation &&
        reservation.holder === Number(work.workId) &&
        reservation.phase !== "suspended"
      ) {
        await this.park(reservation, runtime);
      }
    });
  }

  private async park(
    reservation: Stored<Reservation>,
    runtime: WorkEnvironmentRuntime,
  ): Promise<void> {
    const name = reservation.sandbox;
    const sandbox = await this.client.sandbox(name);
    if (!sandbox && !reservation.admitted) {
      await runtime.commit(async (tx) => {
        const state = await tx.doc(Sandboxes);
        state.reservations = state.reservations.filter(
          (entry) => entry.sandbox !== name,
        );
      }, BACKGROUND_CONTEXT);
      return;
    }
    if (sandbox) {
      assertIdentity(sandbox, reservation, this.config);
      if (sandbox.spec.operatingMode !== "Suspended") {
        await this.client.operate(name, "Suspended");
      }
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!(await this.client.pod(name))) {
        await this.update(name, runtime, (entry) => {
          entry.phase = "suspended";
          entry.fqdn = null;
        });
        return;
      }
      await delay(250);
    }
    throw new Error(
      `Kubernetes sandbox ${name} still stopping; capacity remains reserved`,
    );
  }

  release(work: WorkInstance, runtime: WorkEnvironmentRuntime): Promise<void> {
    return this.inOrder(Number(work.conversationId), async () => {
      const reservation = await this.reservation(
        Number(work.conversationId),
        runtime,
      );
      if (reservation) {
        await this.discard(reservation, runtime);
      }
    });
  }

  private async discard(
    reservation: Stored<Reservation>,
    runtime: WorkEnvironmentRuntime,
  ): Promise<void> {
    const name = reservation.sandbox;
    const sandbox = await this.client.sandbox(name);
    if (sandbox) {
      assertIdentity(sandbox, reservation, this.config);
      await this.client.removeSandbox(name);
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      if (
        !(await this.client.sandbox(name)) &&
        !(await this.client.pod(name))
      ) {
        await runtime.commit(async (tx) => {
          const state = await tx.doc(Sandboxes);
          state.reservations = state.reservations.filter(
            (entry) => entry.sandbox !== name,
          );
        }, BACKGROUND_CONTEXT);
        return;
      }
      await delay(250);
    }
    throw new Error(
      `Kubernetes sandbox ${name} still terminating; capacity remains reserved`,
    );
  }

  async reconcile(
    live: readonly WorkInstance[],
    runtime: WorkEnvironmentRuntime,
    retained: readonly ConversationId[],
  ): Promise<void> {
    const state = await runtime.snapshot(Sandboxes, BACKGROUND_CONTEXT);
    if (state) {
      this.assertTarget(state);
    }
    const active = new Set(live.map((work) => Number(work.workId)));
    const kept = new Set([
      ...live.map((work) => Number(work.conversationId)),
      ...retained.map(Number),
    ]);
    // Recheck tasks to avoid stopping a newly admitted work missing from the caller's earlier scan.
    async function unfinished(workId: number): Promise<boolean> {
      if (active.has(workId)) {
        return true;
      }
      const task = await runtime.commit(
        (tx) => tx.task(parseTaskId(workId)),
        BACKGROUND_CONTEXT,
      );
      return task !== undefined && task.state.status !== "terminal";
    }
    const errors: unknown[] = [];
    const reserved = new Set(
      state?.reservations.map((reservation) => reservation.sandbox),
    );
    for (const { conversationId, sandbox } of state?.reservations ?? []) {
      try {
        await this.inOrder(conversationId, async () => {
          const current = await this.reservation(conversationId, runtime);
          if (!current || (await unfinished(current.holder))) {
            return;
          }
          if (!kept.has(conversationId)) {
            await this.discard(current, runtime);
          } else if (current.phase !== "suspended") {
            await this.park(current, runtime);
          }
        });
      } catch (error) {
        errors.push(
          new Error(`Kubernetes cleanup failed for ${sandbox}`, {
            cause: error,
          }),
        );
      }
    }
    try {
      for (const sandbox of await this.client.sandboxes(
        `${SANDBOX_LABEL},${OWNER_LABEL}=${this.config.owner}`,
      )) {
        // A failed release must not fall through to the orphan path and bypass
        // its reservation's identity check or deletion confirmation.
        if (
          reserved.has(sandbox.metadata.name) ||
          sandbox.metadata.labels[OWNER_LABEL] !== this.config.owner ||
          kept.has(
            Number(sandbox.metadata.annotations[CONVERSATION_ANNOTATION]),
          )
        ) {
          continue;
        }
        try {
          // Owner-scoped orphan sweep. Never touch another installation's sandboxes.
          await this.client.removeSandbox(sandbox.metadata.name);
        } catch (error) {
          errors.push(
            new Error(
              `Kubernetes orphan cleanup failed for ${sandbox.metadata.name}`,
              { cause: error },
            ),
          );
        }
      }
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Kubernetes sandbox reconciliation failed",
      );
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
    this.assertTarget(state);
    const reservation = state.reservations.find(
      (entry) => entry.conversationId === Number(target.conversationId),
    );
    if (!reservation || reservation.phase !== "held" || !reservation.fqdn) {
      return undefined;
    }
    return this.createEnvironment({
      url: `http://${reservation.fqdn}:7070`,
      token: reservation.token,
      id: `kubernetes:${this.config.namespace}/${reservation.sandbox}`,
      cwd: target.cwd ?? this.cwd,
    });
  }
}
