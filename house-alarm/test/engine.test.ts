import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GRACE_MS, InputError, type Alarm, type Config, type Health, type Session } from "../src/engine";
import { SonosError, type Group, type SonosClient, type Store } from "../src/sonos";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const LA = "America/Los_Angeles";
const at = (s: string) => Date.parse(s);

const NAMES: Record<string, string> = { P1: "House", P2: "Kitchen", P3: "Office" };
const IDLE = "PLAYBACK_STATE_IDLE";
const PLAYING = "PLAYBACK_STATE_PLAYING";
const PAUSED = "PLAYBACK_STATE_PAUSED";

interface FakeGroup {
  id: string;
  coordinatorId: string;
  playerIds: string[];
  state: string;
  loaded: string | null;
}

/** A Sonos household of three speakers, which behaves the way the tests tell it to. */
class FakeSonos implements SonosClient {
  /** Everything it was asked to change, in order. Questions are not recorded. */
  calls: string[] = [];
  private seq = 0;
  /** The household's groups as they really are. (`groups()` below is what Sonos reports.) */
  house: FakeGroup[] = ["P1", "P2", "P3"].map((id) => this.make([id]));
  volume: Record<string, number> = { P1: 20, P2: 16, P3: 12 };
  fixed = new Set<string>();
  offline = new Set<string>();
  cannotChime = new Set<string>();
  favoriteIds = ["wake", "radio"];
  /** Favorites that load without error but never produce sound. */
  silent = new Set<string>();
  /** Favorites Sonos refuses outright. */
  refused = new Set<string>();
  down = false;
  signedOut = false;
  groupingBroken = false;
  /**
   * Like the real thing, `groups()` goes on reporting the old arrangement for this
   * many reads after a grouping change. (Commands see the new one at once.)
   */
  lag = 0;
  private stale: { house: FakeGroup[]; reads: number } | null = null;

  private make(ids: string[]): FakeGroup {
    // Like the real thing, a group keeps its id while its coordinator stays in it;
    // a group that is created, or loses its coordinator, gets a new one.
    return { id: `G${++this.seq}`, coordinatorId: ids[0]!, playerIds: [...ids], state: IDLE, loaded: null };
  }
  /** Called before any grouping change, to start the lag. */
  private regrouping() {
    if (this.lag > 0 && !this.stale) this.stale = { house: structuredClone(this.house), reads: this.lag };
  }
  private check() {
    if (this.signedOut) throw new SonosError(401, "RECONNECT", "Sonos needs to be reconnected");
    if (this.down) throw new SonosError(504, "TIMEOUT", "Sonos took too long to answer");
  }
  private group(id: string): FakeGroup {
    this.check();
    const g = this.house.find((x) => x.id === id && x.playerIds.some((p) => !this.offline.has(p)));
    if (!g) throw new SonosError(410, "ERROR_RESOURCE_GONE", "group is gone");
    return g;
  }
  private player(id: string) {
    this.check();
    if (this.offline.has(id)) throw new SonosError(410, "ERROR_RESOURCE_GONE", "player is gone");
  }
  private detach(ids: string[]) {
    const next: FakeGroup[] = [];
    for (const g of this.house) {
      if (!g.playerIds.some((p) => ids.includes(p))) {
        next.push(g);
        continue;
      }
      const rest = g.playerIds.filter((p) => !ids.includes(p));
      if (!rest.length) continue;
      const keepsLead = rest.includes(g.coordinatorId);
      next.push(keepsLead ? { ...g, playerIds: [g.coordinatorId, ...rest.filter((p) => p !== g.coordinatorId)] } : this.make(rest));
    }
    this.house = next;
  }
  private names = (ids: string[]) => ids.map((p) => NAMES[p]).join(",");

  count(prefix: string) {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }
  /** The household's grouping, as sorted lists of names. */
  layout() {
    return this.house.map((g) => g.playerIds.map((p) => NAMES[p]).sort().join("+")).sort();
  }
  groupOf(player: string) {
    return this.house.find((g) => g.playerIds.includes(player))!;
  }
  /** Rearrange the household directly, as if from the Sonos app. */
  arrange(...sets: string[][]) {
    this.house = sets.map((ids) => this.make(ids));
  }

  async households() {
    this.check();
    return [{ id: "H1" }];
  }
  async groups() {
    this.check();
    let house = this.house;
    if (this.stale) {
      // The old membership, with what each group is doing now.
      house = this.stale.house.map((g) => ({ ...g, state: this.house.find((h) => h.id === g.id)?.state ?? g.state }));
      if (--this.stale.reads <= 0) this.stale = null;
    }
    const groups: Group[] = house
      .map((g) => ({ ...g, playerIds: g.playerIds.filter((p) => !this.offline.has(p)) }))
      .filter((g) => g.playerIds.length)
      .map((g) => ({
        id: g.id,
        name: this.names(g.playerIds),
        coordinatorId: g.playerIds.includes(g.coordinatorId) ? g.coordinatorId : g.playerIds[0]!,
        playbackState: g.state,
        playerIds: g.playerIds,
      }));
    const players = Object.keys(NAMES)
      .filter((p) => !this.offline.has(p))
      .map((p) => ({ id: p, name: NAMES[p]!, capabilities: this.cannotChime.has(p) ? ["PLAYBACK"] : ["PLAYBACK", "AUDIO_CLIP"] }));
    return { groups, players };
  }
  async favorites() {
    this.check();
    return this.favoriteIds.map((id) => ({ id, name: id === "wake" ? "Wake Up" : "KEXP", service: { name: id === "wake" ? "Spotify" : "TuneIn" } }));
  }
  async createGroup(_household: string, playerIds: string[]) {
    this.check();
    if (this.groupingBroken) throw new SonosError(500, "ERROR_COMMAND_FAILED", "could not group");
    const ids = playerIds.filter((p) => !this.offline.has(p));
    this.regrouping();
    this.detach(ids);
    const g = this.make(ids);
    this.house.push(g);
    this.calls.push(`group[${this.names(ids)}]`);
    return { id: g.id, name: this.names(ids), coordinatorId: g.coordinatorId, playerIds: g.playerIds };
  }
  async setGroupMembers(groupId: string, playerIds: string[]) {
    const g = this.group(groupId);
    if (!playerIds.includes(g.coordinatorId)) throw new SonosError(400, "ERROR_INVALID_PARAMETER", "the coordinator must stay");
    const dropped = g.playerIds.filter((p) => !playerIds.includes(p));
    this.regrouping();
    this.detach([...playerIds, ...dropped]);
    const made: FakeGroup = { ...g, playerIds: [g.coordinatorId, ...playerIds.filter((p) => p !== g.coordinatorId)] };
    this.house.push(made, ...dropped.map((p) => this.make([p])));
    this.calls.push(`members[${this.names(made.playerIds)}]`);
    return { id: made.id, name: this.names(made.playerIds), coordinatorId: made.coordinatorId, playerIds: made.playerIds };
  }
  async nowPlaying(groupId: string) {
    const g = this.group(groupId);
    return g.loaded === "wake" ? "Wake Up · Here Comes the Sun — The Beatles" : g.loaded ? "KEXP" : null;
  }
  async loadFavorite(groupId: string, favoriteId: string, opts: { shuffle: boolean }) {
    const g = this.group(groupId);
    const levels = g.playerIds.map((p) => this.volume[p]).join(",");
    this.calls.push(`load:${favoriteId}:${opts.shuffle ? "shuffle" : "inorder"}[${this.names(g.playerIds)}]@${levels}`);
    if (this.refused.has(favoriteId)) throw new SonosError(500, "ERROR_COMMAND_FAILED", "could not load");
    if (this.silent.has(favoriteId)) return;
    g.loaded = favoriteId;
    g.state = PLAYING;
  }
  async play(groupId: string) {
    const g = this.group(groupId);
    this.calls.push(`play[${this.names(g.playerIds)}]`);
    if (!g.loaded) throw new SonosError(400, "ERROR_PLAYBACK_NO_CONTENT", "nothing to play");
    g.state = PLAYING;
  }
  async pause(groupId: string) {
    const g = this.group(groupId);
    this.calls.push(`pause[${this.names(g.playerIds)}]`);
    if (g.state === PLAYING) g.state = PAUSED;
  }
  async playbackState(groupId: string) {
    return this.group(groupId).state;
  }
  async getVolume(playerId: string) {
    this.player(playerId);
    return { volume: this.volume[playerId]!, muted: false, fixed: this.fixed.has(playerId) };
  }
  async setVolume(playerId: string, volume: number) {
    this.player(playerId);
    if (this.fixed.has(playerId)) throw new SonosError(500, "ERROR_COMMAND_FAILED", "fixed volume");
    this.calls.push(`vol:${NAMES[playerId]}:${volume}`);
    this.volume[playerId] = volume;
  }
  async chime(playerId: string, volume: number) {
    this.player(playerId);
    this.calls.push(`chime:${NAMES[playerId]}@${volume}`);
  }
}

let now: number;
let wake: number;
let data: Map<string, unknown>;
let sonos: FakeSonos;
let engine: Engine;
let alerts: string[];
let ids: number;

const store: Store = {
  get: async <T>(k: string) => structuredClone(data.get(k)) as T | undefined,
  put: async (k, v) => void data.set(k, structuredClone(v)),
  delete: async (k) => void data.delete(k),
};

/** Let time pass, waking the engine exactly when it asked to be woken. */
async function runTo(until: number) {
  let guard = 0;
  while (wake <= until) {
    if (++guard > 20000) throw new Error("the engine is waking in a tight loop");
    now = Math.max(now, wake);
    await engine.tick();
  }
  now = until;
}
const runFor = (ms: number) => runTo(now + ms);

/** When the engine says the next alarm will ring. (`wake` may be sooner: it also wakes for the watcher.) */
const nextRing = async () => ((await engine.getState()) as { next: { at: number } | null }).next?.at ?? null;
const session = () => data.get("session") as Session | undefined;
const alarms = () => data.get("alarms") as Alarm[];
const config = () => data.get("config") as Config;
const problems = () => (data.get("health") as Health).problems.map((p) => p.key).sort();
const logText = () => (data.get("log") as { text: string }[]).map((l) => l.text).join("\n");
const volumes = (name = "House") => sonos.calls.filter((c) => c.startsWith(`vol:${name}:`)).map((c) => Number(c.split(":")[2]));

/** An alarm on the one speaker that feeds the whole house. */
const WEEKDAYS = {
  label: "Weekdays",
  time: "06:45",
  days: [1, 2, 3, 4, 5],
  playerIds: ["P1"],
  favoriteId: "wake",
  favoriteName: "Wake Up",
  volume: 30,
  startVolume: 5,
  fadeMinutes: 5,
  shuffle: true,
};
const EVERYWHERE = { ...WEEKDAYS, label: "Everyone up", playerIds: ["P1", "P2", "P3"] };
// Thursday 12 November 2026, 8 pm in Los Angeles.
const THURSDAY_EVENING = at("2026-11-13T04:00:00Z");
const FRIDAY_0645 = at("2026-11-13T14:45:00Z");
const MONDAY_0645 = at("2026-11-16T14:45:00Z");

beforeEach(async () => {
  now = THURSDAY_EVENING;
  wake = Infinity;
  ids = 0;
  alerts = [];
  data = new Map();
  sonos = new FakeSonos();
  engine = new Engine({
    store,
    sonos,
    now: () => now,
    setWake: async (t) => void (wake = t),
    notify: async (_url, message) => void alerts.push(message),
    newId: () => `id${++ids}`,
  });
  await engine.adoptHousehold();
  await engine.updateConfig({ timezone: LA, notifyUrl: "https://ntfy.example/house" });
});

describe("an ordinary morning", () => {
  it("fades in, keeps playing, then stops itself and puts the volume back", async () => {
    await engine.createAlarm(WEEKDAYS);
    expect(await nextRing()).toBe(FRIDAY_0645);

    await runTo(FRIDAY_0645 - 1);
    expect(sonos.calls).toEqual([]);

    await runTo(FRIDAY_0645);
    // Quiet first, then music. The speaker was already on its own, so no regrouping.
    expect(sonos.calls).toEqual(["vol:House:5", "load:wake:shuffle[House]@5"]);
    expect(session()?.phase).toBe("ringing");

    await runFor(5 * MIN + 10 * SEC);
    const v = volumes();
    expect(v[0]).toBe(5);
    expect(v.at(-1)).toBe(30);
    expect(v).toEqual([...v].sort((a, b) => a - b));
    expect(new Set(v).size).toBe(v.length);
    expect(Math.max(...v.slice(1).map((x, i) => x - v[i]!))).toBeLessThanOrEqual(3);
    expect(session()?.confirmed).toBe(true);
    expect(sonos.count("load")).toBe(1);

    await runTo(FRIDAY_0645 + 59 * MIN);
    expect(session()).toBeDefined();
    expect(sonos.count("pause")).toBe(0);

    await runTo(FRIDAY_0645 + 60 * MIN);
    expect(session()).toBeUndefined();
    expect(sonos.calls.slice(-2)).toEqual(["pause[House]", "vol:House:20"]);
    expect(sonos.groupOf("P1").state).toBe(PAUSED);
    expect(wake).toBeGreaterThan(now);
    expect(alerts).toEqual([]);

    // And it rings again on Monday, not over the weekend.
    sonos.calls = [];
    await runTo(MONDAY_0645 - 1);
    expect(sonos.calls).toEqual([]);
    await runTo(MONDAY_0645);
    expect(sonos.count("load")).toBe(1);
  });

  it("does not ring twice if woken twice", async () => {
    await engine.createAlarm(WEEKDAYS);
    now = FRIDAY_0645;
    await Promise.all([engine.tick(), engine.tick()]);
    await engine.tick();
    expect(sonos.count("load")).toBe(1);
  });

  it("starts at full alarm volume when there is no fade", async () => {
    await engine.createAlarm({ ...WEEKDAYS, fadeMinutes: 0 });
    await runTo(FRIDAY_0645 + 2 * MIN);
    expect(volumes()).toEqual([30]);
  });

  it("plays in order when shuffle is off", async () => {
    await engine.createAlarm({ ...WEEKDAYS, shuffle: false });
    await runTo(FRIDAY_0645);
    expect(sonos.calls).toContain("load:wake:inorder[House]@5");
  });

  it("leaves the music on when auto-stop is off", async () => {
    await engine.updateConfig({ autoStopMinutes: 0 });
    await engine.createAlarm(WEEKDAYS);
    await runTo(FRIDAY_0645 + 4 * HOUR);
    expect(session()).toBeUndefined();
    expect(sonos.count("pause")).toBe(0);
    expect(sonos.groupOf("P1").state).toBe(PLAYING);
  });
});

describe("several speakers", () => {
  it("groups them for the alarm, fades them together, and puts everything back", async () => {
    await engine.createAlarm(EVERYWHERE);
    await runTo(FRIDAY_0645);
    expect(sonos.calls[0]).toBe("group[House,Kitchen,Office]");
    expect(sonos.calls.slice(1, 4).sort()).toEqual(["vol:House:5", "vol:Kitchen:5", "vol:Office:5"]);
    expect(sonos.calls[4]).toBe("load:wake:shuffle[House,Kitchen,Office]@5,5,5");
    expect(sonos.layout()).toEqual(["House+Kitchen+Office"]);

    await runFor(6 * MIN);
    expect(sonos.volume).toEqual({ P1: 30, P2: 30, P3: 30 });
    expect(((await engine.getState()) as any).session.speakers).toEqual(["House", "Kitchen", "Office"]);

    sonos.calls = [];
    await engine.stop();
    expect(sonos.calls[0]).toBe("pause[House,Kitchen,Office]");
    expect(sonos.volume).toEqual({ P1: 20, P2: 16, P3: 12 });
    expect(sonos.layout()).toEqual(["House", "Kitchen", "Office"]);
  });

  it("leaves the grouping alone when it is already right", async () => {
    sonos.arrange(["P1", "P2", "P3"]);
    await engine.createAlarm(EVERYWHERE);
    await runTo(FRIDAY_0645 + 6 * MIN);
    await engine.stop();
    expect(sonos.count("group")).toBe(0);
    expect(sonos.count("members")).toBe(0);
    expect(sonos.layout()).toEqual(["House+Kitchen+Office"]);
  });

  it("rings on only the speakers the alarm names", async () => {
    await engine.createAlarm({ ...WEEKDAYS, playerIds: ["P2", "P3"] });
    await runTo(FRIDAY_0645 + 6 * MIN);
    expect(sonos.layout()).toEqual(["House", "Kitchen+Office"]);
    expect(sonos.volume).toEqual({ P1: 20, P2: 30, P3: 30 });
    expect(sonos.groupOf("P1").state).toBe(IDLE);
  });

  it("gives a borrowed speaker back without disturbing the music it left", async () => {
    // The office is playing the radio, with the house speaker tagging along.
    sonos.arrange(["P3", "P1"], ["P2"]);
    Object.assign(sonos.groupOf("P3"), { state: PLAYING, loaded: "radio" });
    await engine.createAlarm({ ...WEEKDAYS, playerIds: ["P1", "P2"] });
    await runTo(FRIDAY_0645 + 6 * MIN);
    expect(sonos.layout()).toEqual(["House+Kitchen", "Office"]);
    expect(sonos.groupOf("P3")).toMatchObject({ state: PLAYING, loaded: "radio" });

    await engine.stop();
    expect(sonos.layout()).toEqual(["House+Office", "Kitchen"]);
    expect(sonos.groupOf("P3")).toMatchObject({ state: PLAYING, loaded: "radio", coordinatorId: "P3" });
  });

  it("keeps the alarm's grouping when dismissed, since the music plays on", async () => {
    await engine.createAlarm(EVERYWHERE);
    await runTo(FRIDAY_0645 + 6 * MIN);
    await engine.dismiss();
    expect(sonos.layout()).toEqual(["House+Kitchen+Office"]);
    expect(sonos.groupOf("P1").state).toBe(PLAYING);
  });

  it("rings without a speaker that is offline, and says so", async () => {
    await engine.createAlarm(EVERYWHERE);
    await runTo(FRIDAY_0645 - 30 * SEC);
    alerts = [];
    sonos.offline.add("P3");
    await runTo(FRIDAY_0645 + 6 * MIN);
    expect(sonos.calls[0]).toBe("group[House,Kitchen]");
    expect(sonos.volume).toMatchObject({ P1: 30, P2: 30, P3: 12 });
    expect(session()?.confirmed).toBe(true);
    expect(alerts).toContain('Office is offline, so "Everyone up" is ringing without it.');
  });

  it("fails loudly when every speaker is offline", async () => {
    await engine.createAlarm(EVERYWHERE);
    await runTo(FRIDAY_0645 - 30 * SEC);
    sonos.offline = new Set(["P1", "P2", "P3"]);
    await runTo(FRIDAY_0645 + 3 * MIN);
    expect(session()).toBeUndefined();
    expect(logText()).toContain("none of its speakers are online");
    expect(alerts.join("\n")).toContain('"Everyone up" failed');
  });

  it("still rings if Sonos refuses to regroup", async () => {
    sonos.groupingBroken = true;
    await engine.createAlarm(EVERYWHERE);
    await runTo(FRIDAY_0645 + MIN);
    expect(sonos.count("load:wake")).toBe(1);
    expect(session()?.confirmed).toBe(true);
    expect(logText()).toContain("Could not group the speakers together");
  });

  it("scales each speaker by its trim", async () => {
    await engine.manage("trim", { id: "P2", trim: 50 });
    await engine.createAlarm({ ...EVERYWHERE, startVolume: 10 });
    await runTo(FRIDAY_0645);
    expect(sonos.volume).toEqual({ P1: 10, P2: 5, P3: 10 });
    await runFor(6 * MIN);
    expect(sonos.volume).toEqual({ P1: 30, P2: 15, P3: 30 });
  });

  it("chimes on every speaker when no music will start", async () => {
    await engine.createAlarm(EVERYWHERE);
    sonos.silent.add("wake");
    await runTo(FRIDAY_0645 + 2 * MIN);
    expect(session()?.stage).toBe(3);
    expect(sonos.count("chime:House@30")).toBeGreaterThan(1);
    expect(sonos.count("chime:Kitchen@30")).toBeGreaterThan(1);
    expect(sonos.count("chime:Office@30")).toBeGreaterThan(1);
  });
});

describe("when the music will not start", () => {
  it("tries again, then plays the backup, still fading in from quiet", async () => {
    await engine.updateConfig({ backupFavoriteId: "radio", backupFavoriteName: "KEXP" });
    await engine.createAlarm(WEEKDAYS);
    sonos.silent.add("wake");

    await runTo(FRIDAY_0645 + 44 * SEC);
    expect(sonos.count("load")).toBe(1);
    await runTo(FRIDAY_0645 + 46 * SEC);
    expect(sonos.count("load:wake")).toBe(2);
    await runTo(FRIDAY_0645 + 80 * SEC);
    // The fade waits for sound: the backup comes in at the starting volume, not part-way up.
    expect(sonos.calls).toContain("load:radio:shuffle[House]@5");
    await runFor(10 * SEC);
    expect(session()).toMatchObject({ stage: 2, confirmed: true, playing: "KEXP" });
    expect(logText()).toContain('Playing the backup, "KEXP"');
    expect(alerts.join("\n")).toContain('Playing the backup, "KEXP"');

    await runTo(FRIDAY_0645 + 7 * MIN);
    expect(sonos.volume.P1).toBe(30);
    expect(sonos.count("chime")).toBe(0);
  });

  it("recovers on the second try without touching the backup", async () => {
    await engine.updateConfig({ backupFavoriteId: "radio", backupFavoriteName: "KEXP" });
    await engine.createAlarm(WEEKDAYS);
    sonos.silent.add("wake");
    await runTo(FRIDAY_0645 + 40 * SEC);
    sonos.silent.clear();
    await runTo(FRIDAY_0645 + 3 * MIN);
    expect(sonos.count("load:wake")).toBe(2);
    expect(sonos.count("load:radio")).toBe(0);
    expect(session()).toMatchObject({ stage: 1, confirmed: true });
    expect(alerts).toEqual([]);
  });

  it("sounds the chime when nothing else works, alerts, then gives up", async () => {
    await engine.updateConfig({ backupFavoriteId: "radio", backupFavoriteName: "KEXP" });
    await engine.createAlarm(WEEKDAYS);
    sonos.silent.add("wake").add("radio");

    await runTo(FRIDAY_0645 + 2 * MIN);
    expect(session()?.stage).toBe(3);
    expect(sonos.count("chime:House@30")).toBeGreaterThan(1);
    expect(alerts).toContain('No music would start for "Weekdays". Sounding the Sonos chime instead.');
    const soFar = sonos.count("chime");
    await runFor(MIN);
    expect(sonos.count("chime") - soFar).toBeGreaterThanOrEqual(8);

    await runTo(FRIDAY_0645 + 8 * MIN);
    expect(session()).toBeUndefined();
    expect(logText()).toContain("gave up");
  });

  it("goes straight from the retry to the chime with no backup set", async () => {
    await engine.createAlarm(WEEKDAYS);
    sonos.refused.add("wake");
    await runTo(FRIDAY_0645 + 9 * SEC);
    expect(sonos.count("load:wake")).toBe(1);
    await runTo(FRIDAY_0645 + 11 * SEC); // a refusal is retried sooner than silence
    expect(sonos.count("load:wake")).toBe(2);
    await runTo(FRIDAY_0645 + 45 * SEC);
    expect(session()?.stage).toBe(3);
    expect(sonos.count("chime")).toBeGreaterThan(0);
  });

  it("says so plainly when the speaker cannot even chime", async () => {
    await engine.createAlarm(WEEKDAYS);
    sonos.silent.add("wake");
    sonos.cannotChime.add("P1");
    await runTo(FRIDAY_0645 + 2 * MIN);
    expect(session()).toBeUndefined();
    expect(sonos.count("chime")).toBe(0);
    expect(logText()).toContain("cannot play the chime");
  });

  it("rides out Sonos being unreachable at the start", async () => {
    await engine.createAlarm(WEEKDAYS);
    await runTo(FRIDAY_0645 - 30 * SEC);
    sonos.down = true;
    await runTo(FRIDAY_0645 + 10 * SEC);
    expect(sonos.calls).toEqual([]);
    sonos.down = false;
    await runTo(FRIDAY_0645 + 30 * SEC);
    // Still quiet before music, even though the first attempt never got that far.
    expect(sonos.calls.slice(0, 2)).toEqual(["vol:House:5", "load:wake:shuffle[House]@5"]);
    await runFor(MIN);
    expect(session()?.confirmed).toBe(true);
  });

  it("finds the group again when Sonos has renumbered it", async () => {
    await engine.createAlarm(WEEKDAYS);
    await runTo(FRIDAY_0645 + MIN);
    sonos.groupOf("P1").id = "G-renumbered";
    await engine.stop();
    expect(sonos.count("pause")).toBe(1);
    expect(session()).toBeUndefined();
  });

  it("logs a miss rather than ringing very late", async () => {
    await engine.createAlarm(WEEKDAYS);
    now = FRIDAY_0645 + GRACE_MS + MIN;
    await engine.tick();
    expect(sonos.calls).toEqual([]);
    expect(logText()).toContain('Missed "Weekdays": the clock woke 11 minutes late.');
    expect(alerts.join("\n")).toContain('Missed "Weekdays"');
    expect(await nextRing()).toBe(MONDAY_0645);
  });

  it("still rings a few minutes late", async () => {
    await engine.createAlarm(WEEKDAYS);
    now = FRIDAY_0645 + GRACE_MS - MIN;
    await engine.tick();
    expect(sonos.count("load")).toBe(1);
  });
});

describe("the buttons", () => {
  beforeEach(async () => {
    await engine.createAlarm(WEEKDAYS);
    await runTo(FRIDAY_0645 + 6 * MIN);
    sonos.calls = [];
  });

  it("stop pauses the music and puts the volume back", async () => {
    expect(await engine.stop()).toEqual({ ok: true });
    expect(sonos.calls).toEqual(["pause[House]", "vol:House:20"]);
    expect(session()).toBeUndefined();
    await runFor(2 * HOUR);
    expect(sonos.calls).toEqual(["pause[House]", "vol:House:20"]);
  });

  it("stop is honest when Sonos does not confirm the pause", async () => {
    sonos.down = true;
    expect(await engine.stop()).toEqual({ ok: false });
    expect(session()).toBeUndefined();
    expect(logText()).toContain("did not confirm the pause");
  });

  it("snooze goes quiet, then comes back and can be stopped", async () => {
    await engine.snooze();
    expect(sonos.calls).toEqual(["pause[House]"]);
    expect(session()).toMatchObject({ phase: "snoozed", snoozeUntil: now + 9 * MIN });
    expect(logText()).toContain("snoozed for 9 minutes");

    await runFor(9 * MIN - SEC);
    expect(sonos.calls).toEqual(["pause[House]"]);
    await runFor(SEC);
    expect(sonos.calls.slice(1, 3)).toEqual(["vol:House:5", "play[House]"]);
    expect(session()?.phase).toBe("ringing");

    // Back up to alarm volume within half a minute or so this time.
    await runFor(40 * SEC);
    expect(sonos.volume.P1).toBe(30);
    expect(session()?.confirmed).toBe(true);

    // The hour before it stops by itself restarts with the snooze.
    await runFor(58 * MIN);
    expect(session()).toBeDefined();
    await engine.stop();
    expect(sonos.calls.slice(-2)).toEqual(["pause[House]", "vol:House:20"]);
  });

  it("reloads the music if it cannot simply resume after a snooze", async () => {
    await engine.snooze();
    Object.assign(sonos.groupOf("P1"), { loaded: null, state: IDLE });
    await runFor(9 * MIN);
    expect(sonos.calls).toContain("load:wake:shuffle[House]@5");
    await runFor(10 * SEC);
    expect(session()?.confirmed).toBe(true);
  });

  it("stopping during a snooze restores the volume without pausing again", async () => {
    await engine.snooze();
    await engine.stop();
    expect(sonos.calls).toEqual(["pause[House]", "vol:House:20"]);
    await runFor(HOUR);
    expect(sonos.count("play")).toBe(0);
  });

  it("dismiss ends the alarm but leaves the music alone", async () => {
    await engine.dismiss();
    expect(session()).toBeUndefined();
    await runFor(2 * HOUR);
    expect(sonos.calls).toEqual([]);
    expect(sonos.groupOf("P1").state).toBe(PLAYING);
    expect(sonos.volume.P1).toBe(30);
  });

  it("test rings the alarm now without disturbing its schedule", async () => {
    await engine.stop();
    sonos.calls = [];
    await engine.testAlarm("id1");
    expect(sonos.calls).toEqual(["vol:House:5", "load:wake:shuffle[House]@5"]);
    expect(session()).toMatchObject({ test: true, phase: "ringing" });
    await engine.stop();
    await runTo(MONDAY_0645);
    expect(sonos.count("load")).toBe(2);
    await expect(engine.testAlarm("nope")).rejects.toBeInstanceOf(InputError);
  });
});

describe("other hands on the Sonos", () => {
  it("stops fading when someone turns the volume down, and leaves it there", async () => {
    await engine.createAlarm(WEEKDAYS);
    await runTo(FRIDAY_0645 + 2 * MIN);
    sonos.volume.P1 = 3;
    sonos.calls = [];
    await runFor(10 * MIN);
    expect(volumes()).toEqual([]);
    expect(logText()).toContain("changed the volume on House by hand");
    await engine.stop();
    expect(sonos.volume.P1).toBe(3);
  });

  it("a hand on one speaker does not stop the others fading", async () => {
    await engine.createAlarm(EVERYWHERE);
    await runTo(FRIDAY_0645 + 2 * MIN);
    sonos.volume.P2 = 2;
    await runFor(6 * MIN);
    expect(sonos.volume).toEqual({ P1: 30, P2: 2, P3: 30 });
  });

  it("notices the music being stopped elsewhere and bows out", async () => {
    await engine.createAlarm(WEEKDAYS);
    await runTo(FRIDAY_0645 + 6 * MIN);
    sonos.groupOf("P1").state = PAUSED;
    sonos.calls = [];
    await runFor(2 * MIN);
    expect(session()).toBeUndefined();
    expect(sonos.calls).toEqual(["vol:House:20"]);
    expect(logText()).toContain("stopped from another app");
    // It must not pause whatever is playing an hour later.
    sonos.groupOf("P1").state = PLAYING;
    await runFor(2 * HOUR);
    expect(sonos.count("pause")).toBe(0);
  });

  it("does not mistake the gap between two tracks for a stop", async () => {
    await engine.createAlarm(WEEKDAYS);
    await runTo(FRIDAY_0645 + 6 * MIN);
    // Idle for a moment, playing again by the next look.
    now = session()!.checkAt;
    sonos.groupOf("P1").state = IDLE;
    await engine.tick();
    sonos.groupOf("P1").state = PLAYING;
    await runFor(5 * MIN);
    expect(session()).toBeDefined();
  });

  it("works on a fixed-volume player: music, but no volume changes", async () => {
    sonos.fixed.add("P1");
    await engine.createAlarm(WEEKDAYS);
    await runTo(FRIDAY_0645 + 10 * MIN);
    expect(volumes()).toEqual([]);
    expect(sonos.count("load")).toBe(1);
    expect(session()?.confirmed).toBe(true);
    expect(logText()).toContain("fixed volume");
    await engine.stop();
    expect(volumes()).toEqual([]);
  });
});

describe("the watcher", () => {
  it("discovers the speakers when Sonos is connected", () => {
    expect(Object.values(config().speakers).map((s) => [s.name, s.online, s.trim])).toEqual([
      ["House", true, 100],
      ["Kitchen", true, 100],
      ["Office", true, 100],
    ]);
    expect(logText()).toContain("Found 3 speakers: House, Kitchen and Office.");
    expect(problems()).toEqual([]);
  });

  it("notices a speaker dropping off, alerts once it has lasted, and reports its return", async () => {
    await engine.createAlarm(EVERYWHERE);
    await runFor(MIN);
    sonos.offline.add("P2");
    await runFor(16 * MIN);
    expect(problems()).toEqual(["offline:P2"]);
    expect(config().speakers.P2).toMatchObject({ online: false });
    expect(logText()).toContain("Kitchen is offline; alarms that use it will ring without it.");
    expect(alerts).toEqual([]); // one sighting could be a blip

    await runFor(6 * MIN); // it looks again sooner while something is wrong
    expect(alerts).toEqual(["Kitchen is offline; alarms that use it will ring without it."]);
    await runFor(HOUR);
    expect(alerts).toHaveLength(1); // and does not nag

    sonos.offline.clear();
    await runFor(6 * MIN);
    expect(problems()).toEqual([]);
    expect(config().speakers.P2).toMatchObject({ online: true });
    expect(alerts).toEqual(["Kitchen is offline; alarms that use it will ring without it.", "Kitchen is back online."]);
  });

  it("stays quiet about a blip", async () => {
    await runFor(MIN);
    sonos.offline.add("P2");
    await runFor(15 * MIN);
    expect(problems()).toEqual(["offline:P2"]);
    sonos.offline.clear();
    await runFor(HOUR);
    expect(problems()).toEqual([]);
    expect(logText()).toContain("Kitchen is back online.");
    expect(alerts).toEqual([]);
  });

  it("warns when an alarm has no speaker left to ring on", async () => {
    await engine.createAlarm(WEEKDAYS);
    await runFor(MIN);
    sonos.offline.add("P1");
    await runFor(16 * MIN);
    expect(problems()).toEqual(["offline:P1", "silent:id1"]);
    await runFor(6 * MIN);
    expect(alerts).toContain('"Weekdays" has no speaker online to ring on.');
  });

  it("warns when an alarm's music has been removed from Sonos Favorites", async () => {
    await engine.updateConfig({ backupFavoriteId: "radio", backupFavoriteName: "KEXP" });
    await engine.createAlarm(WEEKDAYS);
    await runFor(MIN);
    sonos.favoriteIds = [];
    await runFor(16 * MIN);
    expect(problems()).toEqual(["favorite:backup", "favorite:id1"]);
    await runFor(6 * MIN);
    expect(alerts).toContain('"Weekdays" is set to play "Wake Up", which is no longer in your Sonos Favorites.');
    sonos.favoriteIds = ["wake", "radio"];
    await runFor(6 * MIN);
    expect(problems()).toEqual([]);
    expect(alerts).toContain('"Weekdays" has its music back.');
  });

  it("checks a new alarm straight away rather than waiting for its next round", async () => {
    sonos.favoriteIds = ["radio"];
    await engine.createAlarm(WEEKDAYS);
    await runFor(2 * SEC);
    expect(problems()).toEqual(["favorite:id1"]);
  });

  it("warns about a fixed-volume speaker only if an alarm rings on it", async () => {
    sonos.fixed.add("P1").add("P3");
    await engine.createAlarm(WEEKDAYS);
    await runFor(16 * MIN);
    expect(problems()).toEqual(["fixed:P1"]);
    expect(config().speakers).toMatchObject({ P1: { fixed: true }, P2: { fixed: false }, P3: { fixed: true } });
  });

  it("says when Sonos has signed the app out", async () => {
    await runFor(MIN);
    sonos.signedOut = true;
    await runFor(21 * MIN);
    expect(problems()).toEqual(["sonos:auth"]);
    expect(alerts).toEqual(["Sonos has signed this app out, so alarms cannot ring. Reconnect it in Settings."]);
    sonos.signedOut = false;
    await runFor(6 * MIN);
    expect(alerts.at(-1)).toBe("Sonos is connected again.");
  });

  it("keeps what it knew while Sonos's cloud is not answering", async () => {
    await runFor(MIN);
    sonos.offline.add("P3");
    await runFor(16 * MIN);
    sonos.down = true;
    await runFor(6 * MIN);
    expect(problems()).toEqual(["offline:P3", "sonos:unreachable"]);
    sonos.down = false;
    sonos.offline.clear();
    await runFor(6 * MIN);
    expect(problems()).toEqual([]);
    expect(logText()).toContain("Sonos's cloud is answering again.");
  });

  it("takes a look ten minutes before each alarm", async () => {
    await engine.createAlarm(WEEKDAYS);
    await runTo(FRIDAY_0645 - 25 * MIN);
    const before = (data.get("health") as Health).checkedAt!;
    sonos.favoriteIds = ["radio"];
    await runTo(FRIDAY_0645 - 9 * MIN);
    expect((data.get("health") as Health).checkedAt).toBe(FRIDAY_0645 - 10 * MIN);
    expect(before).toBeLessThan(FRIDAY_0645 - 10 * MIN);
    expect(problems()).toEqual(["favorite:id1"]);
  });

  it("does not get in the way of an alarm that is starting", async () => {
    await engine.createAlarm(WEEKDAYS);
    sonos.silent.add("wake");
    await runTo(FRIDAY_0645 - MIN);
    data.set("watchAt", FRIDAY_0645); // the watcher falls due just as the alarm rings
    await runTo(FRIDAY_0645 + 40 * SEC);
    expect((data.get("health") as Health).checkedAt).toBeLessThan(FRIDAY_0645);
    expect(data.get("watchAt")).toBeGreaterThan(FRIDAY_0645 + MIN);
  });

  it("does nothing while Sonos is not connected", async () => {
    data.set("config", { ...config(), householdId: null });
    data.set("watchAt", 0);
    await runFor(DAY());
    expect((data.get("health") as Health).checkedAt).toBeNull();
  });
});
describe("when Sonos is slow to report grouping, as the real one is", () => {
  // On a real system the group list showed a join 11 seconds after Sonos had
  // made it. In these tests every read inside that window sees the old layout.
  beforeEach(() => void (sonos.lag = 50));

  it("puts the speakers back even when the alarm is stopped straight away", async () => {
    await engine.createAlarm(EVERYWHERE);
    await runTo(FRIDAY_0645);
    expect(sonos.layout()).toEqual(["House+Kitchen+Office"]);
    await engine.stop();
    expect(sonos.layout()).toEqual(["House", "Kitchen", "Office"]);
  });

  it("groups the speakers once, and rings on all of them", async () => {
    await engine.createAlarm(EVERYWHERE);
    await runTo(FRIDAY_0645 + 6 * MIN);
    expect(sonos.count("group")).toBe(1);
    expect(sonos.calls.filter((c) => c.startsWith("load:"))).toEqual(["load:wake:shuffle[House,Kitchen,Office]@5,5,5"]);
    expect(sonos.volume).toEqual({ P1: 30, P2: 30, P3: 30 });
  });

  it("shows a join in the Speakers panel at once, and can separate again straight after", async () => {
    const joined = (await engine.manage("join", { id: "P3", groupId: sonos.groupOf("P1").id })) as any;
    expect(joined.groups.map((g: any) => g.playerIds.length).sort()).toEqual([1, 2]);
    expect(joined.speakers.find((sp: any) => sp.name === "Office").groupId).toBe(sonos.groupOf("P1").id);

    const separated = (await engine.manage("separate", {})) as any;
    expect(sonos.layout()).toEqual(["House", "Kitchen", "Office"]);
    expect(separated.groups).toHaveLength(3);
  });
});

const DAY = () => 24 * HOUR;

describe("managing speakers", () => {
  const view = async () => (await engine.speakers()) as any;

  it("shows every speaker with its volume, group and what is playing", async () => {
    sonos.arrange(["P1", "P2"], ["P3"]);
    Object.assign(sonos.groupOf("P1"), { state: PLAYING, loaded: "wake" });
    sonos.offline.add("P3");
    await engine.createAlarm(WEEKDAYS);
    const v = await view();
    expect(v.reachable).toBe(true);
    expect(v.groups).toEqual([
      { id: sonos.groupOf("P1").id, name: "House,Kitchen", state: PLAYING, playing: "Wake Up · Here Comes the Sun — The Beatles", coordinatorId: "P1", playerIds: ["P1", "P2"] },
    ]);
    expect(v.speakers.map((s: any) => [s.name, s.online, s.volume, s.groupId !== null, s.alarms])).toEqual([
      ["House", true, 20, true, 1],
      ["Kitchen", true, 16, true, 0],
      ["Office", false, null, false, 0],
    ]);
    expect(v.health.problems.map((p: any) => p.key)).toEqual(["offline:P3"]);
  });

  it("looking at the panel does not put off the watcher's own rounds", async () => {
    await runFor(MIN);
    const due = data.get("watchAt");
    await view();
    expect(data.get("watchAt")).toBe(due);
  });

  it("sets a speaker's volume", async () => {
    await engine.manage("volume", { id: "P2", volume: 33 });
    expect(sonos.volume.P2).toBe(33);
  });

  it("plays everywhere, carrying the music along, and separates again", async () => {
    Object.assign(sonos.groupOf("P2"), { state: PLAYING, loaded: "radio" });
    let v = (await engine.manage("group-all", {})) as any;
    expect(sonos.layout()).toEqual(["House+Kitchen+Office"]);
    expect(sonos.groupOf("P1")).toMatchObject({ state: PLAYING, loaded: "radio", coordinatorId: "P2" });
    expect(v.groups).toHaveLength(1);

    v = await engine.manage("separate", {});
    expect(sonos.layout()).toEqual(["House", "Kitchen", "Office"]);
    expect(sonos.groupOf("P2")).toMatchObject({ state: PLAYING, loaded: "radio" });
    expect(v.groups).toHaveLength(3);
  });

  it("moves one speaker in and out of a group", async () => {
    await engine.manage("join", { id: "P3", groupId: sonos.groupOf("P1").id });
    expect(sonos.layout()).toEqual(["House+Office", "Kitchen"]);
    await engine.manage("split", { id: "P3" });
    expect(sonos.layout()).toEqual(["House", "Kitchen", "Office"]);
    await expect(engine.manage("join", { id: "P3", groupId: "stale" })).rejects.toBeInstanceOf(InputError);
  });

  it("pauses and plays a group, and pauses everything", async () => {
    Object.assign(sonos.groupOf("P1"), { state: PLAYING, loaded: "wake" });
    Object.assign(sonos.groupOf("P2"), { state: PLAYING, loaded: "radio" });
    await engine.manage("pause", { groupId: sonos.groupOf("P1").id });
    expect(sonos.groupOf("P1").state).toBe(PAUSED);
    await engine.manage("play", { groupId: sonos.groupOf("P1").id });
    expect(sonos.groupOf("P1").state).toBe(PLAYING);
    await engine.manage("pause-all", {});
    expect(sonos.house.map((g) => g.state)).toEqual([PAUSED, PAUSED, IDLE]);
  });

  it("forgets a speaker that has gone for good, and takes it off its alarms", async () => {
    await engine.createAlarm(EVERYWHERE);
    await expect(engine.manage("forget", { id: "P3" })).rejects.toBeInstanceOf(InputError);
    sonos.offline.add("P3");
    await engine.speakers();
    await engine.manage("forget", { id: "P3" });
    expect(Object.keys(config().speakers)).toEqual(["P1", "P2"]);
    expect(alarms()[0]!.playerIds).toEqual(["P1", "P2"]);
    expect(problems()).toEqual([]);
  });

  it("refuses what it does not understand", async () => {
    await expect(engine.manage("explode", {})).rejects.toBeInstanceOf(InputError);
    await expect(engine.manage("volume", { id: "P9", volume: 5 })).rejects.toBeInstanceOf(InputError);
  });
});

describe("alerts", () => {
  it("sends a test alert on request", async () => {
    await engine.testAlert();
    expect(alerts).toEqual(["This is a test from House Alarm. Alerts are working."]);
  });

  it("needs somewhere to send them", async () => {
    await engine.updateConfig({ notifyUrl: "" });
    await expect(engine.testAlert()).rejects.toBeInstanceOf(InputError);
    await expect(engine.updateConfig({ notifyUrl: "ftp://example.com/x" })).rejects.toBeInstanceOf(InputError);
    await expect(engine.updateConfig({ notifyUrl: "not a url" })).rejects.toBeInstanceOf(InputError);
  });

  it("stays silent with no address set, however bad things get", async () => {
    await engine.updateConfig({ notifyUrl: "" });
    await engine.createAlarm(WEEKDAYS);
    sonos.silent.add("wake");
    await runTo(FRIDAY_0645 + 3 * MIN);
    expect(session()?.stage).toBe(3);
    expect(alerts).toEqual([]);
  });
});

describe("schedules", () => {
  it("skips just the next one", async () => {
    await engine.createAlarm(WEEKDAYS);
    await engine.setSkip("id1", true);
    expect(alarms()[0]!.skipDate).toBe("2026-11-13");
    expect(await nextRing()).toBe(MONDAY_0645);
    await runTo(MONDAY_0645 - 1);
    expect(sonos.calls).toEqual([]);
    expect(alarms()[0]!.skipDate).toBeUndefined();
    await runTo(MONDAY_0645);
    expect(sonos.count("load")).toBe(1);
  });

  it("can undo a skip", async () => {
    await engine.createAlarm(WEEKDAYS);
    await engine.setSkip("id1", true);
    await engine.setSkip("id1", false);
    expect(await nextRing()).toBe(FRIDAY_0645);
  });

  it("stays quiet while away and resumes after", async () => {
    await engine.createAlarm(WEEKDAYS);
    await engine.updateConfig({ vacations: [{ from: "2026-11-13", to: "2026-11-17" }] });
    const wednesday = at("2026-11-18T14:45:00Z");
    expect(await nextRing()).toBe(wednesday);
    await runTo(wednesday - 1);
    expect(sonos.calls).toEqual([]);
    await runTo(wednesday);
    expect(sonos.count("load")).toBe(1);
    expect(config().vacations).toEqual([]);
  });

  it("rings a one-time alarm once, then switches it off", async () => {
    const a = await engine.createAlarm({ ...WEEKDAYS, label: "Airport", time: "04:30", days: [] });
    expect(a.onDate).toBe("2026-11-13");
    const due = at("2026-11-13T12:30:00Z");
    await runTo(due);
    expect(sonos.count("load")).toBe(1);
    expect(alarms()[0]!.enabled).toBe(false);
    await engine.stop();
    await runFor(71 * HOUR);
    expect(sonos.count("load")).toBe(1);

    // Switching it back on aims it at the next 4:30.
    const again = await engine.updateAlarm(a.id, { enabled: true });
    expect(again.onDate).toBe("2026-11-16");
  });

  it("does not ring for a time that has already passed when the alarm is saved", async () => {
    now = FRIDAY_0645 + MIN;
    await engine.createAlarm(WEEKDAYS);
    await engine.tick();
    expect(sonos.calls).toEqual([]);
    expect(await nextRing()).toBe(MONDAY_0645);
  });

  it("a disabled alarm never rings; re-enabling picks up from now", async () => {
    const a = await engine.createAlarm({ ...WEEKDAYS, enabled: false });
    await runTo(FRIDAY_0645 + HOUR);
    expect(sonos.calls).toEqual([]);
    await engine.updateAlarm(a.id, { enabled: true });
    await engine.tick();
    expect(sonos.calls).toEqual([]);
    expect(await nextRing()).toBe(MONDAY_0645);
  });

  it("follows a change of time zone without ringing for the past", async () => {
    await engine.createAlarm(WEEKDAYS);
    await engine.updateConfig({ timezone: "America/New_York" });
    expect(await nextRing()).toBe(at("2026-11-13T11:45:00Z"));
    await engine.tick();
    expect(sonos.calls).toEqual([]);
  });

  it("deleting an alarm cancels it", async () => {
    await engine.createAlarm(WEEKDAYS);
    await engine.deleteAlarm("id1");
    await runTo(MONDAY_0645);
    expect(sonos.calls).toEqual([]);
  });

  it("a second alarm takes over from one still ringing", async () => {
    await engine.createAlarm(WEEKDAYS);
    await engine.createAlarm({ ...WEEKDAYS, label: "Second call", time: "07:00", favoriteId: "radio", favoriteName: "KEXP" });
    await runTo(FRIDAY_0645 + 15 * MIN);
    expect(session()).toMatchObject({ label: "Second call", playing: "KEXP" });
    expect(sonos.groupOf("P1").loaded).toBe("radio");
  });
});

describe("input checking", () => {
  it("rejects alarms that make no sense", async () => {
    await expect(engine.createAlarm({ ...WEEKDAYS, time: "7am" })).rejects.toBeInstanceOf(InputError);
    await expect(engine.createAlarm({ ...WEEKDAYS, favoriteId: "" })).rejects.toBeInstanceOf(InputError);
    await expect(engine.createAlarm({ ...WEEKDAYS, playerIds: [] })).rejects.toBeInstanceOf(InputError);
    await expect(engine.createAlarm({ ...WEEKDAYS, playerIds: ["P9"] })).rejects.toBeInstanceOf(InputError);
    await expect(engine.updateAlarm("nope", WEEKDAYS)).rejects.toBeInstanceOf(InputError);
  });

  it("rings everywhere when no speakers are named", async () => {
    const { playerIds: _, ...rest } = WEEKDAYS;
    expect((await engine.createAlarm(rest)).playerIds).toEqual(["P1", "P2", "P3"]);
  });

  it("tidies what it accepts", async () => {
    const a = await engine.createAlarm({
      ...WEEKDAYS,
      label: "  ",
      days: [5, 1, 1, 9, "2"],
      playerIds: ["P2", "P2", "nope"],
      volume: 250,
      startVolume: 500,
      fadeMinutes: 99,
    });
    expect(a).toMatchObject({ label: "Alarm", days: [1, 2, 5], playerIds: ["P2"], volume: 100, startVolume: 100, fadeMinutes: 30 });
  });

  it("rejects bad settings", async () => {
    await expect(engine.updateConfig({ timezone: "Mars/Olympus" })).rejects.toBeInstanceOf(InputError);
    await expect(engine.updateConfig({ vacations: [{ from: "2026-12-24", to: "2026-12-20" }] })).rejects.toBeInstanceOf(InputError);
    await expect(engine.updateConfig({ vacations: [{ from: "2026-02-30", to: "2026-03-01" }] })).rejects.toBeInstanceOf(InputError);
  });
});

describe("what the page is told", () => {
  it("reports the next alarm and the live session", async () => {
    await engine.createAlarm(WEEKDAYS);
    let s = (await engine.getState()) as any;
    expect(s.next).toEqual({ alarmId: "id1", label: "Weekdays", at: FRIDAY_0645 });
    expect(s.session).toBeNull();
    expect(s.health.problems).toEqual([]);
    await runTo(FRIDAY_0645 + 30 * SEC);
    s = await engine.getState();
    expect(s.session).toMatchObject({ phase: "ringing", playing: "Wake Up", speakers: ["House"], targetVolume: 30, stage: 0 });
    expect(s.next.at).toBe(MONDAY_0645);
  });

  it("lists the favorites to choose from", async () => {
    expect(await engine.favorites()).toEqual([
      { id: "wake", name: "Wake Up", service: "Spotify" },
      { id: "radio", name: "KEXP", service: "TuneIn" },
    ]);
  });
});
