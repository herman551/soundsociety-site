import { describe, expect, it } from "vitest";
import { SETTLE_MS, SettlingGroups } from "../src/settle";
import type { Group, SonosClient } from "../src/sonos";

/** A Sonos whose group list never changes, whatever it is asked to do. */
function stuck(listed: Group[], answers: Group | null): SonosClient {
  const no = () => Promise.reject(new Error("not used"));
  return {
    groups: async () => ({ groups: listed.map((g) => ({ ...g })), players: [] }),
    createGroup: async () => answers,
    setGroupMembers: async () => answers,
    households: no,
    favorites: no,
    nowPlaying: no,
    loadFavorite: no,
    play: no,
    pause: no,
    playbackState: no,
    getVolume: no,
    setVolume: no,
    chime: no,
  };
}

const A = { id: "A:1", name: "A", coordinatorId: "A", playerIds: ["A"], playbackState: "PLAYBACK_STATE_PLAYING" };
const B = { id: "B:1", name: "B", coordinatorId: "B", playerIds: ["B"], playbackState: "PLAYBACK_STATE_IDLE" };

describe("SettlingGroups", () => {
  it("shows a group Sonos made until its own list catches up, then trusts the list", async () => {
    let now = 0;
    const joined = { id: "A:1", name: "A + 1", coordinatorId: "A", playerIds: ["A", "B"] };
    const sonos = new SettlingGroups(stuck([A, B], joined), () => now);
    await sonos.setGroupMembers("A:1", ["A", "B"]);

    const shown = (await sonos.groups("H")).groups;
    expect(shown).toEqual([{ ...joined, playbackState: "PLAYBACK_STATE_PLAYING" }]);

    now = SETTLE_MS;
    expect((await sonos.groups("H")).groups.map((g) => g.id)).toEqual(["A:1", "B:1"]);
  });

  it("does not show a group that dropped players, which would leave them in no group", async () => {
    const AB = { ...A, playerIds: ["A", "B"] };
    const sonos = new SettlingGroups(stuck([AB], { ...A, playerIds: ["A"] }), () => 0);
    await sonos.setGroupMembers("A:1", ["A"]);
    expect((await sonos.groups("H")).groups).toEqual([AB]);
  });

  it("leaves out speakers that have since gone offline", async () => {
    const made = { id: "N:1", name: "N", coordinatorId: "A", playerIds: ["A", "C"] };
    const sonos = new SettlingGroups(stuck([A, B], made), () => 0);
    await sonos.createGroup("H", ["A", "C"]);
    expect((await sonos.groups("H")).groups.map((g) => [g.id, g.playerIds])).toEqual([
      ["B:1", ["B"]],
      ["N:1", ["A"]],
    ]);
  });
});
