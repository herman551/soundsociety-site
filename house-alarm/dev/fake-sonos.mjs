#!/usr/bin/env node
// A stand-in for Sonos, for trying the alarm clock without a speaker (or
// without waking the house). It imitates the Sonos cloud endpoints the Worker
// uses, for a household of three speakers, and prints what it is asked to do.
//
//   node dev/fake-sonos.mjs            # listens on http://127.0.0.1:8799
//
// Then point the Worker at it in .dev.vars:
//   SONOS_API_BASE=http://127.0.0.1:8799
//   SONOS_AUTH_BASE=http://127.0.0.1:8799
//
// Behaviour can be changed while it runs:
//   curl -X POST 127.0.0.1:8799/_set -d '{"silent":["fav-spotify"]}'   # that favorite never starts
//   curl -X POST 127.0.0.1:8799/_set -d '{"offline":["RINCON_3"]}'     # a speaker drops off the network
//   curl -X POST 127.0.0.1:8799/_set -d '{"fixed":["RINCON_1"]}'       # fixed-volume line-out
//   curl -X POST 127.0.0.1:8799/_set -d '{"down":true}'                # Sonos's cloud stops answering
//   curl -X POST 127.0.0.1:8799/_set -d '{"gone":["fav-kids"]}'        # a favorite is deleted
//   curl -X POST 127.0.0.1:8799/_set -d '{"lagMs":11000}'              # group list lags, like the real one
//   curl -X POST 127.0.0.1:8799/_reset
//   curl 127.0.0.1:8799/_calls                                          # everything it was asked

import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8799);
const PLAYERS = [
  { id: "RINCON_1", name: "Whole House", capabilities: ["PLAYBACK", "AUDIO_CLIP", "LINE_IN"] },
  { id: "RINCON_2", name: "Kitchen", capabilities: ["PLAYBACK", "AUDIO_CLIP"] },
  { id: "RINCON_3", name: "Office", capabilities: ["PLAYBACK", "AUDIO_CLIP"] },
];
const FAVORITES = [
  { id: "fav-spotify", name: "Morning Coffee", description: "Playlist", service: { name: "Spotify" } },
  { id: "fav-kids", name: "Kids Wake Up", description: "Playlist", service: { name: "Spotify" } },
  { id: "fav-radio", name: "KEXP 90.3", description: "Station", service: { name: "TuneIn" } },
];
const nameOf = (id) => PLAYERS.find((p) => p.id === id)?.name ?? id;

let seq = 100;
let token = 1;
let world;
function reset() {
  world = {
    groups: PLAYERS.map((p) => newGroup([p.id])),
    volume: { RINCON_1: 22, RINCON_2: 18, RINCON_3: 12 },
    silent: [],
    offline: [],
    fixed: [],
    gone: [],
    down: false,
    // The real group list showed a join 11 s after Sonos made it (2026-11-14).
    // Off by default; set it to see how the app copes.
    lagMs: 0,
    stale: null,
    calls: [],
  };
}
/** Called before any grouping change: the list keeps the old arrangement for lagMs. */
function regrouping() {
  if (world.lagMs > 0 && !world.stale) world.stale = { groups: structuredClone(world.groups), until: Date.now() + world.lagMs };
}
function newGroup(playerIds) {
  // Like the real thing, a group keeps its id while its coordinator stays in it;
  // a group that is created, or loses its coordinator, gets a new one.
  return { id: `${playerIds[0]}:${++seq}`, coordinatorId: playerIds[0], playerIds: [...playerIds], state: "PLAYBACK_STATE_IDLE", loaded: null };
}
function groupName(g) {
  return g.playerIds.length > 1 ? `${nameOf(g.coordinatorId)} + ${g.playerIds.length - 1}` : nameOf(g.coordinatorId);
}
/** Take these players out of whatever groups they are in. */
function detach(ids) {
  const next = [];
  for (const g of world.groups) {
    if (!g.playerIds.some((id) => ids.includes(id))) {
      next.push(g);
      continue;
    }
    const rest = g.playerIds.filter((id) => !ids.includes(id));
    if (!rest.length) continue;
    // The remaining speakers carry on: as the same group if the coordinator is
    // among them, otherwise as a new, quiet one.
    if (rest.includes(g.coordinatorId)) next.push({ ...g, playerIds: [g.coordinatorId, ...rest.filter((id) => id !== g.coordinatorId)] });
    else next.push(newGroup(rest));
  }
  world.groups = next;
}
const online = (id) => !world.offline.includes(id);
const visibleGroups = () => {
  if (world.stale && Date.now() >= world.stale.until) world.stale = null;
  // During the lag: the old membership, with what each group is doing now.
  const groups = world.stale ? world.stale.groups.map((g) => ({ ...g, state: world.groups.find((x) => x.id === g.id)?.state ?? g.state })) : world.groups;
  return groups
    .map((g) => ({ ...g, playerIds: g.playerIds.filter(online) }))
    .filter((g) => g.playerIds.length)
    .map((g) => ({ id: g.id, name: groupName(g), coordinatorId: g.playerIds.includes(g.coordinatorId) ? g.coordinatorId : g.playerIds[0], playbackState: g.state, playerIds: g.playerIds }));
};
reset();

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
function say(line) {
  world.calls.push(line);
  console.log(`${new Date().toISOString().slice(11, 19)}  ${line}`);
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const route = `${req.method} ${url.pathname}`;

  // --- test controls
  if (route === "GET /_calls") {
    return send(res, 200, {
      calls: world.calls,
      groups: world.groups.map((g) => ({ speakers: g.playerIds.map(nameOf), state: g.state.replace("PLAYBACK_STATE_", ""), loaded: g.loaded })),
      volume: Object.fromEntries(Object.entries(world.volume).map(([id, v]) => [nameOf(id), v])),
    });
  }
  if (route === "POST /_set") {
    const change = JSON.parse(raw || "{}");
    if (change.state) for (const g of world.groups) if (g.loaded) g.state = change.state;
    if (change.volume) Object.assign(world.volume, change.volume);
    for (const key of ["silent", "offline", "fixed", "gone", "down", "lagMs"]) if (key in change) world[key] = change[key];
    return send(res, 200, { ok: true });
  }
  if (route === "POST /_reset") {
    reset();
    return send(res, 200, { ok: true });
  }

  // --- sign-in
  if (route === "GET /login/v3/oauth") {
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "fake-code");
    back.searchParams.set("state", url.searchParams.get("state"));
    say("sign-in approved");
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (route === "POST /login/v3/oauth/access") {
    if (!(req.headers.authorization || "").startsWith("Basic ")) return send(res, 401, { error: "invalid_client" });
    const form = new URLSearchParams(raw);
    if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") !== "fake-refresh") {
      return send(res, 400, { error: "invalid_grant" });
    }
    say(`token issued (${form.get("grant_type")})`);
    return send(res, 200, { access_token: `fake-access-${++token}`, token_type: "Bearer", refresh_token: "fake-refresh", expires_in: 86400, scope: "playback-control-all" });
  }

  // --- control
  const m = url.pathname.match(/^\/control\/api\/v1(\/.*)$/);
  if (!m) return send(res, 404, { errorCode: "ERROR_NOT_FOUND" });
  if (world.down) return send(res, 503, { errorCode: "ERROR_SERVICE_UNAVAILABLE", reason: "try again later" });
  if (req.headers.authorization !== `Bearer fake-access-${token}`) return send(res, 401, { errorCode: "ERROR_NOT_AUTHORIZED" });
  const path = decodeURIComponent(m[1]);
  const body = raw ? JSON.parse(raw) : {};
  const get = req.method === "GET";
  const post = req.method === "POST";

  if (get && path === "/households") return send(res, 200, { households: [{ id: "Sonos_FAKE.house" }] });
  if (get && path.endsWith("/favorites") && path.startsWith("/households/")) {
    return send(res, 200, { version: "1", items: FAVORITES.filter((f) => !world.gone.includes(f.id)) });
  }
  if (get && path.endsWith("/groups") && path.startsWith("/households/")) {
    return send(res, 200, { groups: visibleGroups(), players: PLAYERS.filter((p) => online(p.id)) });
  }
  if (post && path.endsWith("/groups/createGroup")) {
    const ids = (body.playerIds || []).filter(online);
    if (!ids.length) return send(res, 400, { errorCode: "ERROR_INVALID_PARAMETER", reason: "no players" });
    regrouping();
    detach(ids);
    const g = newGroup(ids);
    world.groups.push(g);
    say(`createGroup [${ids.map(nameOf).join(", ")}]`);
    return send(res, 200, { group: { id: g.id, name: groupName(g), coordinatorId: g.coordinatorId, playerIds: g.playerIds } });
  }

  const gm = path.match(/^\/groups\/([^/]+)\/(.+)$/);
  if (gm) {
    const g = world.groups.find((x) => x.id === gm[1] && x.playerIds.some(online));
    if (!g) return send(res, 410, { errorCode: "ERROR_RESOURCE_GONE", reason: "group is gone" });
    const what = gm[2];
    if (post && what === "groups/setGroupMembers") {
      const ids = (body.playerIds || []).filter(online);
      if (!ids.includes(g.coordinatorId)) return send(res, 400, { errorCode: "ERROR_INVALID_PARAMETER", reason: "the coordinator must stay" });
      const dropped = g.playerIds.filter((id) => !ids.includes(id));
      regrouping();
      detach([...ids, ...dropped]);
      const made = { ...g, playerIds: [g.coordinatorId, ...ids.filter((id) => id !== g.coordinatorId)] };
      world.groups.push(made, ...dropped.map((id) => newGroup([id])));
      say(`setGroupMembers [${made.playerIds.map(nameOf).join(", ")}]`);
      return send(res, 200, { group: { id: made.id, name: groupName(made), coordinatorId: made.coordinatorId, playerIds: made.playerIds } });
    }
    if (post && what === "favorites") {
      const fav = FAVORITES.find((f) => f.id === body.favoriteId && !world.gone.includes(f.id));
      const levels = g.playerIds.map((id) => `${nameOf(id)} ${world.volume[id]}`).join(", ");
      say(`loadFavorite ${fav ? `"${fav.name}"` : body.favoriteId} on [${g.playerIds.map(nameOf).join(", ")}] action=${body.action} shuffle=${body.playModes?.shuffle} (volumes: ${levels})`);
      if (!fav) return send(res, 400, { errorCode: "ERROR_INVALID_OBJECT_ID", reason: "no such favorite" });
      if (!world.silent.includes(fav.id)) {
        g.loaded = fav.id;
        g.state = "PLAYBACK_STATE_PLAYING";
      }
      return send(res, 200, {});
    }
    if (post && what === "playback/play") {
      say(`play [${g.playerIds.map(nameOf).join(", ")}]`);
      if (!g.loaded) return send(res, 400, { errorCode: "ERROR_PLAYBACK_NO_CONTENT", reason: "nothing to play" });
      g.state = "PLAYBACK_STATE_PLAYING";
      return send(res, 200, {});
    }
    if (post && what === "playback/pause") {
      say(`pause [${g.playerIds.map(nameOf).join(", ")}]`);
      if (g.state === "PLAYBACK_STATE_PLAYING") g.state = "PLAYBACK_STATE_PAUSED";
      return send(res, 200, {});
    }
    if (get && what === "playback") return send(res, 200, { playbackState: g.state });
    if (get && what === "playbackMetadata") {
      const fav = FAVORITES.find((f) => f.id === g.loaded);
      if (!fav) return send(res, 200, {});
      return send(res, 200, {
        container: { name: fav.name, type: fav.description.toLowerCase(), service: fav.service },
        currentItem: fav.service.name === "Spotify" ? { track: { name: "Here Comes the Sun", artist: { name: "The Beatles" } } } : undefined,
        streamInfo: fav.service.name === "Spotify" ? undefined : "KEXP — Morning Show",
      });
    }
  }

  const pm = path.match(/^\/players\/([^/]+)\/(playerVolume|audioClip)$/);
  if (pm) {
    const id = pm[1];
    if (!PLAYERS.some((p) => p.id === id) || !online(id)) return send(res, 410, { errorCode: "ERROR_RESOURCE_GONE", reason: "player is gone" });
    if (pm[2] === "playerVolume" && get) return send(res, 200, { volume: world.volume[id], muted: false, fixed: world.fixed.includes(id) });
    if (pm[2] === "playerVolume" && post) {
      if (world.fixed.includes(id)) return send(res, 500, { errorCode: "ERROR_COMMAND_FAILED", reason: "fixed volume" });
      world.volume[id] = body.volume;
      say(`volume ${nameOf(id)} ${body.volume}`);
      return send(res, 200, {});
    }
    if (pm[2] === "audioClip" && post) {
      say(body.streamUrl ? `play ${body.streamUrl} on ${nameOf(id)} at volume ${body.volume}` : `chime ${nameOf(id)} at volume ${body.volume}`);
      return send(res, 200, { id: "clip", name: body.name, appId: body.appId });
    }
  }
  return send(res, 404, { errorCode: "ERROR_NOT_FOUND", reason: `${route} is not imitated` });
}).listen(PORT, "127.0.0.1", () => console.log(`Fake Sonos listening on http://127.0.0.1:${PORT}`));
