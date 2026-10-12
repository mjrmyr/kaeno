import type { Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { setTimeout as delay } from "node:timers/promises";
import { parseTaskId } from "../durable/index.ts";
import type { SandboxImages, SkillCopySelection } from "../skills/index.ts";
import { failedReason, isReady, type SandboxClient } from "./k8s.ts";
import { sandboxPod } from "./pod-spec.ts";
import { SandboxCapacity, type SandboxReservation } from "./sandbox-slots.ts";
export interface SandboxRuntime extends Pick<Harness, "getTask"> {}
export interface EnvironmentFactory {
  createEnvironment(pod: string, token: string, cwd: string): ExecutionEnv;
}
export interface ManagedSandbox {
  pod: string;
  token: string;
  images?: SandboxImages;
  skillCacheClaim?: string;
}
export interface SandboxLaunch {
  sandbox: ManagedSandbox;
  selection: SkillCopySelection;
  conversationId: string;
  taskId: TaskId;
  template: string;
}
export class SandboxManager {
  private readonly harness: () => SandboxRuntime;
  private readonly client: SandboxClient;
  private readonly capacity: SandboxCapacity;
  private readonly environmentFactory: EnvironmentFactory;
  private readonly images: SandboxImages;
  private readonly skillCacheClaim: string;
  private readonly environments = new Map<string, ExecutionEnv>();
  constructor(
    harness: () => SandboxRuntime,
    client: SandboxClient,
    capacity: SandboxCapacity,
    environmentFactory: EnvironmentFactory,
    images: SandboxImages,
    skillCacheClaim: string,
  ) {
    this.harness = harness;
    this.client = client;
    this.capacity = capacity;
    this.environmentFactory = environmentFactory;
    this.images = images;
    this.skillCacheClaim = skillCacheClaim;
  }
  async ensureSandbox(
    launch: SandboxLaunch,
    saveImages: (images: SandboxImages) => Promise<void>,
    ctx: Context,
  ): Promise<void> {
    const { sandbox } = launch;
    await this.capacity.acquireSandbox(launch.taskId, sandbox.pod, ctx);
    let images = sandbox.images;
    if (!images) {
      const existing = await this.client.getPod(sandbox.pod);
      images = {
        execution:
          existing?.spec?.containers?.[0]?.image ?? this.images.execution,
      };
      await saveImages(images);
    }
    const spec = sandboxPod(
      {
        name: sandbox.pod,
        token: sandbox.token,
        images,
        skillCacheClaim: sandbox.skillCacheClaim ?? this.skillCacheClaim,
        skills: launch.selection,
        conversationId: launch.conversationId,
        taskId: String(launch.taskId),
        template: launch.template,
      },
      this.client.namespace,
    );
    for (;;) {
      try {
        await this.client.createPod(spec);
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("exceeded quota")
        ) {
          throw error;
        }
        await delay(1000, undefined, { signal: ctx.abortSignal });
      }
    }
    await this.waitForSandbox(sandbox.pod, ctx);
  }
  private async waitForSandbox(name: string, ctx: Context): Promise<void> {
    for (let attempt = 0; attempt < 240; attempt++) {
      ctx.abortSignal?.throwIfAborted();
      const pod = await this.client.getPod(name);
      if (isReady(pod)) {
        return;
      }
      const failed = failedReason(pod);
      if (failed) {
        throw new Error(`Sandbox ${name} failed to start: ${failed}`);
      }
      await delay(1000, undefined, { signal: ctx.abortSignal });
    }
    throw new Error(`Sandbox ${name} not ready after 4 minutes`);
  }
  getExecutionEnvironment(sandbox: ManagedSandbox, cwd: string): ExecutionEnv {
    const cached = this.environments.get(sandbox.pod);
    if (cached) {
      return cached;
    }
    const environment = this.environmentFactory.createEnvironment(
      sandbox.pod,
      sandbox.token,
      cwd,
    );
    this.environments.set(sandbox.pod, environment);
    return environment;
  }
  async removeSandbox(pod: string): Promise<void> {
    const environment = this.environments.get(pod);
    this.environments.delete(pod);
    // Recovery: timeout/failure of env cleanup must not prevent durable capacity release and pod deletion.
    await environment
      ?.cleanup(withAbortSignal(AbortSignal.timeout(5000), BACKGROUND_CONTEXT))
      .catch(() => {});
    await this.client.deletePod(pod);
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await this.capacity.releaseSandbox(pod)) {
        return;
      }
      await delay(250);
    }
    throw new Error(
      `Sandbox ${pod} is still terminating; capacity remains reserved`,
    );
  }
  async sweepOrphanedSandboxes(): Promise<void> {
    await this.capacity.reconcileReservations();
    for (const pod of await this.client.listSandboxPods()) {
      const annotated = pod.metadata.annotations?.["kaeno.io/task"];
      const taskId =
        annotated !== undefined && /^\d+$/.test(annotated)
          ? parseTaskId(Number(annotated))
          : undefined;
      const task = taskId
        ? await this.harness().getTask(taskId, BACKGROUND_CONTEXT)
        : undefined;
      if (!task || task.state.status === "terminal") {
        await this.removeSandbox(pod.metadata.name);
      }
    }
  }
  listReservations(): Promise<SandboxReservation[]> {
    return this.capacity.listReservations();
  }
}
