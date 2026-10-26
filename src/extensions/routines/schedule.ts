import { z } from "zod";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
/** 1 = Monday … 7 = Sunday (ISO). */
const weekday = z.number().int().min(1).max(7);

export const scheduleSchema = z.union([
  z.object({ every: z.number().int().min(1).max(10_080) }).strict(),
  z
    .object({
      at: time,
      timeZone: z.string().refine(isTimeZone, "Unknown IANA time zone"),
      days: z.array(weekday).min(1).max(7).optional(),
    })
    .strict(),
]);
/** `every`: minutes. `at`: wall-clock time in `timeZone`, on `days` (default every day). */
export type Schedule = z.infer<typeof scheduleSchema>;

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of an instant in a zone. */
function wallClock(
  instant: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  function field(type: string): number {
    return Number(parts.find((part) => part.type === type)?.value);
  }
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
  };
}

function offsetAt(instant: number, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
  );
  return asUtc - Math.floor(instant / 60_000) * 60_000;
}

/**
 * The instant a wall-clock time occurs in a zone. A time skipped by a DST jump resolves to the
 * instant after the jump; a repeated time resolves to its first occurrence.
 */
function instantOf(
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // A zone's offset changes at most once around a given day: try the offsets before and after.
  const candidates = [
    wall - offsetAt(wall - 43_200_000, timeZone),
    wall - offsetAt(wall + 43_200_000, timeZone),
  ];
  const exact = candidates.filter((instant) => {
    const shown = wallClock(instant, timeZone);
    return shown.hour === hour && shown.minute === minute;
  });
  return exact.length > 0 ? Math.min(...exact) : Math.max(...candidates);
}

/**
 * The most recent due instant in (after, now], or undefined. Only the latest slot is returned, so
 * a host that was down fires one catch-up run, not one per missed slot.
 */
export function latestSlot(
  schedule: Schedule,
  after: number,
  now: number,
): number | undefined {
  if ("every" in schedule) {
    const period = schedule.every * 60_000;
    const slot = after + Math.floor((now - after) / period) * period;
    return slot > after ? slot : undefined;
  }
  const [hour, minute] = schedule.at.split(":").map(Number);
  const today = wallClock(now, schedule.timeZone);
  // Walk back over a week of local dates; the first due one is the latest.
  for (let back = 0; back <= 7; back++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day));
    date.setUTCDate(date.getUTCDate() - back);
    const isoDay = ((date.getUTCDay() + 6) % 7) + 1;
    if (schedule.days && !schedule.days.includes(isoDay)) {
      continue;
    }
    const slot = instantOf(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
      },
      hour,
      minute,
      schedule.timeZone,
    );
    if (slot <= now) {
      return slot > after ? slot : undefined;
    }
  }
  return undefined;
}

/** The next due instant after `now`, for display. */
export function nextSlot(
  schedule: Schedule,
  anchor: number,
  now: number,
): number | undefined {
  if ("every" in schedule) {
    const period = schedule.every * 60_000;
    return anchor + (Math.floor((now - anchor) / period) + 1) * period;
  }
  // The next slot is the latest one due within the coming eight days.
  for (let ahead = 1; ahead <= 8; ahead++) {
    const slot = latestSlot(schedule, now, now + ahead * 86_400_000);
    if (slot !== undefined) {
      return slot;
    }
  }
  return undefined;
}
