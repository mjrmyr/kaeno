import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  type Harness,
  type TaskId,
} from "@earendil-works/pi-durable";
import { setTimeout as delay } from "node:timers/promises";
import { parseTaskId, type Stored } from "../durable/index.ts";
import type { SandboxClient } from "./k8s.ts";
import {
  DEFAULT_SANDBOX_RESOURCES,
  fitSandboxes,
  SANDBOX_QUOTA,
  type SandboxFit,
  type SandboxResources,
} from "./resources.ts";
interface SlotState {
  waiting: {
    id: TaskId;
    pod: string;
  }[];
  held: Record<string, string>;
}
export interface CapacityRuntime extends Pick<
  Harness,
  "commit" | "snapshot" | "getTask"
> {}
export const SandboxSlots = defineDoc<Stored<SlotState>>({
  kind: "kaeno.sandbox-slots",
  version: 1,
  scope: "session",
  initial: () => ({ waiting: [], held: {} }),
});
export interface SandboxReservation {
  id: TaskId;
  pod: string;
}
export class SandboxCapacity {
  private readonly harness: () => CapacityRuntime;
  private readonly client: SandboxClient;
  /** The size of every sandbox this process creates; the pool size derives from it. */
  readonly resources: SandboxResources;
  constructor(
    harness: () => CapacityRuntime,
    client: SandboxClient,
    resources = DEFAULT_SANDBOX_RESOURCES,
  ) {
    this.harness = harness;
    this.client = client;
    this.resources = resources;
  }
  /** Read live on every grant attempt: quota edits apply without a restart. */
  async fitSandboxes(): Promise<SandboxFit> {
    return fitSandboxes(await this.client.readSandboxQuota(), this.resources);
  }
  async releaseSandbox(pod: string): Promise<boolean> {
    if (await this.client.getPod(pod)) {
      return false;
    }
    await this.harness().commit(async (tx) => {
      const slots = await tx.doc(SandboxSlots);
      slots.waiting = slots.waiting.filter(
        (reservation) => reservation.pod !== pod,
      );
      for (const [id, name] of Object.entries(slots.held)) {
        if (name === pod) {
          delete slots.held[id];
        }
      }
    }, BACKGROUND_CONTEXT);
    return true;
  }
  async listReservations(): Promise<SandboxReservation[]> {
    const snapshot = await this.harness().snapshot(
      SandboxSlots,
      BACKGROUND_CONTEXT,
    );
    return [
      ...(snapshot?.waiting ?? []),
      ...Object.entries(snapshot?.held ?? {}).map(([id, pod]) => ({
        id: parseTaskId(Number(id)),
        pod,
      })),
    ];
  }
  async reconcileReservations(): Promise<void> {
    for (const reservation of await this.listReservations()) {
      const task = await this.harness().getTask(
        reservation.id,
        BACKGROUND_CONTEXT,
      );
      if (!task || task.state.status === "terminal") {
        if (await this.client.getPod(reservation.pod)) {
          await this.client.deletePod(reservation.pod);
        }
        await this.releaseSandbox(reservation.pod);
      }
    }
  }
  async acquireSandbox(id: TaskId, pod: string, ctx: Context): Promise<void> {
    await this.harness().commit(async (tx) => {
      const slots = await tx.doc(SandboxSlots);
      if (
        !slots.held[String(id)] &&
        !slots.waiting.some((reservation) => reservation.id === id)
      ) {
        if (slots.waiting.length >= 128) {
          throw new Error(
            "Sandbox queue has 128 pending works; reduce fanout or retry later",
          );
        }
        slots.waiting.push({ id, pod });
      }
    }, ctx);
    for (;;) {
      await this.reconcileReservations();
      const { slots: capacity } = await this.fitSandboxes();
      if (capacity === 0) {
        throw new Error(
          `ResourceQuota ${SANDBOX_QUOTA} fits no sandbox of ${JSON.stringify(this.resources)}; raise the quota or lower sandboxResources in config.json`,
        );
      }
      const pods = await this.client.listSandboxPods();
      const granted = await this.harness().commit(async (tx) => {
        const slots = await tx.doc(SandboxSlots);
        if (slots.held[String(id)]) {
          return true;
        }
        const physical = pods.map((candidate) => candidate.metadata.name);
        const reserved = new Set(Object.values(slots.held));
        const foreign = physical.filter(
          (name) => name !== pod && !reserved.has(name),
        ).length;
        const [next] = slots.waiting;
        if (
          !physical.includes(pod) &&
          (next?.id !== id || reserved.size + foreign >= capacity)
        ) {
          return false;
        }
        slots.waiting = slots.waiting.filter(
          (reservation) => reservation.id !== id,
        );
        slots.held[String(id)] = pod;
        return true;
      }, ctx);
      if (granted) {
        return;
      }
      await delay(250, undefined, { signal: ctx.abortSignal });
    }
  }
}
