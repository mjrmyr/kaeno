import { expect, it } from "vitest";
import { latestSlot, nextSlot } from "./index.ts";

const minute = 60_000;
const t0 = Date.UTC(2026, 9, 26, 12, 0);

it("interval slots are anchored at the last change and fire only the latest after downtime", () => {
  const schedule = { every: 15 };
  expect(latestSlot(schedule, t0, t0 + 14 * minute)).toBeUndefined();
  expect(latestSlot(schedule, t0, t0 + 15 * minute)).toBe(t0 + 15 * minute);
  // Down for 3 hours: one catch-up slot, not twelve.
  expect(latestSlot(schedule, t0, t0 + 3 * 60 * minute + 7 * minute)).toBe(
    t0 + 180 * minute,
  );
  expect(nextSlot(schedule, t0, t0 + 20 * minute)).toBe(t0 + 30 * minute);
});

it("daily slots use wall-clock time in the zone, after the given instant only", () => {
  const schedule = { at: "08:00", timeZone: "Europe/Berlin" };
  // 26 Oct 2026 is winter time in Berlin (UTC+1): 08:00 local is 07:00 UTC.
  const slot = Date.UTC(2026, 9, 26, 7, 0);
  expect(latestSlot(schedule, t0 - 86_400_000, t0)).toBe(slot);
  expect(latestSlot(schedule, slot, t0)).toBeUndefined();
  expect(nextSlot(schedule, slot, t0)).toBe(slot + 86_400_000);
});

it("daily slots stay at local time across a daylight-saving change", () => {
  const schedule = { at: "08:00", timeZone: "Europe/Berlin" };
  // Summer time ends on 25 Oct 2026: 08:00 is 06:00 UTC on the 24th, 07:00 UTC on the 25th.
  expect(latestSlot(schedule, 0, Date.UTC(2026, 9, 24, 12, 0))).toBe(
    Date.UTC(2026, 9, 24, 6, 0),
  );
  expect(latestSlot(schedule, 0, Date.UTC(2026, 9, 25, 12, 0))).toBe(
    Date.UTC(2026, 9, 25, 7, 0),
  );
  // 02:30 does not exist on 29 Mar 2026 (clocks jump 02:00 → 03:00); it runs right after the jump.
  expect(
    latestSlot(
      { at: "02:30", timeZone: "Europe/Berlin" },
      Date.UTC(2026, 2, 28, 12, 0),
      Date.UTC(2026, 2, 29, 12, 0),
    ),
  ).toBe(Date.UTC(2026, 2, 29, 1, 30));
  // 02:30 happens twice on 25 Oct 2026 (03:00 → 02:00); it runs at the first one, in summer time.
  expect(
    latestSlot(
      { at: "02:30", timeZone: "Europe/Berlin" },
      Date.UTC(2026, 9, 24, 12, 0),
      Date.UTC(2026, 9, 25, 12, 0),
    ),
  ).toBe(Date.UTC(2026, 9, 25, 0, 30));
});

it("daily slots skip days that are not selected", () => {
  // 26 Oct 2026 is a Monday; Saturday and Sunday only.
  const schedule = { at: "08:00", timeZone: "UTC", days: [6, 7] };
  expect(latestSlot(schedule, 0, t0)).toBe(Date.UTC(2026, 9, 25, 8, 0));
  expect(nextSlot(schedule, 0, t0)).toBe(Date.UTC(2026, 9, 31, 8, 0));
});
