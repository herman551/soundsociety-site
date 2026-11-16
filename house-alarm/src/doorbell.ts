// The doorbell. UniFi Protect (or anything else that can call a web address)
// tells House Alarm that someone rang, and the speakers play a short sound over
// whatever they are doing. Sonos plays it as an audio clip: the music dips for
// it and comes back by itself, so nothing is regrouped and nothing has to be
// put back afterwards.
//
// This file holds the settings and the small decisions. engine.ts does the
// ringing, because it knows the speakers and keeps the activity log.

import { offsetMs } from "./schedule";

export type DoorbellSound = "dingdong" | "chime" | "url";
export const DOORBELL_SOUNDS: DoorbellSound[] = ["dingdong", "chime", "url"];

export interface DoorbellSettings {
  enabled: boolean;
  /** The secret in the address the doorbell calls. Made the first time the doorbell is switched on. */
  token: string | null;
  playerIds: string[];
  /** 1–100, before each speaker's alarm level. */
  volume: number;
  sound: DoorbellSound;
  /** For `sound: "url"`: an MP3 or WAV file Sonos can fetch. */
  soundUrl: string | null;
  /** Quiet hours as HH:MM in the household's time zone. None while either is null. */
  quietFrom: string | null;
  quietTo: string | null;
  /** The volume during quiet hours. 0 keeps the speakers silent. */
  quietVolume: number;
}

export const DEFAULT_DOORBELL: DoorbellSettings = {
  enabled: false,
  token: null,
  playerIds: [],
  volume: 35,
  sound: "dingdong",
  soundUrl: null,
  quietFrom: null,
  quietTo: null,
  quietVolume: 0,
};

/** One ring, as the doorbell's own short history shows it. */
export interface Ring {
  at: number;
  level: "info" | "warn" | "error";
  text: string;
}

/** Rings closer together than this are one visitor pressing twice, and ring once. */
export const RING_GAP_MS = 5_000;
export const RING_LIMIT = 12;

/** Where the Worker serves the ding-dong, for Sonos to fetch. */
export const DINGDONG_PATH = "/sounds/ding-dong.wav";

/** A fresh secret for the doorbell's address: 24 random bytes, URL-safe. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Whether `now` falls in the doorbell's quiet hours. They may run past midnight. */
export function inQuietHours(d: DoorbellSettings, now: number, tz: string): boolean {
  const { quietFrom: from, quietTo: to } = d;
  if (!from || !to || from === to) return false;
  const hhmm = new Date(now + offsetMs(now, tz)).toISOString().slice(11, 16);
  return from < to ? hhmm >= from && hhmm < to : hhmm >= from || hhmm < to;
}
