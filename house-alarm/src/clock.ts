// The Durable Object: the one long-lived thing in the system. It keeps the
// alarms and Sonos tokens in its storage, and uses its own alarm (a timer
// Cloudflare guarantees to deliver) to wake the engine at the right moments.

import { DurableObject } from "cloudflare:workers";
import { sameSecret } from "./auth";
import { Engine, InputError } from "./engine";
import { SonosApi, SonosAuth, SonosError, type Store } from "./sonos";

export interface Env {
  CLOCK: DurableObjectNamespace<AlarmClock>;
  APP_PASSWORD?: string;
  SONOS_CLIENT_ID?: string;
  SONOS_CLIENT_SECRET?: string;
  /** Only set for local development against a stand-in Sonos. */
  SONOS_API_BASE?: string;
  SONOS_AUTH_BASE?: string;
}

const MAX_TRIES = 8;
const LOCKOUT_MS = 15 * 60_000;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export class AlarmClock extends DurableObject<Env> {
  private engine: Engine;
  private auth: SonosAuth;
  /** Wrong-passphrase counts per caller. Kept in memory: losing them on a restart is harmless. */
  private misses = new Map<string, { count: number; until: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const store: Store = {
      get: (key) => ctx.storage.get(key),
      put: (key, value) => ctx.storage.put(key, value),
      delete: async (key) => void (await ctx.storage.delete(key)),
    };
    const settings = {
      clientId: env.SONOS_CLIENT_ID ?? "",
      clientSecret: env.SONOS_CLIENT_SECRET ?? "",
      apiBase: env.SONOS_API_BASE || "https://api.ws.sonos.com",
      authBase: env.SONOS_AUTH_BASE || "https://api.sonos.com",
    };
    this.auth = new SonosAuth(settings, store);
    this.engine = new Engine({
      store,
      sonos: new SonosApi(settings, this.auth),
      now: () => Date.now(),
      setWake: (at) => ctx.storage.setAlarm(at),
      // Alerts go out as a plain-text POST: what ntfy and most webhooks accept.
      notify: async (url, message) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain; charset=utf-8", Title: "House Alarm" },
          body: message,
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`that address answered with an error (${res.status})`);
      },
    });
  }

  /** Cloudflare calls this at the time the engine last asked for. */
  async alarm(): Promise<void> {
    await this.engine.tick();
  }

  private async state(extra: Record<string, unknown> = {}): Promise<Response> {
    // If the wake-up timer has somehow been lost, this puts it back.
    if ((await this.ctx.storage.getAlarm()) === null) await this.engine.tick();
    return json({
      ...(await this.engine.getState()),
      sonos: { ...(await this.auth.status()), hasCredentials: this.auth.hasCredentials() },
      ...extra,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const body = async (): Promise<Record<string, unknown>> => {
      const parsed = await request.json().catch(() => null);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InputError("That request was not understood.");
      return parsed as Record<string, unknown>;
    };

    try {
      if (route === "POST /internal/login") return this.login(await body());

      if (route === "GET /oauth/start") return this.oauthStart(url);
      if (route === "GET /oauth/callback") return this.oauthCallback(url);

      if (route === "GET /api/state") return this.state();
      if (route === "GET /api/favorites") return json({ favorites: await this.engine.favorites() });
      if (route === "GET /api/speakers") return json(await this.engine.speakers());
      const manage = url.pathname.match(/^\/api\/speakers\/([a-z-]{1,20})$/);
      if (manage && request.method === "POST") return json(await this.engine.manage(manage[1]!, await body()));
      if (route === "POST /api/alert-test") {
        await this.engine.testAlert();
        return json({ ok: true });
      }
      if (route === "PUT /api/config") {
        await this.engine.updateConfig(await body());
        return this.state();
      }
      if (route === "POST /api/snooze") return this.state({ confirmed: (await this.engine.snooze()).ok });
      if (route === "POST /api/stop") return this.state({ confirmed: (await this.engine.stop()).ok });
      if (route === "POST /api/dismiss") {
        await this.engine.dismiss();
        return this.state();
      }
      if (route === "POST /api/sonos/disconnect") {
        await this.auth.disconnect();
        await this.engine.forgetHousehold();
        return this.state();
      }
      if (route === "POST /api/alarms") {
        await this.engine.createAlarm(await body());
        return this.state();
      }
      const one = url.pathname.match(/^\/api\/alarms\/([\w-]{1,64})(\/skip|\/test)?$/);
      if (one) {
        const [, id, action] = one as unknown as [string, string, string | undefined];
        if (request.method === "PUT" && !action) await this.engine.updateAlarm(id, await body());
        else if (request.method === "DELETE" && !action) await this.engine.deleteAlarm(id);
        else if (request.method === "POST" && action === "/skip") await this.engine.setSkip(id, (await body()).skip !== false);
        else if (request.method === "POST" && action === "/test") await this.engine.testAlarm(id);
        else return json({ error: "Not found." }, 404);
        return this.state();
      }
      return json({ error: "Not found." }, 404);
    } catch (e) {
      if (e instanceof InputError) return json({ error: e.message }, 400);
      if (e instanceof SonosError) {
        const reconnect = e.code === "RECONNECT" || e.code === "NOT_CONNECTED";
        return json({ error: reconnect ? e.message + "." : `Sonos said: ${e.message}`, reconnect }, 502);
      }
      console.error(e);
      return json({ error: "Something went wrong on the server." }, 500);
    }
  }

  private async login(body: Record<string, unknown>): Promise<Response> {
    const who = String(body.ip ?? "unknown");
    const now = Date.now();
    const miss = this.misses.get(who);
    if (miss && miss.count >= MAX_TRIES && miss.until > now) {
      return json({ error: "Too many wrong tries. Wait a quarter of an hour and try again." }, 429);
    }
    const ok = await sameSecret(String(body.password ?? ""), this.env.APP_PASSWORD ?? "");
    if (ok) {
      this.misses.delete(who);
      return json({ ok: true });
    }
    if (this.misses.size > 2000) this.misses.clear();
    const count = miss && miss.until > now ? miss.count + 1 : 1;
    this.misses.set(who, { count, until: now + LOCKOUT_MS });
    return json({ error: "That is not the passphrase." }, 401);
  }

  private async oauthStart(url: URL): Promise<Response> {
    if (!this.auth.hasCredentials()) {
      return Response.redirect(`${url.origin}/?sonos=${encodeURIComponent("The Sonos key and secret are not set on the server yet.")}`, 302);
    }
    const state = crypto.randomUUID().replaceAll("-", "");
    await this.ctx.storage.put("oauthState", { state, expires: Date.now() + 15 * 60_000 });
    return Response.redirect(this.auth.authorizeUrl(`${url.origin}/oauth/callback`, state), 302);
  }

  private async oauthCallback(url: URL): Promise<Response> {
    const back = (message: string) => Response.redirect(`${url.origin}/?sonos=${encodeURIComponent(message)}`, 302);
    const expected = await this.ctx.storage.get<{ state: string; expires: number }>("oauthState");
    await this.ctx.storage.delete("oauthState");
    const code = url.searchParams.get("code");
    if (url.searchParams.get("error") || !code) return back("Sonos sign-in was cancelled.");
    if (!expected || expected.expires < Date.now() || expected.state !== url.searchParams.get("state")) {
      return back("That Sonos sign-in had expired. Please try again.");
    }
    try {
      await this.auth.exchangeCode(code, `${url.origin}/oauth/callback`);
    } catch (e) {
      return back(e instanceof Error ? e.message : "Sonos sign-in failed.");
    }
    await this.engine.adoptHousehold();
    return back("connected");
  }
}
