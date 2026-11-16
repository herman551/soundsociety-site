import { describe, expect, it } from "vitest";
import { dingDong } from "../src/dingdong";
import { DEFAULT_DOORBELL, inQuietHours, newToken } from "../src/doorbell";

const LA = "America/Los_Angeles";

describe("quiet hours", () => {
  const quiet = (from: string | null, to: string | null, iso: string) =>
    inQuietHours({ ...DEFAULT_DOORBELL, quietFrom: from, quietTo: to }, Date.parse(iso), LA);

  it("run past midnight in the household's own time", () => {
    // 21:59, 22:00, 03:00, 06:59 and 07:00 in Los Angeles (UTC-8 in November).
    expect(quiet("22:00", "07:00", "2026-11-17T05:59:00Z")).toBe(false);
    expect(quiet("22:00", "07:00", "2026-11-17T06:00:00Z")).toBe(true);
    expect(quiet("22:00", "07:00", "2026-11-17T11:00:00Z")).toBe(true);
    expect(quiet("22:00", "07:00", "2026-11-17T14:59:00Z")).toBe(true);
    expect(quiet("22:00", "07:00", "2026-11-17T15:00:00Z")).toBe(false);
  });

  it("can sit inside one day, or be off", () => {
    expect(quiet("13:00", "15:00", "2026-11-17T22:00:00Z")).toBe(true); // 2 pm
    expect(quiet("13:00", "15:00", "2026-11-17T06:00:00Z")).toBe(false); // 10 pm
    expect(quiet(null, null, "2026-11-17T11:00:00Z")).toBe(false);
  });
});

describe("the doorbell's address", () => {
  it("gets a long, URL-safe secret that is new each time", () => {
    const a = newToken();
    expect(a).toMatch(/^[\w-]{32}$/);
    expect(newToken()).not.toBe(a);
  });
});

describe("the ding-dong", () => {
  const bytes = dingDong();
  const v = new DataView(bytes.buffer);
  const tag = (at: number) => String.fromCharCode(...bytes.slice(at, at + 4));
  const sample = (i: number) => v.getInt16(44 + i * 2, true) / 32767;
  const count = (bytes.length - 44) / 2;

  it("is a WAV Sonos can play: 16-bit mono PCM at 44.1 kHz, under three seconds", () => {
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(v.getUint32(4, true)).toBe(bytes.length - 8);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(44_100);
    expect(v.getUint16(34, true)).toBe(16);
    expect(count / 44_100).toBeCloseTo(2.6, 2);
  });

  it("starts and ends without a click, and never clips", () => {
    let peak = 0;
    for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(sample(i)));
    expect(peak).toBeCloseTo(0.85, 2);
    expect(Math.abs(sample(0))).toBeLessThan(0.01);
    expect(Math.abs(sample(count - 1))).toBeLessThan(0.01);
  });

  it("has two notes: the second strikes 0.6 seconds in", () => {
    const loudness = (fromSec: number) => {
      let sum = 0;
      for (let i = Math.round(fromSec * 44_100), n = 0; n < 2205; i++, n++) sum += sample(i) ** 2;
      return Math.sqrt(sum / 2205);
    };
    expect(loudness(0.62)).toBeGreaterThan(loudness(0.55) * 1.3);
  });
});
