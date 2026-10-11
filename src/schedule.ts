// Scheduled tasks: 5-field cron in a time zone. A firing is a durable Turn task created in the same commit that
// records the slot, so each slot fires once even across restarts; slots missed while kaeno was down are skipped.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Schedule } from "./config.ts";
import { thread, type ThreadDeps } from "./threads.ts";

import { matches, parseCron, zoned } from "./cron.ts";

const slotOf = (t: ReturnType<typeof zoned>) =>
  `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}T${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;

export const ScheduleState = defineDoc<{ last: Record<string, string> }>({
  kind: "kaeno.schedules", version: 1, scope: "session", initial: () => ({ last: {} }),
});

export async function tick(deps: ThreadDeps & { schedules: Schedule[]; Turn: any }, now = new Date()) {
  for (const schedule of deps.schedules) {
    const t = zoned(now, schedule.timezone);
    if (!matches(parseCron(schedule.cron), t)) continue;
    const slot = slotOf(t);
    const conversationId = await thread(deps, schedule.thread);
    await deps.harness().commit(async tx => {
      const state = await tx.doc(ScheduleState);
      if (state.last[schedule.name] === slot) return;
      state.last[schedule.name] = slot;
      await tx.createTask(deps.Turn, {
        conversationId, content: `[scheduled task "${schedule.name}" at ${slot} ${schedule.timezone}]\n${schedule.prompt}`,
        requestId: `schedule:${schedule.name}:${slot}`, notify: schedule.notify,
      }, { ownership: { kind: "conversation" }, conversationId, background: true });
      console.log(`schedule: fired ${schedule.name} for ${slot}`);
    }, BACKGROUND_CONTEXT);
  }
}

export function startScheduler(deps: Parameters<typeof tick>[0], signal: AbortSignal) {
  if (!deps.schedules.length) return;
  const timer = setInterval(() => void tick(deps).catch(e => console.error("schedule:", e)), 20_000);
  signal.addEventListener("abort", () => clearInterval(timer));
  void tick(deps).catch(e => console.error("schedule:", e));
}
export type { Harness };
