// A small client for Sonos's cloud Control API: OAuth tokens plus the handful
// of commands an alarm clock needs. https://docs.sonos.com/docs/control

export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SonosSettings {
  clientId: string;
  clientSecret: string;
  /** Overridable so tests and local development can point at a stand-in. */
  apiBase: string;
  authBase: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Set when Sonos last rejected the refresh token: the owner probably has to sign in again. */
  broken?: boolean;
}

export interface Group {
  id: string;
  name: string;
  coordinatorId: string;
  playbackState?: string;
  playerIds: string[];
}

export interface Player {
  id: string;
  name: string;
  capabilities?: string[];
}

export interface Favorite {
  id: string;
  name: string;
  description?: string;
  service?: { name?: string };
}

export interface Volume {
  volume: number;
  muted: boolean;
  fixed: boolean;
}

export const PLAYING = "PLAYBACK_STATE_PLAYING";
export const BUFFERING = "PLAYBACK_STATE_BUFFERING";

/** The commands the alarm engine uses. Tests supply a fake. */
export interface SonosClient {
  households(): Promise<{ id: string; name?: string }[]>;
  groups(householdId: string): Promise<{ groups: Group[]; players: Player[] }>;
  favorites(householdId: string): Promise<Favorite[]>;
  /** Put exactly these players in a new group of their own. Returns it if Sonos says what it made. */
  createGroup(householdId: string, playerIds: string[]): Promise<Group | null>;
  /** Make an existing group consist of exactly these players. The coordinator must be among them. */
  setGroupMembers(groupId: string, playerIds: string[]): Promise<void>;
  /** A short description of what a group is playing, if Sonos knows. */
  nowPlaying(groupId: string): Promise<string | null>;
  loadFavorite(groupId: string, favoriteId: string, opts: { shuffle: boolean }): Promise<void>;
  play(groupId: string): Promise<void>;
  pause(groupId: string): Promise<void>;
  playbackState(groupId: string): Promise<string>;
  getVolume(playerId: string): Promise<Volume>;
  setVolume(playerId: string, volume: number): Promise<void>;
  chime(playerId: string, volume: number): Promise<void>;
}

export class SonosError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "SonosError";
  }
}

const TIMEOUT_MS = 10_000;
const TOKEN_KEY = "tokens";

function describe(e: unknown): string {
  if (e instanceof Error) return e.name === "TimeoutError" ? "Sonos took too long to answer" : e.message;
  return String(e);
}

export class SonosAuth {
  constructor(
    private settings: SonosSettings,
    private store: Store,
    private now: () => number = Date.now,
  ) {}

  hasCredentials(): boolean {
    return Boolean(this.settings.clientId && this.settings.clientSecret);
  }

  async status(): Promise<{ connected: boolean; broken: boolean }> {
    const t = await this.store.get<Tokens>(TOKEN_KEY);
    return { connected: Boolean(t), broken: Boolean(t?.broken) };
  }

  authorizeUrl(redirectUri: string, state: string): string {
    const q = new URLSearchParams({
      client_id: this.settings.clientId,
      response_type: "code",
      state,
      scope: "playback-control-all",
      redirect_uri: redirectUri,
    });
    return `${this.settings.authBase}/login/v3/oauth?${q}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<void> {
    const t = await this.request({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    if (!t.refresh_token) throw new SonosError(502, "NO_REFRESH_TOKEN", "Sonos did not return a refresh token");
    await this.save(t.access_token, t.refresh_token, t.expires_in);
  }

  async disconnect(): Promise<void> {
    await this.store.delete(TOKEN_KEY);
  }

  /** A usable access token, refreshed first if it is about to expire. */
  async token(forceRefresh = false): Promise<string> {
    const t = await this.store.get<Tokens>(TOKEN_KEY);
    if (!t) throw new SonosError(401, "NOT_CONNECTED", "Sonos is not connected");
    if (!forceRefresh && !t.broken && t.expiresAt - this.now() > 5 * 60_000) return t.accessToken;
    try {
      const r = await this.request({ grant_type: "refresh_token", refresh_token: t.refreshToken });
      // Sonos may or may not rotate the refresh token; keep the old one if it does not.
      // Saving also clears `broken`, so a rejection that was a fluke heals itself.
      await this.save(r.access_token, r.refresh_token || t.refreshToken, r.expires_in);
      return r.access_token;
    } catch (e) {
      if (e instanceof SonosError && (e.status === 400 || e.status === 401)) {
        // Sonos rejected the refresh token. Flag it for the owner, but keep
        // trying on later calls rather than giving up for good.
        await this.store.put(TOKEN_KEY, { ...t, broken: true });
        throw new SonosError(401, "RECONNECT", "Sonos needs to be reconnected");
      }
      // A network blip: the current token may still work, so try it.
      if (!forceRefresh && !t.broken && t.expiresAt > this.now()) return t.accessToken;
      throw e;
    }
  }

  private async save(accessToken: string, refreshToken: string, expiresIn: number): Promise<void> {
    const tokens: Tokens = {
      accessToken,
      refreshToken,
      expiresAt: this.now() + (Number(expiresIn) || 3600) * 1000,
    };
    await this.store.put(TOKEN_KEY, tokens);
  }

  private async request(
    params: Record<string, string>,
  ): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    let res: Response;
    try {
      res = await fetch(`${this.settings.authBase}/login/v3/oauth/access`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${this.settings.clientId}:${this.settings.clientSecret}`)}`,
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new SonosError(504, "TIMEOUT", describe(e));
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON; fall through with the raw text */
    }
    if (!res.ok || typeof json.access_token !== "string") {
      const reason = String(json.error_description ?? json.error ?? text.slice(0, 200) ?? "");
      throw new SonosError(res.ok ? 502 : res.status, String(json.error ?? `HTTP_${res.status}`), `Sonos sign-in failed: ${reason}`);
    }
    return json as { access_token: string; refresh_token?: string; expires_in: number };
  }
}

export class SonosApi implements SonosClient {
  constructor(
    private settings: SonosSettings,
    private auth: SonosAuth,
  ) {}

  private async call<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.token(attempt > 0);
      let res: Response;
      try {
        res = await fetch(`${this.settings.apiBase}/control/api/v1${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        throw new SonosError(504, "TIMEOUT", describe(e));
      }
      // An expired or revoked access token: refresh once and try again.
      if (res.status === 401 && attempt === 0) continue;
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        /* leave empty */
      }
      if (!res.ok) {
        const code = String(json.errorCode ?? `HTTP_${res.status}`);
        throw new SonosError(res.status, code, String(json.reason ?? code));
      }
      return json as T;
    }
  }

  async households() {
    const r = await this.call<{ households?: { id: string; name?: string }[] }>("GET", "/households");
    return r.households ?? [];
  }

  async groups(householdId: string) {
    const r = await this.call<{ groups?: Group[]; players?: Player[] }>(
      "GET",
      `/households/${encodeURIComponent(householdId)}/groups`,
    );
    return { groups: r.groups ?? [], players: r.players ?? [] };
  }

  async favorites(householdId: string) {
    const r = await this.call<{ items?: Favorite[] }>("GET", `/households/${encodeURIComponent(householdId)}/favorites`);
    return r.items ?? [];
  }

  async createGroup(householdId: string, playerIds: string[]) {
    const r = await this.call<{ group?: Group }>("POST", `/households/${encodeURIComponent(householdId)}/groups/createGroup`, { playerIds });
    return r.group?.id ? r.group : null;
  }

  async setGroupMembers(groupId: string, playerIds: string[]) {
    await this.call("POST", `/groups/${encodeURIComponent(groupId)}/groups/setGroupMembers`, { playerIds });
  }

  async nowPlaying(groupId: string) {
    const r = await this.call<{
      container?: { name?: string };
      currentItem?: { track?: { name?: string; artist?: { name?: string } } };
      streamInfo?: string;
    }>("GET", `/groups/${encodeURIComponent(groupId)}/playbackMetadata`);
    const track = r.currentItem?.track;
    const title = track?.name ? [track.name, track.artist?.name].filter(Boolean).join(" — ") : (r.streamInfo ?? null);
    return [r.container?.name, title].filter(Boolean).join(" · ") || null;
  }

  async loadFavorite(groupId: string, favoriteId: string, opts: { shuffle: boolean }) {
    await this.call("POST", `/groups/${encodeURIComponent(groupId)}/favorites`, {
      favoriteId,
      action: "REPLACE",
      playOnCompletion: true,
      // Repeat so a short playlist cannot run out before the alarm is stopped.
      // Sonos ignores play modes for sources that do not take them, like radio.
      playModes: { shuffle: opts.shuffle, repeat: true },
    });
  }

  async play(groupId: string) {
    await this.call("POST", `/groups/${encodeURIComponent(groupId)}/playback/play`);
  }

  async pause(groupId: string) {
    await this.call("POST", `/groups/${encodeURIComponent(groupId)}/playback/pause`);
  }

  async playbackState(groupId: string) {
    const r = await this.call<{ playbackState?: string }>("GET", `/groups/${encodeURIComponent(groupId)}/playback`);
    return r.playbackState ?? "UNKNOWN";
  }

  async getVolume(playerId: string): Promise<Volume> {
    const r = await this.call<Partial<Volume>>("GET", `/players/${encodeURIComponent(playerId)}/playerVolume`);
    return { volume: Number(r.volume ?? 0), muted: Boolean(r.muted), fixed: Boolean(r.fixed) };
  }

  async setVolume(playerId: string, volume: number) {
    await this.call("POST", `/players/${encodeURIComponent(playerId)}/playerVolume`, {
      volume: Math.max(0, Math.min(100, Math.round(volume))),
      muted: false,
    });
  }

  /** Sonos's built-in chime, played over whatever is (or is not) playing. */
  async chime(playerId: string, volume: number) {
    await this.call("POST", `/players/${encodeURIComponent(playerId)}/audioClip`, {
      name: "House Alarm",
      appId: "com.housealarm.worker",
      clipType: "CHIME",
      priority: "HIGH",
      volume: Math.max(1, Math.min(100, Math.round(volume))),
    });
  }
}
