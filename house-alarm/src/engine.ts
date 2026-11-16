// The alarm clock itself: what is set, what is ringing, which speakers exist,
// and what to do next.
//
// The engine never waits. Each call to `tick` looks at the clock, does whatever
// is due (start an alarm, nudge the volume, check the music really started,
// look over the speakers), then asks to be woken at the next moment something
// will be due. The Durable Object in clock.ts supplies the storage, the Sonos
// client and the wake-ups; tests supply fakes and move the clock by hand.

import {
  addDays,
  isClockTime,
  isIsoDate,
  isValidTimeZone,
  localDate,
  nextDateFor,
  nextOccurrence,
  type Vacation,
} from "./schedule";
import { BUFFERING, PLAYING, SonosError, type Group, type Player, type SonosClient, type Store } from "./sonos";
import { SettlingGroups } from "./settle";
import { sameSecret } from "./auth";
import {
  DEFAULT_DOORBELL,
  DINGDONG_PATH,
  DOORBELL_SOUNDS,
  RING_GAP_MS,
  RING_LIMIT,
  inQuietHours,
  newToken,
  type DoorbellSettings,
  type DoorbellSound,
  type Ring,
} from "./doorbell";

const SEC = 1000;
const MIN = 60 * SEC;

/** How late an alarm may still ring. Past this it is logged as missed instead. */
export const GRACE_MS = 10 * MIN;
/** How long the first attempt gets to produce sound before we try again. */
export const START_WAIT_MS = 45 * SEC;
/** How long each later attempt gets. */
export const RETRY_WAIT_MS = 30 * SEC;
/** How often the watcher looks over the speakers when all is well, and when it is not. */
export const WATCH_MS = 15 * MIN;
export const WATCH_TROUBLED_MS = 5 * MIN;
/** The watcher also looks this long before each alarm, so trouble shows up before it matters. */
export const PREFLIGHT_MS = 10 * MIN;
/** Trouble that lasts this long is worth an alert; anything shorter may be a blip. */
export const ALERT_AFTER_MS = 4 * MIN;
const FIRST_CHECK_MS = 8 * SEC;
const RECHECK_MS = 5 * SEC;
const MONITOR_MS = 60 * SEC;
const CHIME_EVERY_MS = 6 * SEC;
const CHIME_FOR_MS = 5 * MIN;
const SNOOZE_FADE_MS = 30 * SEC;
const MAX_SESSION_MS = 3 * 60 * MIN;
const HEARTBEAT_MS = 6 * 60 * MIN;
/** A volume this far from what we last set means someone moved it by hand. */
const HAND_MOVED = 3;
const LOG_LIMIT = 60;

/** A Sonos speaker we have seen in the household, online or not. */
export interface Speaker {
  id: string;
  name: string;
  /** Percent of an alarm's volume this speaker plays at, for evening out loud and quiet rooms. */
  trim: number;
  online: boolean;
  seenAt: number | null;
  canChime: boolean;
  fixed: boolean;
}

export interface Config {
  timezone: string;
  /** False until the owner's browser has told us the real zone. */
  timezoneSet: boolean;
  householdId: string | null;
  speakers: Record<string, Speaker>;
  snoozeMinutes: number;
  /** 0 means leave the music playing. */
  autoStopMinutes: number;
  backupFavoriteId: string | null;
  backupFavoriteName: string | null;
  vacations: Vacation[];
  /** Where to send alerts: an ntfy topic or any webhook that accepts a text POST. */
  notifyUrl: string | null;
  doorbell: DoorbellSettings;
}

export const DEFAULT_CONFIG: Config = {
  timezone: "UTC",
  timezoneSet: false,
  householdId: null,
  speakers: {},
  snoozeMinutes: 9,
  autoStopMinutes: 60,
  backupFavoriteId: null,
  backupFavoriteName: null,
  vacations: [],
  notifyUrl: null,
  doorbell: DEFAULT_DOORBELL,
};

export interface Alarm {
  id: string;
  label: string;
  enabled: boolean;
  time: string;
  days: number[];
  onDate?: string;
  skipDate?: string;
  /** The speakers this alarm rings on. They are grouped for the alarm so they play in step. */
  playerIds: string[];
  favoriteId: string;
  favoriteName: string;
  /** Volume the alarm ends up at, 1–100. */
  volume: number;
  /** Volume the fade-in starts from. */
  startVolume: number;
  /** 0 means start at full alarm volume. */
  fadeMinutes: number;
  shuffle: boolean;
  /** Occurrences at or before this moment are in the past and never ring. */
  armedAt: number;
}

/** 0 first try, 1 second try, 2 backup music, 3 chime. */
type Stage = 0 | 1 | 2 | 3;

/** What the alarm is doing to one speaker's volume. */
interface Level {
  pre?: number;
  last?: number;
  fixed: boolean;
  handMoved: boolean;
  trim: number;
}

export interface Session {
  alarmId: string;
  label: string;
  test: boolean;
  startedAt: number;
  phase: "ringing" | "snoozed";
  snoozeUntil?: number;
  householdId: string;
  /** The speakers the alarm is meant to ring on. */
  playerIds: string[];
  /** Those of them found online, grouped together for the alarm. */
  ringing: string[];
  groupId?: string;
  /** How the speakers were grouped before the alarm rearranged them, coordinator first. */
  priorGroups?: string[][];
  chimers: string[];
  levels: Record<string, Level>;
  /** The alarm volume last applied, before each speaker's trim. */
  level?: number;
  favoriteId: string;
  favoriteName: string;
  shuffle: boolean;
  /** What is actually meant to be sounding right now. */
  playing: string;
  fadeFrom: number;
  fadeTo: number;
  fadeStartAt: number;
  fadeMs: number;
  /** True once Sonos has reported the music actually playing. */
  confirmed: boolean;
  /** Checks in a row that found confirmed music no longer playing. */
  quiet: number;
  stage: Stage;
  checkAt: number;
  stageDeadline: number;
  nextChimeAt?: number;
  chimeUntil?: number;
  autoStop: boolean;
  endAt: number;
}

export interface LogEntry {
  at: number;
  level: "info" | "warn" | "error";
  text: string;
}

/** Something the watcher has found wrong and not yet seen put right. */
export interface Problem {
  key: string;
  level: "warn" | "error";
  text: string;
  /** What to say when it is put right. */
  cleared: string;
  since: number;
  /** Whether an alert has gone out for it. */
  told: boolean;
}

export interface Health {
  checkedAt: number | null;
  problems: Problem[];
}

interface State {
  config: Config;
  alarms: Alarm[];
  session: Session | null;
  log: LogEntry[];
  health: Health;
  watchAt: number;
  /** The doorbell's latest rings, newest first. */
  rings: Ring[];
  /** Alerts to send once the state is safely saved. */
  outbox: string[];
}

export interface Deps {
  store: Store;
  sonos: SonosClient;
  now: () => number;
  /** Ask to have `tick` called at this moment. */
  setWake: (at: number) => Promise<void>;
  /** Deliver an alert. Failures are the caller's to swallow. */
  notify?: (url: string, message: string) => Promise<void>;
  newId?: () => string;
}

export class InputError extends Error {}

type Finding = Pick<Problem, "key" | "level" | "text" | "cleared">;

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function why(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function minutes(n: number): string {
  return `${n} minute${n === 1 ? "" : "s"}`;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The alarm volume at this moment. The fade is timed from when the music is
 * confirmed playing, not from when it was asked for: if the first attempt
 * fails and the backup starts a minute later, it still comes in quietly.
 */
function fadeVolume(s: Session, now: number): number {
  if (!s.confirmed) return s.fadeFrom;
  const p = s.fadeMs <= 0 ? 1 : Math.max(0, Math.min(1, (now - s.fadeStartAt) / s.fadeMs));
  return Math.round(s.fadeFrom + (s.fadeTo - s.fadeFrom) * p);
}

/** One speaker's share of the alarm volume. */
function trimmed(base: number, trim: number): number {
  return Math.max(base > 0 ? 1 : 0, Math.round((base * trim) / 100));
}

export class Engine {
  private d: Deps;

  constructor(deps: Deps) {
    // Sonos reports grouping changes late; see settle.ts.
    this.d = { ...deps, sonos: new SettlingGroups(deps.sonos, deps.now) };
  }

  // ------------------------------------------------------------ storage

  private async load(): Promise<State> {
    const [config, alarms, session, log, health, watchAt, rings] = await Promise.all([
      this.d.store.get<Partial<Config>>("config"),
      this.d.store.get<Alarm[]>("alarms"),
      this.d.store.get<Session>("session"),
      this.d.store.get<LogEntry[]>("log"),
      this.d.store.get<Health>("health"),
      this.d.store.get<number>("watchAt"),
      this.d.store.get<Ring[]>("rings"),
    ]);
    const defaults = structuredClone(DEFAULT_CONFIG);
    return {
      // A fresh copy of the defaults each time: the speaker list is edited in place.
      config: { ...defaults, ...config, doorbell: { ...defaults.doorbell, ...config?.doorbell } },
      alarms: alarms ?? [],
      session: session ?? null,
      log: log ?? [],
      health: health ?? { checkedAt: null, problems: [] },
      watchAt: watchAt ?? 0,
      rings: rings ?? [],
      outbox: [],
    };
  }

  private async save(st: State): Promise<void> {
    await Promise.all([
      this.d.store.put("config", st.config),
      this.d.store.put("alarms", st.alarms),
      st.session ? this.d.store.put("session", st.session) : this.d.store.delete("session"),
      this.d.store.put("log", st.log),
      this.d.store.put("health", st.health),
      this.d.store.put("watchAt", st.watchAt),
      this.d.store.put("rings", st.rings),
    ]);
  }

  /** Write to the activity log, and optionally send it as an alert too. */
  private note(st: State, level: LogEntry["level"], message: string, alert = false): void {
    st.log.unshift({ at: this.d.now(), level, text: message });
    if (st.log.length > LOG_LIMIT) st.log.length = LOG_LIMIT;
    if (alert) st.outbox.push(message);
  }

  private name(st: State, id: string): string {
    return st.config.speakers[id]?.name ?? "a speaker";
  }

  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Load, change, save, and line up the next wake-up, even if the change fails.
   *
   * Changes run strictly one at a time. Talking to Sonos takes a second or
   * two, and without this a wake-up and a button press (or two wake-ups) could
   * both read the same state and both act on it: the same alarm started twice.
   */
  private change<T>(fn: (st: State, now: number) => Promise<T>): Promise<T> {
    const run = async () => {
      const st = await this.load();
      try {
        return await fn(st, this.d.now());
      } finally {
        await this.save(st);
        await this.scheduleWake(st);
        const url = st.config.notifyUrl;
        if (url && this.d.notify) {
          for (const message of st.outbox) await this.d.notify(url, message).catch(() => {});
        }
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  // ------------------------------------------------------------ the clock

  /** Do whatever is due right now. Safe to call at any time, any number of times. */
  async tick(): Promise<void> {
    await this.change(async (st, now) => {
      try {
        this.tidy(st, now);
        await this.advanceSession(st, now);
        await this.fireDue(st, now);
        // The watcher goes last, and waits its turn while an alarm is still
        // getting started, so its questions never hold one up.
        if (now >= st.watchAt) {
          const starting = st.session?.phase === "ringing" && !st.session.confirmed;
          if (starting) st.watchAt = now + 2 * MIN;
          else await this.watch(st, this.d.now(), true);
        }
      } catch (e) {
        this.note(st, "error", `Something went wrong: ${why(e)}`);
      }
    });
  }

  private tidy(st: State, now: number): void {
    const today = localDate(now, st.config.timezone);
    for (const a of st.alarms) if (a.skipDate && a.skipDate < today) delete a.skipDate;
    st.config.vacations = st.config.vacations.filter((v) => v.to >= today);
  }

  private next(a: Alarm, st: State): number | null {
    return a.enabled ? nextOccurrence(a, a.armedAt, st.config.timezone, st.config.vacations) : null;
  }

  private nextRing(st: State): number | null {
    let soonest: number | null = null;
    for (const a of st.alarms) {
      const n = this.next(a, st);
      if (n !== null && (soonest === null || n < soonest)) soonest = n;
    }
    return soonest;
  }

  private async fireDue(st: State, now: number): Promise<void> {
    for (const a of st.alarms) {
      const due = this.next(a, st);
      if (due === null || due > now) continue;
      a.armedAt = now;
      if (a.days.length === 0) a.enabled = false;
      if (now - due > GRACE_MS) {
        const late = Math.round((now - due) / MIN);
        this.note(st, "error", `Missed "${a.label}": the clock woke ${minutes(late)} late.`, true);
        continue;
      }
      await this.start(st, a, now, false);
    }
  }

  private async scheduleWake(st: State): Promise<void> {
    const now = this.d.now();
    let wake = now + HEARTBEAT_MS;
    const ring = this.nextRing(st);
    if (ring !== null) wake = Math.min(wake, ring);
    if (st.config.householdId) wake = Math.min(wake, st.watchAt);
    const s = st.session;
    if (s?.phase === "snoozed") {
      wake = Math.min(wake, s.snoozeUntil ?? now);
    } else if (s) {
      wake = Math.min(wake, s.endAt);
      if (s.stage === 3) {
        wake = Math.min(wake, s.nextChimeAt ?? now, s.chimeUntil ?? now);
      } else {
        wake = Math.min(wake, s.checkAt);
        if (!s.confirmed) wake = Math.min(wake, s.stageDeadline);
        if (s.confirmed && this.stillFading(s)) {
          // Aim for one step per volume point, within sensible limits.
          const perPoint = s.fadeMs / Math.max(1, Math.abs(s.fadeTo - s.fadeFrom));
          wake = Math.min(wake, now + Math.max(5 * SEC, Math.min(30 * SEC, perPoint)));
        }
      }
    }
    await this.d.setWake(Math.max(wake, now + 250));
  }

  // ------------------------------------------------------------ ringing

  private stillFading(s: Session): boolean {
    return s.ringing.some((id) => {
      const l = s.levels[id];
      return !l || (!l.fixed && !l.handMoved && l.last !== trimmed(s.fadeTo, l.trim));
    });
  }

  /**
   * Work out which of the alarm's speakers are online and get them into one
   * group, so they play in step. If they are already grouped exactly that way
   * nothing is touched; otherwise the old arrangement is remembered so it can
   * be put back when the alarm is over.
   */
  private async gather(st: State, s: Session): Promise<void> {
    const { groups, players } = await this.d.sonos.groups(s.householdId);
    const present = new Set(groups.flatMap((g) => g.playerIds ?? []));
    const online = s.playerIds.filter((id) => present.has(id));
    if (!online.length) throw new Error(s.playerIds.length > 1 ? "none of its speakers are online" : "its speaker is offline");
    const missing = s.playerIds.filter((id) => !present.has(id));
    if (missing.length && !s.ringing.length) {
      const names = list(missing.map((id) => this.name(st, id)));
      this.note(st, "warn", `${names} ${missing.length > 1 ? "are" : "is"} offline, so "${s.label}" is ringing without ${missing.length > 1 ? "them" : "it"}.`, true);
    }
    s.ringing = online;
    s.chimers = online.filter((id) => players.find((p) => p.id === id)?.capabilities?.includes("AUDIO_CLIP"));

    const exact = (list: Group[]) => list.find((g) => sameSet(g.playerIds ?? [], online));
    let group = exact(groups);
    if (!group) {
      s.priorGroups ??= groups
        .filter((g) => g.playerIds?.some((id) => online.includes(id)))
        .map((g) => [g.coordinatorId, ...g.playerIds.filter((id) => id !== g.coordinatorId)]);
      try {
        const made = await this.d.sonos.createGroup(s.householdId, online);
        group = made ?? exact((await this.d.sonos.groups(s.householdId)).groups);
      } catch (e) {
        this.note(st, "warn", `Could not group the speakers together: ${why(e)}.`);
      }
      // If grouping failed, ring on whatever group the first speaker is in.
      group ??= (await this.d.sonos.groups(s.householdId)).groups.find((g) => g.playerIds?.includes(online[0]!));
    }
    if (!group) throw new Error("its speakers could not be found");
    s.groupId = group.id;
  }

  /** Run a group command, gathering the speakers again if Sonos says the group has changed. */
  private async withGroup<T>(st: State, s: Session, fn: (groupId: string) => Promise<T>): Promise<T> {
    if (!s.groupId) await this.gather(st, s);
    try {
      return await fn(s.groupId!);
    } catch (e) {
      if (!(e instanceof SonosError) || (e.status !== 410 && e.status !== 404)) throw e;
      await this.gather(st, s);
      return await fn(s.groupId!);
    }
  }

  /** Put the speakers back the way they were grouped before the alarm moved them. */
  private async regroup(st: State, s: Session): Promise<void> {
    if (!s.priorGroups) return;
    try {
      for (const prior of s.priorGroups) {
        const { groups } = await this.d.sonos.groups(s.householdId);
        const present = new Set(groups.flatMap((g) => g.playerIds ?? []));
        const want = prior.filter((id) => present.has(id));
        if (!want.length || groups.some((g) => sameSet(g.playerIds ?? [], want))) continue;
        const ours = want.filter((id) => s.ringing.includes(id));
        const others = want.filter((id) => !s.ringing.includes(id));
        const home = others.length ? groups.find((g) => g.playerIds?.includes(others[0]!)) : undefined;
        if (home) {
          // Speakers we borrowed from a group that carried on without them: hand them back,
          // leaving whatever that group is playing undisturbed.
          await this.d.sonos.setGroupMembers(home.id, [...new Set([...home.playerIds, ...ours])]);
        } else {
          await this.d.sonos.createGroup(s.householdId, want);
        }
      }
    } catch (e) {
      this.note(st, "warn", `Could not put the speakers back the way they were grouped: ${why(e)}.`);
    }
  }

  private async start(st: State, a: Alarm, now: number, test: boolean): Promise<void> {
    const { householdId } = st.config;
    const label = test ? `Test of "${a.label}"` : `"${a.label}"`;
    if (!householdId) {
      this.note(st, "error", `${label} could not ring: Sonos is not connected.`, !test);
      return;
    }
    if (!a.playerIds.length) {
      this.note(st, "error", `${label} could not ring: it has no speakers to ring on.`, !test);
      return;
    }
    const fadeMs = a.fadeMinutes * MIN;
    const autoStop = st.config.autoStopMinutes > 0;
    const s: Session = {
      alarmId: a.id,
      label: a.label,
      test,
      startedAt: now,
      phase: "ringing",
      householdId,
      playerIds: [...a.playerIds],
      ringing: [],
      chimers: [],
      levels: {},
      favoriteId: a.favoriteId,
      favoriteName: a.favoriteName,
      shuffle: a.shuffle,
      playing: a.favoriteName,
      fadeFrom: fadeMs > 0 ? Math.min(a.startVolume, a.volume) : a.volume,
      fadeTo: a.volume,
      fadeStartAt: now,
      fadeMs,
      confirmed: false,
      quiet: 0,
      stage: 0,
      checkAt: now + FIRST_CHECK_MS,
      stageDeadline: now + START_WAIT_MS,
      autoStop,
      endAt: now + (autoStop ? st.config.autoStopMinutes * MIN : MAX_SESSION_MS),
    };
    // Record that we are ringing before touching Sonos, so that a crash or a
    // second wake-up part-way through can never start the same alarm twice.
    st.session = s;
    await this.d.store.put("session", s);
    this.note(st, "info", `${label} is ringing.`);

    try {
      await this.gather(st, s);
    } catch (e) {
      this.note(st, "warn", `Could not reach the speakers: ${why(e)}.`);
      s.stageDeadline = now + 15 * SEC;
      return;
    }

    await this.primeVolume(st, s, now);

    try {
      await this.d.sonos.loadFavorite(s.groupId!, s.favoriteId, { shuffle: s.shuffle });
    } catch (e) {
      this.note(st, "warn", `"${s.favoriteName}" would not start: ${why(e)}.`);
      s.stageDeadline = now + 10 * SEC;
    }
  }

  /**
   * Set each speaker to the volume the alarm should be at right now,
   * remembering what it was before. Done ahead of any music so the house is
   * never blasted awake.
   */
  private async primeVolume(st: State, s: Session, now: number): Promise<void> {
    const base = fadeVolume(s, now);
    await Promise.all(
      s.ringing.map(async (id) => {
        const l = (s.levels[id] ??= { fixed: false, handMoved: false, trim: st.config.speakers[id]?.trim ?? 100 });
        if (l.fixed || l.handMoved || l.last !== undefined) return;
        try {
          const v = await this.d.sonos.getVolume(id);
          if (v.fixed) {
            l.fixed = true;
            this.note(st, "warn", `${this.name(st, id)} has a fixed volume, so the alarm cannot fade in or set its level there.`);
            return;
          }
          l.pre ??= v.volume;
          const level = trimmed(base, l.trim);
          await this.d.sonos.setVolume(id, level);
          l.last = level;
        } catch (e) {
          this.note(st, "warn", `Could not set the starting volume on ${this.name(st, id)}: ${why(e)}.`);
        }
      }),
    );
    s.level = base;
  }

  private async advanceSession(st: State, now: number): Promise<void> {
    const s = st.session;
    if (!s) return;

    if (s.phase === "snoozed") {
      if (now >= (s.snoozeUntil ?? 0)) await this.resume(st, s, now);
      return;
    }

    if (now >= s.endAt) {
      if (s.autoStop) {
        await this.silence(st, s);
        this.note(st, "info", `"${s.label}" stopped by itself after ${minutes(st.config.autoStopMinutes)}.`);
      }
      st.session = null;
      return;
    }

    if (s.stage === 3) {
      if (now >= (s.chimeUntil ?? 0)) {
        this.note(st, "warn", `"${s.label}" chimed for five minutes and gave up.`);
        st.session = null;
      } else if (now >= (s.nextChimeAt ?? 0)) {
        await this.chime(s);
        s.nextChimeAt = now + CHIME_EVERY_MS;
      }
      return;
    }

    if (now >= s.checkAt) {
      let state: string;
      try {
        state = await this.withGroup(st, s, (g) => this.d.sonos.playbackState(g));
      } catch {
        state = "UNREACHABLE";
      }
      s.checkAt = now + RECHECK_MS;
      if (state === PLAYING) {
        if (!s.confirmed) s.fadeStartAt = now;
        s.confirmed = true;
        s.quiet = 0;
        s.checkAt = now + MONITOR_MS;
      } else if (s.confirmed && state !== BUFFERING && state !== "UNREACHABLE") {
        // It was playing and now it is not. One reading could be the gap
        // between two tracks; two in a row means someone stopped it elsewhere.
        if (++s.quiet >= 2) {
          await this.restoreVolume(s);
          this.note(st, "info", `"${s.label}" was stopped from another app.`);
          st.session = null;
          return;
        }
      }
    }

    if (!s.confirmed && now >= s.stageDeadline) {
      await this.escalate(st, s, now);
      // `escalate` may have ended the alarm or switched it to the chime.
      if (!st.session || (s.stage as Stage) === 3) return;
    }

    await this.fadeStep(st, s, now);
  }

  /** The music has not started in time. Try the next thing. */
  private async escalate(st: State, s: Session, now: number): Promise<void> {
    s.checkAt = now + RECHECK_MS;
    s.stageDeadline = now + RETRY_WAIT_MS;

    if (s.stage === 0) {
      s.stage = 1;
      this.note(st, "warn", `"${s.favoriteName}" has not started. Trying again.`);
      if (!s.groupId) await this.gather(st, s).catch(() => {});
      await this.primeVolume(st, s, now);
      await this.withGroup(st, s, (g) => this.d.sonos.loadFavorite(g, s.favoriteId, { shuffle: s.shuffle })).catch(() => {});
      return;
    }

    const backup = st.config.backupFavoriteId;
    if (s.stage === 1 && backup && backup !== s.favoriteId) {
      s.stage = 2;
      s.playing = st.config.backupFavoriteName ?? "the backup";
      this.note(st, "warn", `"${s.favoriteName}" still has not started. Playing the backup, "${s.playing}".`, !s.test);
      await this.withGroup(st, s, (g) => this.d.sonos.loadFavorite(g, backup, { shuffle: true })).catch(() => {});
      return;
    }

    if (!s.groupId) await this.gather(st, s).catch(() => {});
    if (!s.chimers.length) {
      this.note(st, "error", `"${s.label}" failed: no music would start and its speakers cannot play the chime.`, !s.test);
      st.session = null;
      return;
    }
    s.stage = 3;
    s.playing = "the Sonos chime";
    s.chimeUntil = now + CHIME_FOR_MS;
    s.nextChimeAt = now + CHIME_EVERY_MS;
    this.note(st, "error", `No music would start for "${s.label}". Sounding the Sonos chime instead.`, !s.test);
    await this.chime(s);
  }

  private async chime(s: Session): Promise<void> {
    await Promise.all(
      s.chimers.map((id) => this.d.sonos.chime(id, trimmed(s.fadeTo, s.levels[id]?.trim ?? 100)).catch(() => {})),
    );
  }

  private async fadeStep(st: State, s: Session, now: number): Promise<void> {
    const base = fadeVolume(s, now);
    await Promise.all(
      s.ringing.map(async (id) => {
        const l = s.levels[id];
        if (!l || l.fixed || l.handMoved) return;
        const target = trimmed(base, l.trim);
        if (l.last === target) return;
        try {
          if (l.last !== undefined) {
            const cur = await this.d.sonos.getVolume(id);
            if (Math.abs(cur.volume - l.last) >= HAND_MOVED) {
              l.handMoved = true;
              this.note(st, "info", `Someone changed the volume on ${this.name(st, id)} by hand, so its fade-in stopped there.`);
              return;
            }
          }
          await this.d.sonos.setVolume(id, target);
          l.last = target;
        } catch {
          /* try again at the next step */
        }
      }),
    );
    s.level = base;
  }

  /** Put each speaker's volume back where it was, unless someone has since moved it. */
  private async restoreVolume(s: Session): Promise<void> {
    await Promise.all(
      s.ringing.map(async (id) => {
        const l = s.levels[id];
        if (!l || l.fixed || l.handMoved || l.pre === undefined || l.last === undefined) return;
        try {
          const cur = await this.d.sonos.getVolume(id);
          if (Math.abs(cur.volume - l.last) < HAND_MOVED) await this.d.sonos.setVolume(id, l.pre);
        } catch {
          /* the volume stays at alarm level; not worth failing over */
        }
      }),
    );
  }

  /** Pause the music. Returns false, and says so in the log, if Sonos did not confirm it. */
  private async pause(st: State, s: Session): Promise<boolean> {
    try {
      await this.withGroup(st, s, (g) => this.d.sonos.pause(g));
      return true;
    } catch (e) {
      // While chiming there is no music to pause, so a refusal means nothing.
      if (s.stage === 3) return true;
      this.note(st, "warn", `Sonos did not confirm the pause: ${why(e)}.`);
      return false;
    }
  }

  /** Pause the music, then put volumes and grouping back. */
  private async silence(st: State, s: Session): Promise<boolean> {
    const ok = await this.pause(st, s);
    await this.restoreVolume(s);
    await this.regroup(st, s);
    return ok;
  }

  private async resume(st: State, s: Session, now: number): Promise<void> {
    s.phase = "ringing";
    delete s.snoozeUntil;
    s.confirmed = false;
    s.quiet = 0;
    s.checkAt = now + RECHECK_MS;
    s.stageDeadline = now + RETRY_WAIT_MS;
    s.endAt = now + (s.autoStop ? st.config.autoStopMinutes * MIN : MAX_SESSION_MS);
    this.note(st, "info", `"${s.label}" is ringing again after the snooze.`);

    if (s.stage === 3) {
      s.chimeUntil = now + CHIME_FOR_MS;
      s.nextChimeAt = now + CHIME_EVERY_MS;
      await this.chime(s);
      return;
    }

    // Come back in gently, but quickly: this is the second call.
    s.fadeMs = Math.min(s.fadeMs, SNOOZE_FADE_MS);
    await Promise.all(
      s.ringing.map(async (id) => {
        const l = s.levels[id];
        if (!l || l.fixed || l.handMoved) return;
        try {
          const level = trimmed(s.fadeFrom, l.trim);
          await this.d.sonos.setVolume(id, level);
          l.last = level;
        } catch {
          /* carry on at whatever volume it is */
        }
      }),
    );
    s.level = s.fadeFrom;
    if (s.stage === 1) s.stage = 0;
    try {
      await this.withGroup(st, s, (g) => this.d.sonos.play(g));
    } catch {
      const favorite = s.stage === 2 ? (st.config.backupFavoriteId ?? s.favoriteId) : s.favoriteId;
      await this.withGroup(st, s, (g) => this.d.sonos.loadFavorite(g, favorite, { shuffle: s.shuffle })).catch(() => {});
    }
  }

  // ------------------------------------------------------------ buttons

  async snooze(): Promise<{ ok: boolean }> {
    return this.change(async (st, now) => {
      const s = st.session;
      if (!s || s.phase !== "ringing") return { ok: true };
      const ok = await this.pause(st, s);
      s.phase = "snoozed";
      s.snoozeUntil = now + st.config.snoozeMinutes * MIN;
      this.note(st, "info", `"${s.label}" snoozed for ${minutes(st.config.snoozeMinutes)}.`);
      return { ok };
    });
  }

  /** Stop the alarm and the music. */
  async stop(): Promise<{ ok: boolean }> {
    return this.change(async (st) => {
      const s = st.session;
      if (!s) return { ok: true };
      let ok = true;
      if (s.phase === "snoozed") {
        await this.restoreVolume(s);
        await this.regroup(st, s);
      } else {
        ok = await this.silence(st, s);
      }
      this.note(st, "info", `"${s.label}" stopped.`);
      st.session = null;
      return { ok };
    });
  }

  /** End the alarm but leave the music playing. */
  async dismiss(): Promise<void> {
    await this.change(async (st) => {
      if (!st.session) return;
      this.note(st, "info", `"${st.session.label}" dismissed; the music plays on.`);
      st.session = null;
    });
  }

  async testAlarm(id: string): Promise<void> {
    await this.change(async (st, now) => {
      const a = st.alarms.find((x) => x.id === id);
      if (!a) throw new InputError("That alarm no longer exists.");
      await this.start(st, a, now, true);
    });
  }

  // ------------------------------------------------------------ the watcher

  /**
   * Look over the household: which speakers exist, which are online, whether
   * Sonos still lets us in, and whether everything the alarms rely on is still
   * there. New trouble is logged at once; trouble that lasts a few minutes is
   * sent as an alert, and so is its going away.
   *
   * A `thorough` look is the scheduled one: it also checks favorites and fixed
   * volumes, and books the next look. The Speakers panel takes quick looks in
   * between. Returns what it saw, for the panel to show.
   */
  private async watch(st: State, now: number, thorough: boolean): Promise<{ groups: Group[]; players: Player[] } | null> {
    const c = st.config;
    const before = st.health.problems;
    const found: Finding[] = [];
    /** Problems this look could not re-examine, kept exactly as they were. */
    const kept: Problem[] = [];
    let seen: { groups: Group[]; players: Player[] } | null = null;

    const finish = () => {
      const problems: Problem[] = [...kept];
      for (const f of found) {
        const old = before.find((p) => p.key === f.key);
        const p: Problem = old ? { ...old, ...f } : { ...f, since: now, told: false };
        if (!old) this.note(st, f.level, f.text);
        if (!p.told && now - p.since >= ALERT_AFTER_MS) {
          p.told = true;
          st.outbox.push(p.text);
        }
        problems.push(p);
      }
      for (const old of before) {
        if (problems.some((p) => p.key === old.key)) continue;
        this.note(st, "info", old.cleared, old.told);
      }
      st.health = { checkedAt: now, problems };
      if (thorough) {
        // Look again sooner while something is wrong, and shortly before the next alarm.
        st.watchAt = now + (problems.length ? WATCH_TROUBLED_MS : WATCH_MS);
        const ring = this.nextRing(st);
        if (ring !== null && ring - PREFLIGHT_MS > now + MIN) st.watchAt = Math.min(st.watchAt, ring - PREFLIGHT_MS);
      }
      return seen;
    };

    if (!c.householdId) {
      st.health = { checkedAt: null, problems: [] };
      if (thorough) st.watchAt = now + WATCH_MS;
      return null;
    }

    try {
      seen = await this.d.sonos.groups(c.householdId);
    } catch (e) {
      const signedOut = e instanceof SonosError && (e.code === "RECONNECT" || e.code === "NOT_CONNECTED");
      found.push(
        signedOut
          ? { key: "sonos:auth", level: "error", text: "Sonos has signed this app out, so alarms cannot ring. Reconnect it in Settings.", cleared: "Sonos is connected again." }
          : { key: "sonos:unreachable", level: "warn", text: `Sonos's cloud is not answering (${why(e)}).`, cleared: "Sonos's cloud is answering again." },
      );
      // With no answer we cannot tell what else has changed, so keep what we knew.
      kept.push(...before.filter((p) => !p.key.startsWith("sonos:")));
      return finish();
    }

    // --- discovery: keep the list of speakers up to date
    const present = new Set(seen.groups.flatMap((g) => g.playerIds ?? []));
    const fresh: string[] = [];
    for (const p of seen.players) {
      if (!present.has(p.id)) continue;
      const known = c.speakers[p.id];
      if (!known) fresh.push(p.name);
      c.speakers[p.id] = {
        id: p.id,
        name: p.name,
        trim: known?.trim ?? 100,
        online: true,
        seenAt: now,
        canChime: Boolean(p.capabilities?.includes("AUDIO_CLIP")),
        fixed: known?.fixed ?? false,
      };
    }
    if (fresh.length) this.note(st, "info", `Found ${fresh.length > 1 ? `${fresh.length} speakers` : "a speaker"}: ${list(fresh)}.`);
    for (const sp of Object.values(c.speakers)) if (!present.has(sp.id)) sp.online = false;

    const ringsOn = (id: string) => st.alarms.filter((a) => a.enabled && a.playerIds.includes(id));
    for (const sp of Object.values(c.speakers)) {
      if (sp.online) continue;
      const used = ringsOn(sp.id).length > 0;
      found.push({
        key: `offline:${sp.id}`,
        level: "warn",
        text: `${sp.name} is offline${used ? "; alarms that use it will ring without it" : ""}.`,
        cleared: `${sp.name} is back online.`,
      });
    }
    for (const a of st.alarms) {
      if (!a.enabled) continue;
      if (!a.playerIds.some((id) => c.speakers[id]?.online)) {
        found.push({
          key: `silent:${a.id}`,
          level: "error",
          text: `"${a.label}" has no speaker online to ring on.`,
          cleared: `"${a.label}" has a speaker to ring on again.`,
        });
      }
    }

    const bell = c.doorbell;
    if (bell.enabled && !bell.playerIds.some((id) => c.speakers[id]?.online && c.speakers[id]?.canChime)) {
      found.push({
        key: "doorbell:silent",
        level: "error",
        text: "The doorbell has no speaker online that can play it.",
        cleared: "The doorbell has a speaker to play on again.",
      });
    }

    // --- volume: a fixed line-out cannot fade in
    if (thorough) {
      await Promise.all(
        Object.values(c.speakers)
          .filter((sp) => sp.online)
          .map(async (sp) => {
            sp.fixed = await this.d.sonos.getVolume(sp.id).then((v) => v.fixed, () => sp.fixed);
          }),
      );
    }
    for (const sp of Object.values(c.speakers)) {
      if (sp.online && sp.fixed && ringsOn(sp.id).length) {
        found.push({
          key: `fixed:${sp.id}`,
          level: "warn",
          text: `${sp.name} has a fixed volume, so alarms cannot fade in or set their level there. In the Sonos app, set its Line-Out Level to Variable.`,
          cleared: `${sp.name} no longer has a fixed volume.`,
        });
      }
    }

    // --- favorites: an alarm whose music has been removed would ring as a chime
    let favorites: Set<string> | null = null;
    if (thorough) favorites = await this.d.sonos.favorites(c.householdId).then((f) => new Set(f.map((x) => x.id)), () => null);
    if (favorites) {
      for (const a of st.alarms) {
        if (a.enabled && !favorites.has(a.favoriteId)) {
          found.push({
            key: `favorite:${a.id}`,
            level: "error",
            text: `"${a.label}" is set to play "${a.favoriteName}", which is no longer in your Sonos Favorites.`,
            cleared: `"${a.label}" has its music back.`,
          });
        }
      }
      if (c.backupFavoriteId && !favorites.has(c.backupFavoriteId)) {
        found.push({
          key: "favorite:backup",
          level: "warn",
          text: `The backup, "${c.backupFavoriteName}", is no longer in your Sonos Favorites.`,
          cleared: "The backup music is available again.",
        });
      }
    } else {
      kept.push(...before.filter((p) => p.key.startsWith("favorite:")));
    }

    return finish();
  }

  /** Everything the Speakers panel shows, read live from Sonos. */
  async speakers(): Promise<Record<string, unknown>> {
    return this.change((st, now) => this.speakerView(st, now));
  }

  private async speakerView(st: State, now: number): Promise<Record<string, unknown>> {
    const seen = await this.watch(st, now, false);
    const c = st.config;
    const groups = seen?.groups ?? [];
    const volumes = new Map<string, { volume: number; muted: boolean; fixed: boolean }>();
    const titles = new Map<string, string | null>();
    await Promise.all([
      ...Object.values(c.speakers)
        .filter((sp) => sp.online)
        .map(async (sp) => {
          const v = await this.d.sonos.getVolume(sp.id).catch(() => null);
          if (!v) return;
          volumes.set(sp.id, v);
          sp.fixed = v.fixed;
        }),
      ...groups
        .filter((g) => g.playbackState && g.playbackState !== "PLAYBACK_STATE_IDLE")
        .map(async (g) => void titles.set(g.id, await this.d.sonos.nowPlaying(g.id).catch(() => null))),
    ]);
    return {
      reachable: seen !== null,
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        state: g.playbackState ?? "PLAYBACK_STATE_IDLE",
        playing: titles.get(g.id) ?? null,
        coordinatorId: g.coordinatorId,
        playerIds: g.playerIds ?? [],
      })),
      speakers: Object.values(c.speakers)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((sp) => ({
          ...sp,
          volume: volumes.get(sp.id)?.volume ?? null,
          muted: volumes.get(sp.id)?.muted ?? false,
          groupId: groups.find((g) => g.playerIds?.includes(sp.id))?.id ?? null,
          alarms: st.alarms.filter((a) => a.playerIds.includes(sp.id)).length,
        })),
      health: st.health,
    };
  }

  /** One of the Speakers panel's controls. Returns the panel as it stands afterwards. */
  async manage(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.change(async (st, now) => {
      const c = st.config;
      const hid = c.householdId;
      if (!hid) throw new InputError("Connect Sonos first.");
      const id = text(input.id, 200);
      const speaker = () => {
        const sp = c.speakers[id];
        if (!sp) throw new InputError("That speaker is not known.");
        return sp;
      };
      const groupId = text(input.groupId, 300);
      const live = async () => (await this.d.sonos.groups(hid)).groups;

      if (action === "volume") {
        await this.d.sonos.setVolume(speaker().id, clampInt(input.volume, 0, 100, 20));
      } else if (action === "trim") {
        speaker().trim = clampInt(input.trim, 10, 100, 100);
      } else if (action === "forget") {
        if (speaker().online) throw new InputError("That speaker is online. Only speakers that have gone for good can be forgotten.");
        delete c.speakers[id];
        for (const a of st.alarms) a.playerIds = a.playerIds.filter((p) => p !== id);
        c.doorbell.playerIds = c.doorbell.playerIds.filter((p) => p !== id);
      } else if (action === "pause") {
        await this.d.sonos.pause(groupId);
      } else if (action === "play") {
        await this.d.sonos.play(groupId);
      } else if (action === "pause-all") {
        const playing = (await live()).filter((g) => g.playbackState === PLAYING || g.playbackState === BUFFERING);
        await Promise.all(playing.map((g) => this.d.sonos.pause(g.id)));
      } else if (action === "split") {
        // On its own, in a new group of one.
        await this.d.sonos.createGroup(hid, [speaker().id]);
      } else if (action === "join") {
        const target = (await live()).find((g) => g.id === groupId);
        if (!target) throw new InputError("That group has changed. Try again.");
        await this.d.sonos.setGroupMembers(target.id, [...new Set([...target.playerIds, speaker().id])]);
      } else if (action === "group-all") {
        // Everything joins whichever group is playing, so the music carries on everywhere.
        const groups = await live();
        const all = [...new Set(groups.flatMap((g) => g.playerIds))];
        const lead = groups.find((g) => g.playbackState === PLAYING) ?? groups.sort((a, b) => b.playerIds.length - a.playerIds.length)[0];
        if (lead && all.length > 1) await this.d.sonos.setGroupMembers(lead.id, [lead.coordinatorId, ...all.filter((p) => p !== lead.coordinatorId)]);
      } else if (action === "separate") {
        // Each speaker that shares a group moves into a new group of its own; the
        // coordinator stays behind. Creating the groups, rather than shrinking the
        // old one, means Sonos answers with every new group, so the panel can show
        // them before Sonos's own list catches up.
        for (const g of await live()) {
          for (const p of g.playerIds) if (p !== g.coordinatorId) await this.d.sonos.createGroup(hid, [p]);
        }
      } else {
        throw new InputError("That is not something speakers can do.");
      }
      return this.speakerView(st, now);
    });
  }

  /** Send a test alert, so the owner knows the address works before relying on it. */
  async testAlert(): Promise<void> {
    await this.change(async (st) => {
      if (!st.config.notifyUrl) throw new InputError("Add an address for alerts first.");
      if (!this.d.notify) throw new InputError("Alerts are not available here.");
      await this.d.notify(st.config.notifyUrl, "This is a test from House Alarm. Alerts are working.").catch((e) => {
        throw new InputError(`The alert could not be sent: ${why(e)}.`);
      });
    });
  }

  // ------------------------------------------------------------ editing

  private readAlarm(input: Record<string, unknown>, st: State, now: number, existing?: Alarm): Alarm {
    const time = input.time ?? existing?.time;
    if (!isClockTime(time)) throw new InputError("Pick a time.");
    const rawDays = Array.isArray(input.days) ? input.days : (existing?.days ?? []);
    const days = [...new Set(rawDays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    const favoriteId = text(input.favoriteId ?? existing?.favoriteId, 200);
    if (!favoriteId) throw new InputError("Pick what the alarm should play.");
    const known = Object.keys(st.config.speakers);
    let playerIds = Array.isArray(input.playerIds)
      ? [...new Set(input.playerIds.filter((p): p is string => typeof p === "string" && known.includes(p)))]
      : (existing?.playerIds ?? known);
    if (Array.isArray(input.playerIds) && !playerIds.length) throw new InputError("Pick at least one speaker to ring on.");
    if (!playerIds.length) playerIds = known;
    if (!playerIds.length) throw new InputError("No speakers have been found yet. Connect Sonos first.");
    const volume = clampInt(input.volume ?? existing?.volume, 1, 100, 30);
    const a: Alarm = {
      id: existing?.id ?? (this.d.newId ?? (() => crypto.randomUUID()))(),
      label: text(input.label ?? existing?.label, 40) || "Alarm",
      enabled: input.enabled === undefined ? (existing?.enabled ?? true) : Boolean(input.enabled),
      time,
      days,
      playerIds,
      favoriteId,
      favoriteName: text(input.favoriteName ?? existing?.favoriteName, 120) || "Sonos favorite",
      volume,
      startVolume: clampInt(input.startVolume ?? existing?.startVolume, 0, volume, Math.min(5, volume)),
      fadeMinutes: clampInt(input.fadeMinutes ?? existing?.fadeMinutes, 0, 30, 5),
      shuffle: input.shuffle === undefined ? (existing?.shuffle ?? true) : Boolean(input.shuffle),
      // Saving an alarm re-arms it from this moment: nothing in the past rings.
      armedAt: now,
    };
    if (days.length === 0) a.onDate = nextDateFor(time, now, st.config.timezone);
    else if (existing?.skipDate) a.skipDate = existing.skipDate;
    return a;
  }

  async createAlarm(input: Record<string, unknown>): Promise<Alarm> {
    return this.change(async (st, now) => {
      if (st.alarms.length >= 30) throw new InputError("That is a lot of alarms. Delete one first.");
      const a = this.readAlarm(input, st, now);
      st.alarms.push(a);
      st.watchAt = 0; // have the watcher look over the new alarm's speakers and music
      return a;
    });
  }

  async updateAlarm(id: string, input: Record<string, unknown>): Promise<Alarm> {
    return this.change(async (st, now) => {
      const i = st.alarms.findIndex((x) => x.id === id);
      if (i < 0) throw new InputError("That alarm no longer exists.");
      const a = this.readAlarm(input, st, now, st.alarms[i]);
      st.alarms[i] = a;
      st.watchAt = 0;
      return a;
    });
  }

  async deleteAlarm(id: string): Promise<void> {
    await this.change(async (st) => {
      st.alarms = st.alarms.filter((x) => x.id !== id);
      st.watchAt = 0;
    });
  }

  /** Skip the alarm's next occurrence, or undo that. */
  async setSkip(id: string, skip: boolean): Promise<void> {
    await this.change(async (st) => {
      const a = st.alarms.find((x) => x.id === id);
      if (!a) throw new InputError("That alarm no longer exists.");
      delete a.skipDate;
      if (!skip) return;
      const n = this.next(a, st);
      if (n === null) throw new InputError("That alarm is not due to ring.");
      a.skipDate = localDate(n, st.config.timezone);
    });
  }

  async updateConfig(input: Record<string, unknown>): Promise<void> {
    await this.change(async (st, now) => {
      const c = st.config;
      if (input.timezone !== undefined) {
        if (!isValidTimeZone(input.timezone)) throw new InputError("That time zone is not recognised.");
        if (input.timezone !== c.timezone) {
          c.timezone = input.timezone;
          // Times mean something new in the new zone; do not ring for ones now in the past.
          for (const a of st.alarms) a.armedAt = now;
        }
        c.timezoneSet = true;
      }
      if (input.snoozeMinutes !== undefined) c.snoozeMinutes = clampInt(input.snoozeMinutes, 1, 30, 9);
      if (input.autoStopMinutes !== undefined) c.autoStopMinutes = clampInt(input.autoStopMinutes, 0, 180, 60);
      if (input.backupFavoriteId !== undefined) {
        c.backupFavoriteId = text(input.backupFavoriteId, 200) || null;
        c.backupFavoriteName = c.backupFavoriteId ? text(input.backupFavoriteName, 120) || "Backup" : null;
        st.watchAt = 0;
      }
      if (input.notifyUrl !== undefined) {
        const url = text(input.notifyUrl, 500);
        // https only, except this machine itself, which is how alerts are tried out in development.
        const ok = /^https:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/.test(url) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/\S*)?$/.test(url);
        if (url && !ok) throw new InputError("Alerts need an https:// address.");
        c.notifyUrl = url || null;
      }
      if (input.vacations !== undefined) {
        if (!Array.isArray(input.vacations)) throw new InputError("Time away must be a list of dates.");
        c.vacations = input.vacations.slice(0, 20).map((v: Record<string, unknown>) => {
          if (!isIsoDate(v?.from) || !isIsoDate(v?.to)) throw new InputError("Pick a first and a last day.");
          if (v.to < v.from) throw new InputError("The last day away is before the first.");
          return {
            id: text(v.id, 60) || (this.d.newId ?? (() => crypto.randomUUID()))(),
            from: v.from,
            to: v.to,
            label: text(v.label, 40) || undefined,
          };
        });
      }
      if (input.doorbell !== undefined) {
        if (!input.doorbell || typeof input.doorbell !== "object") throw new InputError("Those doorbell settings were not understood.");
        c.doorbell = this.readDoorbell(input.doorbell as Record<string, unknown>, c);
        st.watchAt = 0;
      }
    });
  }

  private readDoorbell(input: Record<string, unknown>, c: Config): DoorbellSettings {
    const d = { ...c.doorbell };
    if (input.enabled !== undefined) d.enabled = input.enabled === true;
    if (input.playerIds !== undefined) {
      if (!Array.isArray(input.playerIds)) throw new InputError("Pick the speakers the doorbell rings on.");
      d.playerIds = [...new Set(input.playerIds)].filter((p): p is string => typeof p === "string" && Boolean(c.speakers[p]));
    } else if (input.enabled === true && !c.doorbell.enabled && !d.playerIds.length) {
      // Switched on for the first time: every speaker that can play it.
      d.playerIds = Object.values(c.speakers).filter((sp) => sp.canChime).map((sp) => sp.id);
    }
    if (input.volume !== undefined) d.volume = clampInt(input.volume, 1, 100, d.volume);
    if (input.quietVolume !== undefined) d.quietVolume = clampInt(input.quietVolume, 0, 100, d.quietVolume);
    if (input.sound !== undefined) {
      if (!DOORBELL_SOUNDS.includes(input.sound as DoorbellSound)) throw new InputError("That is not a doorbell sound.");
      d.sound = input.sound as DoorbellSound;
    }
    if (input.soundUrl !== undefined) {
      const url = text(input.soundUrl, 500);
      if (url && !/^https:\/\/[^\s/]+\.[^\s/]+\/\S+$/.test(url)) throw new InputError("The sound needs an https:// address of an MP3 or WAV file.");
      d.soundUrl = url || null;
    }
    if (d.sound === "url" && !d.soundUrl) throw new InputError("Enter the address of the sound, or pick another sound.");
    if (input.quietFrom !== undefined || input.quietTo !== undefined) {
      const from = input.quietFrom === undefined ? d.quietFrom : input.quietFrom;
      const to = input.quietTo === undefined ? d.quietTo : input.quietTo;
      if (from === null && to === null) {
        d.quietFrom = d.quietTo = null;
      } else {
        if (!isClockTime(from) || !isClockTime(to)) throw new InputError("Pick when quiet hours start and end.");
        if (from === to) throw new InputError("Quiet hours need to start and end at different times.");
        d.quietFrom = from;
        d.quietTo = to;
      }
    }
    if (input.newAddress === true || (d.enabled && !d.token)) d.token = newToken();
    if (d.enabled && !d.playerIds.length) throw new InputError("Pick at least one speaker for the doorbell.");
    return d;
  }

  /** After a successful Sonos sign-in: adopt the household and discover its speakers. */
  async adoptHousehold(): Promise<void> {
    await this.change(async (st, now) => {
      const c = st.config;
      try {
        const households = await this.d.sonos.households();
        if (!c.householdId || !households.some((h) => h.id === c.householdId)) {
          if (c.householdId) c.speakers = {};
          c.householdId = households[0]?.id ?? null;
        }
        this.note(st, "info", "Sonos connected.");
        if (!c.householdId) this.note(st, "warn", "That Sonos account has no system set up on it.");
        await this.watch(st, now, true);
      } catch (e) {
        this.note(st, "warn", `Sonos connected, but its speakers could not be listed: ${why(e)}.`);
      }
    });
  }

  /** After Sonos is disconnected on purpose: there is nothing left to watch. */
  async forgetHousehold(): Promise<void> {
    await this.change(async (st) => {
      st.health = { checkedAt: null, problems: [] };
      for (const sp of Object.values(st.config.speakers)) sp.online = false;
      this.note(st, "info", "Sonos disconnected.");
    });
  }

  // ------------------------------------------------------------ the doorbell

  /** When the doorbell last made the speakers ring. In memory: losing it on a restart is harmless. */
  private rangAt = -Infinity;

  /**
   * Someone called the doorbell's address. Its secret is the only check, since a
   * doorbell cannot sign in. Answers the caller in a sentence.
   *
   * The ring itself skips the queue every other change waits in: a visitor
   * should not wait behind the watcher's questions to Sonos. It only reads the
   * settings, and its result is written down afterwards like any other change.
   */
  async doorbell(token: string, method: string, origin: string): Promise<{ status: number; text: string }> {
    const c = (await this.load()).config;
    const d = c.doorbell;
    if (!d.token || !(await sameSecret(token, d.token))) return { status: 404, text: "Not found." };
    const now = this.d.now();
    if (method !== "POST") {
      // Never ring for a GET: link previews and browsers fetch addresses they are shown.
      await this.record({ at: now, level: "warn", text: `Something opened the doorbell's address without ringing it (a ${method}). If that was Protect, set its webhook to POST.` });
      return { status: 405, text: "This address rings the doorbell with a POST." };
    }
    if (!d.enabled) {
      await this.record({ at: now, level: "info", text: "The doorbell rang, but it is switched off here." });
      return { status: 200, text: "The doorbell is switched off in House Alarm." };
    }
    if (now - this.rangAt < RING_GAP_MS) return { status: 200, text: "Already ringing." };
    this.rangAt = now;
    const ring = await this.ring(c, origin, now, "Doorbell");
    await this.record(ring, ring.level === "error");
    return { status: 200, text: ring.text };
  }

  /** Ring the speakers from the page, just as the doorbell would ring them right now. */
  async testDoorbell(origin: string): Promise<string> {
    const c = (await this.load()).config;
    if (!c.doorbell.playerIds.length) throw new InputError("Pick at least one speaker for the doorbell first.");
    const now = this.d.now();
    if (now - this.rangAt < RING_GAP_MS) return "Already ringing.";
    this.rangAt = now;
    const ring = await this.ring(c, origin, now, "Test ring");
    await this.record(ring);
    return ring.text;
  }

  private async ring(c: Config, origin: string, now: number, what: string): Promise<Ring> {
    const d = c.doorbell;
    const quiet = inQuietHours(d, now, c.timezone);
    const volume = quiet ? d.quietVolume : d.volume;
    if (volume <= 0) return { at: now, level: "info", text: `${what}: quiet hours, so the speakers stayed silent.` };

    const known = d.playerIds.map((id) => c.speakers[id]).filter((sp): sp is Speaker => Boolean(sp));
    const able = known.filter((sp) => sp.canChime);
    const url = d.sound === "dingdong" ? origin + DINGDONG_PATH : d.sound === "url" ? (d.soundUrl ?? undefined) : undefined;
    type Result = { sp: Speaker; ok: boolean; why?: string; fellBack?: string };
    const results = await Promise.all(
      able.map(async (sp): Promise<Result> => {
        const level = trimmed(volume, sp.trim);
        try {
          await this.d.sonos.chime(sp.id, level, url);
          return { sp, ok: true };
        } catch (e) {
          if (!url) return { sp, ok: false, why: why(e) };
          // Sonos would not take the sound: its own chime is better than nothing.
          return this.d.sonos.chime(sp.id, level).then(
            () => ({ sp, ok: true, fellBack: why(e) }),
            () => ({ sp, ok: false, why: why(e) }),
          );
        }
      }),
    );

    const rang = results.filter((r) => r.ok).map((r) => r.sp.name);
    const failed = results.filter((r) => !r.ok);
    const fellBack = results.find((r) => r.fellBack)?.fellBack;
    const cannot = known.filter((sp) => !sp.canChime).map((sp) => sp.name);
    const parts = [
      rang.length
        ? `${what}: rang on ${list(rang)} at ${volume}${quiet ? " (quiet hours)" : ""}.`
        : `${what}: no speaker played it.`,
      fellBack && `Sonos would not play the doorbell sound (${fellBack}), so it played its own chime instead.`,
      ...failed.map((r) => `${r.sp.name} did not: ${r.why}.`),
      cannot.length && `${list(cannot)} cannot play doorbell sounds.`,
      !known.length && "Pick the speakers it rings on in Settings.",
    ];
    const level = !rang.length ? "error" : failed.length || cannot.length || fellBack ? "warn" : "info";
    return { at: now, level, text: parts.filter(Boolean).join(" ") };
  }

  /** Write a ring into the doorbell's history, and trouble into the activity log too. */
  private async record(ring: Ring, alert = false): Promise<void> {
    await this.change(async (st) => {
      st.rings.unshift(ring);
      if (st.rings.length > RING_LIMIT) st.rings.length = RING_LIMIT;
      if (ring.level !== "info") this.note(st, ring.level, ring.text, alert);
    });
  }

  // ------------------------------------------------------------ reading

  async getState(): Promise<Record<string, unknown>> {
    const st = await this.load();
    const now = this.d.now();
    const tz = st.config.timezone;
    const today = localDate(now, tz);
    const alarms = st.alarms.map((a) => ({ ...a, nextAt: this.next(a, st) }));
    const upcoming = alarms.filter((a) => a.nextAt !== null).sort((a, b) => a.nextAt! - b.nextAt!)[0];
    const away = st.config.vacations.find((v) => today >= v.from && today <= v.to);
    const s = st.session;
    return {
      now,
      today,
      tomorrow: addDays(today, 1),
      config: st.config,
      alarms,
      next: upcoming ? { alarmId: upcoming.id, label: upcoming.label, at: upcoming.nextAt } : null,
      away: away ?? null,
      session: s && {
        alarmId: s.alarmId,
        label: s.label,
        test: s.test,
        phase: s.phase,
        startedAt: s.startedAt,
        snoozeUntil: s.snoozeUntil ?? null,
        playing: s.playing,
        speakers: s.ringing.map((id) => this.name(st, id)),
        // 0 = as planned, 1 = retrying, 2 = backup music, 3 = chime.
        stage: s.stage,
        confirmed: s.confirmed,
        volume: s.ringing.some((id) => s.levels[id] && !s.levels[id]!.fixed) ? (s.level ?? null) : null,
        targetVolume: s.fadeTo,
        endAt: s.autoStop ? s.endAt : null,
      },
      health: st.health,
      log: st.log,
      rings: st.rings,
    };
  }

  /** The Sonos Favorites an alarm can play, read live. */
  async favorites(): Promise<{ id: string; name: string; service: string }[]> {
    const st = await this.load();
    if (!st.config.householdId) return [];
    const favorites = await this.d.sonos.favorites(st.config.householdId);
    return favorites.map((f) => ({ id: f.id, name: f.name, service: f.service?.name ?? "" }));
  }
}
