import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineExtension } from "@earendil-works/pi-durable";
import type { EnvTarget, ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { randomBytes, randomUUID } from "node:crypto";
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
import {
  assertWorkspace,
  workspaceClaim,
  workspaceSchema,
  type Workspace,
} from "./workspace.ts";

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
    workspace: workspaceSchema,
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
  workspaces?: Stored<Workspace>[];
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
  private readonly transitions = new Map<number, Promise<void>>();
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
      workspace: config.workspace,
      // Omitted when unset so identities saved before this option still match.
      ...(config.runtimeClassName === undefined
        ? {}
        : { runtimeClassName: config.runtimeClassName }),
    });
    this.identity = `kubernetes:${this.target}`;
  }

  /**
   * Saved reservations name pods under the target they were created with, so the target may
   * only change once no reservations or retained workspaces remain. The next
   * `ensure` then adopts the configured target.
   */
  private assertTarget(state: {
    target: string;
    reservations: readonly unknown[];
    workspaces?: readonly unknown[];
  }): void {
    if (
      state.target &&
      state.target !== this.target &&
      (state.reservations.length > 0 || (state.workspaces?.length ?? 0) > 0)
    ) {
      throw new Error(
        `Kubernetes saved cluster or sandbox configuration differs while sandbox reservations or workspaces remain; restore it until that work finishes`,
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

  private async inOrder(
    conversation: number,
    transition: () => Promise<void>,
  ): Promise<void> {
    const previous = this.transitions.get(conversation) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(transition);
    this.transitions.set(conversation, current);
    try {
      await current;
    } finally {
      if (this.transitions.get(conversation) === current) {
        this.transitions.delete(conversation);
      }
    }
  }

  ensure(
    work: WorkInstance,
    runtime: WorkEnvironmentRuntime,
    context: Context,
  ): Promise<void> {
    return this.inOrder(Number(work.conversationId), () =>
      this.ensureWork(work, runtime, context),
    );
  }

  private async ensureWork(
    work: WorkInstance,
    runtime: WorkEnvironmentRuntime,
    context: Context,
  ): Promise<void> {
    const prior = await runtime.snapshot(Sandboxes, context);
    if (prior) {
      this.assertTarget(prior);
    }
    for (const other of prior?.reservations ?? []) {
      if (
        other.conversationId !== Number(work.conversationId) ||
        other.workId === Number(work.workId)
      ) {
        continue;
      }
      const task = await runtime.commit(
        (tx) => tx.task(parseTaskId(other.workId)),
        context,
      );
      if (task && task.state.status !== "terminal") {
        throw new Error(
          "Kubernetes conversation already has an unfinished Assignment",
        );
      }
      await this.stopPod(
        {
          workId: parseTaskId(other.workId),
          conversationId: work.conversationId,
        },
        runtime,
      );
    }
    const reservation = await runtime.commit(async (tx) => {
      const state = await tx.doc(Sandboxes);
      this.assertTarget(state);
      state.target = this.target;
      state.workspaces ??= [];
      const workspaces = state.workspaces;
      let workspace = workspaces.find(
        (entry) => entry.conversationId === Number(work.conversationId),
      );
      if (!workspace) {
        workspace = {
          conversationId: Number(work.conversationId),
          claim: `${this.config.owner}-workspace-${work.conversationId}`,
          key: randomUUID(),
          uid: null,
          holder: Number(work.workId),
          retiring: false,
        };
        workspaces.push(workspace);
      }
      workspace.holder = Number(work.workId);
      workspace.retiring = false;
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
          claim: workspace.claim,
          ready: false,
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
      } else if (reservation.ready) {
        // Do not replay in-flight execution after pod loss. A PVC preserves files,
        // but does not make replay of commands safe.
        throw new Error(
          `Kubernetes sandbox ${reservation.pod} disappeared; execution cannot be restored automatically; workspace PVC is retained`,
        );
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
    await this.ensureWorkspace(work, runtime, context);
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
          await this.stopPod(work, runtime);
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
        await runtime.commit(async (tx) => {
          const state = await tx.doc(Sandboxes);
          const own = state.reservations.find(
            (entry) => entry.workId === Number(work.workId),
          );
          if (!own) {
            throw new Error(
              "Kubernetes reservation was released before readiness",
            );
          }
          own.ready = true;
        }, context);
        return;
      }
      await delay(1000, undefined, { signal });
    }
    throw new Error(
      `Kubernetes sandbox ${reservation.pod} not ready before timeout`,
    );
  }

  async check(
    work: WorkInstance,
    runtime: WorkEnvironmentRuntime,
    context: Context,
  ): Promise<string | undefined> {
    const state = await runtime.snapshot(Sandboxes, context);
    if (state) {
      this.assertTarget(state);
    }
    const reservation = state?.reservations.find(
      (entry) => entry.workId === Number(work.workId),
    );
    if (!reservation || reservation.phase !== "held") {
      return `Kubernetes sandbox reservation for work #${work.workId} is missing`;
    }
    const pod = await this.client.pod(reservation.pod, context.abortSignal);
    if (!pod) {
      return `Kubernetes sandbox ${reservation.pod} disappeared; execution cannot be restored automatically; workspace PVC is retained`;
    }
    assertIdentity(pod, reservation, this.config);
    const reason = failure(pod);
    return reason
      ? `Kubernetes sandbox ${reservation.pod} unavailable: ${reason}${pod.status.reason ? ` (${pod.status.reason})` : ""}`
      : undefined;
  }

  private async ensureWorkspace(
    work: WorkInstance,
    runtime: WorkEnvironmentRuntime,
    context: Context,
  ): Promise<void> {
    const state = await runtime.snapshot(Sandboxes, context);
    const workspace = state?.workspaces?.find(
      (entry) => entry.conversationId === Number(work.conversationId),
    );
    if (!workspace) {
      throw new Error("Kubernetes workspace reservation is missing");
    }
    let claim = await this.client.claim(workspace.claim, context.abortSignal);
    if (!claim) {
      if (workspace.uid !== null) {
        throw new Error(
          `Kubernetes workspace ${workspace.claim} disappeared; refusing to replace it with empty storage`,
        );
      }
      await this.client.createClaim(
        workspaceClaim(workspace, this.config),
        context.abortSignal,
      );
      claim = await this.client.claim(workspace.claim, context.abortSignal);
    }
    if (!claim) {
      throw new Error(
        `Kubernetes workspace ${workspace.claim} was not created`,
      );
    }
    assertWorkspace(claim, workspace, this.config);
    if (claim.metadata.deletionTimestamp || claim.status.phase === "Lost") {
      throw new Error(
        `Kubernetes workspace ${workspace.claim} is terminating or lost`,
      );
    }
    const uid = claim.metadata.uid;
    await runtime.commit(async (tx) => {
      const saved = await tx.doc(Sandboxes);
      const own = saved.workspaces?.find(
        (entry) => entry.key === workspace.key,
      );
      if (!own) {
        throw new Error("Kubernetes workspace was released during admission");
      }
      own.uid = uid;
    }, context);
    // Do not wait for Bound: WaitForFirstConsumer storage classes need the Pod first.
  }

  suspend(work: WorkInstance, runtime: WorkEnvironmentRuntime): Promise<void> {
    return this.inOrder(Number(work.conversationId), () =>
      this.stopPod(work, runtime),
    );
  }

  release(work: WorkInstance, runtime: WorkEnvironmentRuntime): Promise<void> {
    return this.inOrder(Number(work.conversationId), async () => {
      await this.stopPod(work, runtime);
      await this.removeWorkspace(work, runtime);
    });
  }

  private async removeWorkspace(
    work: WorkInstance,
    runtime: WorkEnvironmentRuntime,
  ): Promise<void> {
    const state = await runtime.snapshot(Sandboxes, BACKGROUND_CONTEXT);
    if (!state) {
      return;
    }
    this.assertTarget(state);
    const workspace = state.workspaces?.find(
      (entry) => entry.conversationId === Number(work.conversationId),
    );
    if (!workspace || workspace.holder !== Number(work.workId)) {
      return;
    }
    if (
      state.reservations.some(
        (entry) => entry.conversationId === workspace.conversationId,
      )
    ) {
      throw new Error(
        `Kubernetes workspace ${workspace.claim} still has a sandbox reservation`,
      );
    }
    const claim = await this.client.claim(workspace.claim);
    if (claim) {
      assertWorkspace(claim, workspace, this.config);
      await this.client.removeClaim(workspace.claim, claim.metadata.uid);
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!(await this.client.claim(workspace.claim))) {
        await runtime.commit(async (tx) => {
          const saved = await tx.doc(Sandboxes);
          saved.workspaces = (saved.workspaces ?? []).filter(
            (entry) => entry.key !== workspace.key,
          );
        }, BACKGROUND_CONTEXT);
        return;
      }
      await delay(250);
    }
    throw new Error(
      `Kubernetes workspace ${workspace.claim} still terminating; storage remains tracked`,
    );
  }

  private async stopPod(
    work: WorkInstance,
    runtime: WorkEnvironmentRuntime,
  ): Promise<void> {
    const state = await runtime.snapshot(Sandboxes, BACKGROUND_CONTEXT);
    if (!state) {
      return;
    }
    this.assertTarget(state);
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
    retained: readonly ConversationId[],
  ): Promise<void> {
    const state = await runtime.snapshot(Sandboxes, BACKGROUND_CONTEXT);
    if (state) {
      this.assertTarget(state);
    }
    const active = new Set(live.map((work) => Number(work.workId)));
    // Recheck tasks to avoid deleting a newly admitted work missing from the caller's earlier scan.
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
      state?.reservations.map((reservation) => reservation.pod),
    );
    for (const reservation of state?.reservations ?? []) {
      try {
        if (!(await unfinished(reservation.workId))) {
          await this.suspend(
            {
              workId: parseTaskId(reservation.workId),
              conversationId: parseConversationId(reservation.conversationId),
            },
            runtime,
          );
        }
      } catch (error) {
        errors.push(
          new Error(`Kubernetes cleanup failed for ${reservation.pod}`, {
            cause: error,
          }),
        );
      }
    }
    try {
      for (const pod of await this.client.pods(
        `${SANDBOX_LABEL},${OWNER_LABEL}=${this.config.owner}`,
      )) {
        // A failed release must not fall through to the orphan path and bypass
        // its reservation's identity check or deletion confirmation.
        if (
          reserved.has(pod.metadata.name) ||
          pod.metadata.labels[OWNER_LABEL] !== this.config.owner
        ) {
          continue;
        }
        try {
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
        } catch (error) {
          errors.push(
            new Error(
              `Kubernetes orphan cleanup failed for ${pod.metadata.name}`,
              {
                cause: error,
              },
            ),
          );
        }
      }
    } catch (error) {
      errors.push(error);
    }
    const keep = new Set(retained.map(Number));
    for (const workspace of state?.workspaces ?? []) {
      try {
        await this.inOrder(workspace.conversationId, async () => {
          const current = await runtime.snapshot(Sandboxes, BACKGROUND_CONTEXT);
          const own = current?.workspaces?.find(
            (entry) => entry.key === workspace.key,
          );
          if (!own) {
            return;
          }
          const retire =
            !keep.has(own.conversationId) && !(await unfinished(own.holder));
          // The caller collected retained conversations before our snapshot. A new
          // ticket can finish in that gap. Require two unretained observations,
          // and reset the mark whenever an Assignment acquires the workspace.
          if (
            !retire ||
            !workspace.retiring ||
            !own.retiring ||
            workspace.holder !== own.holder
          ) {
            if (own.retiring !== retire) {
              await runtime.commit(async (tx) => {
                const saved = await tx.doc(Sandboxes);
                const entry = saved.workspaces?.find(
                  (candidate) => candidate.key === own.key,
                );
                if (entry) {
                  entry.retiring = retire;
                }
              }, BACKGROUND_CONTEXT);
            }
            return;
          }
          await this.removeWorkspace(
            {
              workId: parseTaskId(own.holder),
              conversationId: parseConversationId(own.conversationId),
            },
            runtime,
          );
        });
      } catch (error) {
        errors.push(
          new Error(
            `Kubernetes workspace cleanup failed for ${workspace.claim}`,
            { cause: error },
          ),
        );
      }
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
