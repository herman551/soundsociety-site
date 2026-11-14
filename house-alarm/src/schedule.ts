// Time-zone-aware scheduling. Everything here is pure: given an alarm, a
// moment and a zone, work out when the alarm next rings.

export interface Vacation {
  id: string;
  /** First and last local dates (YYYY-MM-DD) with no repeating alarms, inclusive. */
  from: string;
  to: string;
  label?: string;
}

export interface Schedule {
  /** Local wall-clock time, "HH:MM" in 24-hour form. */
  time: string;
  /** 0 = Sunday … 6 = Saturday. Empty means a one-time alarm on `onDate`. */
  days: number[];
  /** Local date a one-time alarm rings on. */
  onDate?: string;
  /** Local date whose occurrence is skipped ("skip the next one"). */
  skipDate?: string;
}

const HOUR = 3_600_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function isClockTime(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** The wall-clock reading in `tz` at instant `t`, as if it were a UTC timestamp. */
function wallAsUtc(t: number, tz: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(t))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}

/** Zone offset at instant `t` in milliseconds (local minus UTC). */
export function offsetMs(t: number, tz: string): number {
  return wallAsUtc(t, tz) - Math.floor(t / 1000) * 1000;
}

/** Local calendar date (YYYY-MM-DD) in `tz` at instant `t`. */
export function localDate(t: number, tz: string): string {
  return new Date(wallAsUtc(t, tz)).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The instant at which clocks in `tz` read `date` `hh:mm`.
 *
 * Two days a year that question has no clean answer. When clocks spring
 * forward the time may not exist: we ring an hour later by the clock, which is
 * the same instant the old offset would have given. When clocks fall back the
 * time happens twice: we ring the first time only.
 */
export function zonedToEpoch(date: string, hh: number, mm: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // The real instant is within 14 hours of `wall`, so offsets sampled 36 hours
  // either side bracket any clock change that could affect it.
  const before = offsetMs(wall - 36 * HOUR, tz);
  const after = offsetMs(wall + 36 * HOUR, tz);
  if (before === after) return wall - before;
  const a = wall - before;
  const b = wall - after;
  const aOk = offsetMs(a, tz) === before;
  const bOk = offsetMs(b, tz) === after;
  if (aOk && bOk) return Math.min(a, b);
  if (aOk) return a;
  if (bOk) return b;
  return a;
}

function onVacation(date: string, vacations: Vacation[]): boolean {
  return vacations.some((v) => date >= v.from && date <= v.to);
}

/**
 * The first instant strictly after `after` at which the alarm rings, or null
 * if it never will. Repeating alarms stay quiet during vacations; a one-time
 * alarm was set for a specific day on purpose, so it rings regardless.
 */
export function nextOccurrence(s: Schedule, after: number, tz: string, vacations: Vacation[] = []): number | null {
  if (!isClockTime(s.time)) return null;
  const [hh, mm] = s.time.split(":").map(Number) as [number, number];

  if (s.days.length === 0) {
    if (!s.onDate || s.onDate === s.skipDate) return null;
    const t = zonedToEpoch(s.onDate, hh, mm, tz);
    return t > after ? t : null;
  }

  let date = localDate(after, tz);
  // A little over two years: long enough to see past any vacation worth the name.
  for (let i = 0; i < 800; i++, date = addDays(date, 1)) {
    if (!s.days.includes(weekday(date))) continue;
    if (date === s.skipDate || onVacation(date, vacations)) continue;
    const t = zonedToEpoch(date, hh, mm, tz);
    if (t > after) return t;
  }
  return null;
}

/** The local date a new one-time alarm should ring on: today if the time is still ahead, else tomorrow. */
export function nextDateFor(time: string, now: number, tz: string): string {
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const today = localDate(now, tz);
  return zonedToEpoch(today, hh, mm, tz) > now ? today : addDays(today, 1);
}
