import { describe, expect, it } from "vitest";
import { addDays, localDate, nextDateFor, nextOccurrence, weekday, zonedToEpoch } from "../src/schedule";

const LA = "America/Los_Angeles";
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
const at = (s: string) => Date.parse(s);

describe("zonedToEpoch", () => {
  it("converts ordinary local times", () => {
    expect(iso(zonedToEpoch("2026-11-16", 6, 45, LA))).toBe("2026-11-16T14:45:00.000Z"); // PST, UTC-8
    expect(iso(zonedToEpoch("2026-07-01", 6, 45, LA))).toBe("2026-07-01T13:45:00.000Z"); // PDT, UTC-7
    expect(iso(zonedToEpoch("2026-07-01", 6, 45, "UTC"))).toBe("2026-07-01T06:45:00.000Z");
    expect(iso(zonedToEpoch("2026-07-01", 6, 45, "Asia/Kolkata"))).toBe("2026-07-01T01:15:00.000Z");
    expect(iso(zonedToEpoch("2026-01-01", 0, 0, "Pacific/Auckland"))).toBe("2025-12-31T11:00:00.000Z");
  });

  it("rings an hour later by the clock when the time is skipped in spring", () => {
    // 2026-03-08: 02:00 PST jumps to 03:00 PDT, so 02:30 never happens.
    expect(iso(zonedToEpoch("2026-03-08", 2, 30, LA))).toBe("2026-03-08T10:30:00.000Z"); // 03:30 PDT
    expect(iso(zonedToEpoch("2026-03-08", 1, 59, LA))).toBe("2026-03-08T09:59:00.000Z");
    expect(iso(zonedToEpoch("2026-03-08", 3, 0, LA))).toBe("2026-03-08T10:00:00.000Z");
    expect(iso(zonedToEpoch("2026-03-08", 7, 0, LA))).toBe("2026-03-08T14:00:00.000Z");
  });

  it("rings the first time when the time repeats in autumn", () => {
    // 2026-11-01: 02:00 PDT falls back to 01:00 PST, so 01:30 happens twice.
    expect(iso(zonedToEpoch("2026-11-01", 1, 30, LA))).toBe("2026-11-01T08:30:00.000Z"); // PDT
    expect(iso(zonedToEpoch("2026-11-01", 0, 30, LA))).toBe("2026-11-01T07:30:00.000Z");
    expect(iso(zonedToEpoch("2026-11-01", 2, 0, LA))).toBe("2026-11-01T10:00:00.000Z");
    expect(iso(zonedToEpoch("2026-11-01", 7, 0, LA))).toBe("2026-11-01T15:00:00.000Z");
  });
});

describe("date helpers", () => {
  it("knows the local date and weekday", () => {
    expect(localDate(at("2026-11-16T07:59:00Z"), LA)).toBe("2026-11-15");
    expect(localDate(at("2026-11-16T08:00:00Z"), LA)).toBe("2026-11-16");
    expect(weekday("2026-11-14")).toBe(6); // Saturday
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });
});

describe("nextOccurrence", () => {
  const weekdays = { time: "06:45", days: [1, 2, 3, 4, 5] };

  it("finds the next weekday, skipping the weekend", () => {
    // Friday 2026-11-13 at 07:00 local: today's 06:45 has gone, next is Monday.
    expect(iso(nextOccurrence(weekdays, at("2026-11-13T15:00:00Z"), LA))).toBe("2026-11-16T14:45:00.000Z");
    // Friday at 06:00 local: today's is still ahead.
    expect(iso(nextOccurrence(weekdays, at("2026-11-13T14:00:00Z"), LA))).toBe("2026-11-13T14:45:00.000Z");
  });

  it("is strictly after the given moment", () => {
    const t = at("2026-11-16T14:45:00Z");
    expect(iso(nextOccurrence(weekdays, t, LA))).toBe("2026-11-17T14:45:00.000Z");
    expect(iso(nextOccurrence(weekdays, t - 1, LA))).toBe("2026-11-16T14:45:00.000Z");
  });

  it("keeps the wall-clock time across a clock change", () => {
    const daily = { time: "07:00", days: [0, 1, 2, 3, 4, 5, 6] };
    expect(iso(nextOccurrence(daily, at("2026-03-07T15:00:00Z"), LA))).toBe("2026-03-08T14:00:00.000Z");
    expect(iso(nextOccurrence(daily, at("2026-10-31T14:00:00Z"), LA))).toBe("2026-11-01T15:00:00.000Z");
  });

  it("rings once on the day a time repeats", () => {
    const early = { time: "01:30", days: [0, 1, 2, 3, 4, 5, 6] };
    const first = nextOccurrence(early, at("2026-11-01T07:00:00Z"), LA)!;
    expect(iso(first)).toBe("2026-11-01T08:30:00.000Z");
    expect(iso(nextOccurrence(early, first, LA))).toBe("2026-11-02T09:30:00.000Z");
  });

  it("skips one date when asked", () => {
    const s = { ...weekdays, skipDate: "2026-11-16" };
    expect(iso(nextOccurrence(s, at("2026-11-13T15:00:00Z"), LA))).toBe("2026-11-17T14:45:00.000Z");
  });

  it("stays quiet through a vacation, both ends included", () => {
    const away = [{ id: "v", from: "2026-11-16", to: "2026-11-20" }];
    expect(iso(nextOccurrence(weekdays, at("2026-11-13T15:00:00Z"), LA, away))).toBe("2026-11-23T14:45:00.000Z");
  });

  it("handles one-time alarms", () => {
    const once = { time: "05:00", days: [], onDate: "2026-11-18" };
    expect(iso(nextOccurrence(once, at("2026-11-14T00:00:00Z"), LA))).toBe("2026-11-18T13:00:00.000Z");
    expect(nextOccurrence(once, at("2026-11-18T13:00:00Z"), LA)).toBeNull();
    // A one-time alarm rings even during a vacation: it was set on purpose.
    const away = [{ id: "v", from: "2026-11-16", to: "2026-11-20" }];
    expect(iso(nextOccurrence(once, at("2026-11-14T00:00:00Z"), LA, away))).toBe("2026-11-18T13:00:00.000Z");
    expect(nextOccurrence({ ...once, skipDate: "2026-11-18" }, at("2026-11-14T00:00:00Z"), LA)).toBeNull();
    expect(nextOccurrence({ time: "05:00", days: [] }, 0, LA)).toBeNull();
  });

  it("returns null when every day is ruled out", () => {
    const forever = [{ id: "v", from: "2026-01-01", to: "2030-01-01" }];
    expect(nextOccurrence(weekdays, at("2026-11-13T15:00:00Z"), LA, forever)).toBeNull();
    expect(nextOccurrence({ time: "25:00", days: [1] }, 0, LA)).toBeNull();
  });
});

describe("nextDateFor", () => {
  it("picks today if the time is still ahead, otherwise tomorrow", () => {
    const now = at("2026-11-14T16:00:00Z"); // 08:00 Saturday in LA
    expect(nextDateFor("09:00", now, LA)).toBe("2026-11-14");
    expect(nextDateFor("07:00", now, LA)).toBe("2026-11-15");
    expect(nextDateFor("08:00", now, LA)).toBe("2026-11-15");
  });
});
