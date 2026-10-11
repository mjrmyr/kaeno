// Pure cron parsing/matching. Config and build scripts must not import scheduler/harness/Kubernetes machinery.
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
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

/** Wall-clock fields of date in timeZone. */
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
  if (!cron.domStar && !cron.dowStar) return dom.has(t.day) || dow.has(t.weekday);
  return dom.has(t.day) && dow.has(t.weekday);
}
