// Scheduled tasks: 5-field cron in a time zone. A firing is a durable Turn task created in the same commit that
// records the slot, so each slot fires once even across restarts; slots missed while kaeno was down are skipped.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Schedule } from "./config.ts";
import { thread, type ThreadDeps } from "./threads.ts";

const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const; // minute hour day-of-month month day-of-week

export type Cron = { fields: Set<number>[]; domStar: boolean; dowStar: boolean };

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron "${expr}" needs 5 fields`);
  const fields = parts.map((part, i) => {
    const [lo, hi] = RANGES[i]!;
    const set = new Set<number>();
    for (const item of part.split(",")) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
      if (!m) throw new Error(`cron "${expr}": bad field "${item}"`);
      const from = m[1] === "*" ? lo : Number(m[2]);
      const to = m[1] === "*" ? hi : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? hi : from;
      const step = m[4] !== undefined ? Number(m[4]) : 1;
      if (from < lo || to > hi || from > to || step < 1) throw new Error(`cron "${expr}": "${item}" out of range`);
      for (let v = from; v <= to; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    return set;
  });
  return { fields, domStar: parts[2] === "*", dowStar: parts[4] === "*" };
}

/** Wall-clock fields of `date` in `timeZone`. */
export function zoned(date: Date, timeZone: string) {
  const f = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short",
  }).formatToParts(date).map(p => [p.type, p.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(f.weekday!);
  return { year: +f.year!, month: +f.month!, day: +f.day!, hour: +f.hour!, minute: +f.minute!, weekday };
}

export function matches(cron: Cron, t: ReturnType<typeof zoned>) {
  const [min, hour, dom, mon, dow] = cron.fields as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (!min.has(t.minute) || !hour.has(t.hour) || !mon.has(t.month)) return false;
  // Standard cron: if both day fields are restricted, either may match.
  if (!cron.domStar && !cron.dowStar) return dom.has(t.day) || dow.has(t.weekday);
  return dom.has(t.day) && dow.has(t.weekday);
}

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
