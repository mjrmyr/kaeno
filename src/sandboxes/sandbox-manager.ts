import type { Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { setTimeout as delay } from "node:timers/promises";
import {
  ArtifactStore,
  collectArtifacts,
  POD_LOG_FILE,
  WORKSPACE_ROOT,
  type CaptureTransport,
  type RunHeader,
  type RunIdentity,
} from "../artifacts/index.ts";
import { parseTaskId } from "../durable/index.ts";
import type { SandboxImages, SkillCopySelection } from "../skills/index.ts";
import { failedReason, isReady, type Pod, type SandboxClient } from "./k8s.ts";
import { sandboxPod } from "./pod-spec.ts";
import { SandboxCapacity, type SandboxReservation } from "./sandbox-slots.ts";
export interface SandboxRuntime extends Pick<Harness, "getTask"> {}
export interface EnvironmentFactory {
  createEnvironment(pod: string, token: string, cwd: string): ExecutionEnv;
  /** One-shot env channel for out-of-band artifact collection at teardown. */
  createCaptureEnvironment(
    pod: string,
    token: string,
    cwd: string,
  ): CaptureTransport;
}
/** Where a teardown collection lands; identity comes from the caller that knows the run. */
export interface SandboxCapture {
  identity: RunIdentity;
  header: RunHeader;
}
export interface ManagedSandbox {
  pod: string;
  token: string;
  images: SandboxImages;
  skillCacheClaim: string;
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
  private readonly artifacts?: ArtifactStore;
  private readonly environments = new Map<string, ExecutionEnv>();
  constructor(
    harness: () => SandboxRuntime,
    client: SandboxClient,
    capacity: SandboxCapacity,
    environmentFactory: EnvironmentFactory,
    artifacts?: ArtifactStore,
  ) {
    this.harness = harness;
    this.client = client;
    this.capacity = capacity;
    this.environmentFactory = environmentFactory;
    this.artifacts = artifacts;
  }
  /** Idempotent: a restarted WORK re-acquires its own reservation and adopts its existing pod. */
  async ensureSandbox(launch: SandboxLaunch, ctx: Context): Promise<void> {
    const { sandbox } = launch;
    await this.capacity.acquireSandbox(launch.taskId, sandbox.pod, ctx);
    const spec = sandboxPod(
      {
        name: sandbox.pod,
        token: sandbox.token,
        images: sandbox.images,
        skillCacheClaim: sandbox.skillCacheClaim,
        skills: launch.selection,
        conversationId: launch.conversationId,
        taskId: String(launch.taskId),
        template: launch.template,
        resources: this.capacity.resources,
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
  /**
   * Derives capture identity from pod annotations/labels. Undefined when the pod
   * lacks the identity stamps (or is already gone) — no collection in that case.
   */
  private captureForPod(pod: Pod): SandboxCapture | undefined {
    const conversation = pod.metadata.annotations?.["kaeno.io/conversation"];
    const task = pod.metadata.annotations?.["kaeno.io/task"];
    const template = pod.metadata.labels?.["kaeno.io/template"];
    if (
      conversation === undefined ||
      task === undefined ||
      template === undefined ||
      !/^\d+$/.test(conversation) ||
      !/^\d+$/.test(task)
    ) {
      return undefined;
    }
    const workId = Number(task);
    return {
      identity: { workId, taskId: workId },
      header: {
        conversationId: Number(conversation),
        pod: pod.metadata.name,
        template,
      },
    };
  }
  /**
   * Best-effort evidence collection before the pod disappears. Records nothing when
   * the pod is gone or has no envd token; a capture-stream failure keeps the partial
   * evidence and the failure reason in the manifest. Never blocks pod deletion.
   */
  private async collectRunArtifacts(
    pod: string,
    capture: SandboxCapture,
  ): Promise<void> {
    const artifacts = this.artifacts;
    if (!artifacts) {
      return;
    }
    try {
      const spec = await this.client.getPod(pod);
      const token = spec
        ? spec.spec?.containers
            ?.flatMap((container) => container.env ?? [])
            .find((variable) => variable.name === "KAENO_ENV_TOKEN")?.value
        : undefined;
      if (!spec || token === undefined) {
        return;
      }
      const handle = await artifacts.createRun(
        capture.identity,
        capture.header,
      );
      const podLog = await this.client.getPodLog(pod).catch(() => undefined);
      if (podLog !== undefined) {
        await handle.write(POD_LOG_FILE, podLog);
      }
      const transport = this.environmentFactory.createCaptureEnvironment(
        pod,
        token,
        WORKSPACE_ROOT,
      );
      try {
        await collectArtifacts(transport, handle);
      } catch (error) {
        handle.markFailed(
          error instanceof Error ? error.message : String(error),
        );
      }
      await handle.finish();
    } catch {
      // Recovery: artifact collection must never block pod deletion or capacity release.
    }
  }
  async removeSandbox(pod: string, capture?: SandboxCapture): Promise<void> {
    const environment = this.environments.get(pod);
    this.environments.delete(pod);
    // Recovery: timeout/failure of env cleanup must not prevent durable capacity release and pod deletion.
    await environment
      ?.cleanup(withAbortSignal(AbortSignal.timeout(5000), BACKGROUND_CONTEXT))
      .catch(() => {});
    if (capture) {
      await this.collectRunArtifacts(pod, capture);
    }
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
        await this.removeSandbox(pod.metadata.name, this.captureForPod(pod));
      }
    }
  }
  listReservations(): Promise<SandboxReservation[]> {
    return this.capacity.listReservations();
  }
}
