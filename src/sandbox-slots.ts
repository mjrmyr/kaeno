// Single durable owner of sandbox capacity. Reservations survive restarts and release only after pod removal.
import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type TaskId } from "@earendil-works/pi-durable";
import * as k8s from "./k8s.ts";

export const SandboxSlots = defineDoc<{ waiting: { id: TaskId; pod: string }[]; held: Record<string, string> }>({
  kind: "kaeno.sandbox-slots", version: 1, scope: "session", initial: () => ({ waiting: [], held: {} }),
});
export function sandboxSlots(harness: () => Harness, capacity = 4) {
  async function release(pod: string) {
    if (await k8s.getPod(pod)) return false;
    await harness().commit(async tx => {
      const slots = await tx.doc(SandboxSlots);
      slots.waiting = slots.waiting.filter(q => q.pod !== pod);
      for (const [id, name] of Object.entries(slots.held)) if (name === pod) delete slots.held[id];
    }, BACKGROUND_CONTEXT);
    return true;
  }
  async function reconcile() {
    const snapshot = await harness().snapshot(SandboxSlots, BACKGROUND_CONTEXT);
    for (const item of [...(snapshot?.waiting ?? []), ...Object.entries(snapshot?.held ?? {}).map(([id, pod]) => ({ id: Number(id) as TaskId, pod }))]) {
      const task = await harness().getTask(item.id, BACKGROUND_CONTEXT);
      if (!task || task.state.status === "terminal") {
        if (await k8s.getPod(item.pod)) await k8s.deletePod(item.pod);
        await release(item.pod);
      }
    }
  }
  async function acquire(id: TaskId, pod: string, context: Context) {
    await harness().commit(async tx => {
      const slots = await tx.doc(SandboxSlots);
      if (!slots.held[String(id)] && !slots.waiting.some(q => q.id === id)) {
        if (slots.waiting.length >= 128) throw new Error("Sandbox queue has 128 pending delegates; reduce fanout or retry later");
        slots.waiting.push({ id, pod });
      }
    }, context);
    for (;;) {
      await reconcile();
      const pods = await k8s.listSandboxPods();
      const granted = await harness().commit(async tx => {
        const slots = await tx.doc(SandboxSlots);
        if (slots.held[String(id)]) return true;
        const physical = pods.map(p => p.metadata.name as string);
        const reserved = new Set(Object.values(slots.held));
        const foreign = physical.filter(name => name !== pod && !reserved.has(name)).length;
        // Adopt a surviving legacy pod even at capacity. No new physical allocation occurs.
        if (!physical.includes(pod) && (slots.waiting[0]?.id !== id || reserved.size + foreign >= capacity)) return false;
        slots.waiting = slots.waiting.filter(q => q.id !== id); slots.held[String(id)] = pod; return true;
      }, context);
      if (granted) return;
      await delay(250, undefined, { signal: context.abortSignal });
    }
  }
  return { acquire, release, reconcile };
}
