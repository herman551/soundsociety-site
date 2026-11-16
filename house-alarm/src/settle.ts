// Sonos's cloud is slow to report grouping changes. A createGroup or
// setGroupMembers answers at once with the group it made, but the household's
// group list keeps showing the old arrangement for a while: 11 seconds for a
// join on a real system (2026-11-14), about 2 for a split. Anything that reads
// the list in that window would act on speakers that are no longer arranged
// that way, for example grouping them a second time.
//
// SettlingGroups wraps a SonosClient, remembers the groups those commands
// answered with, and lays them over the list until the list agrees, or for
// SETTLE_MS at most, after which the list is trusted again whatever it says.

import type { Group, SonosClient } from "./sonos";

export const SETTLE_MS = 20_000;

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export class SettlingGroups implements SonosClient {
  /** Groups Sonos says it made, oldest first, that its list may not show yet. */
  private made: { group: Group; at: number }[] = [];

  constructor(
    private inner: SonosClient,
    private now: () => number,
  ) {}

  private remember(group: Group | null): Group | null {
    if (!group?.id || !group.playerIds?.length) return group;
    // A newer group takes its players out of anything remembered before it.
    for (const m of this.made) m.group = { ...m.group, playerIds: m.group.playerIds.filter((p) => !group.playerIds.includes(p)) };
    this.made = this.made.filter((m) => m.group.id !== group.id && m.group.playerIds.length > 0);
    this.made.push({ group, at: this.now() });
    return group;
  }

  async groups(householdId: string) {
    const reported = await this.inner.groups(householdId);
    const now = this.now();
    const present = new Set(reported.groups.flatMap((g) => g.playerIds ?? []));
    // Forget what has expired, and what the list now shows for itself: the same
    // group, by id, with the same speakers.
    const shown = (m: { group: Group }) =>
      reported.groups.some((g) => g.id === m.group.id && sameSet(g.playerIds ?? [], m.group.playerIds.filter((p) => present.has(p))));
    this.made = this.made.filter((m) => now - m.at < SETTLE_MS && !shown(m));
    let groups = reported.groups;
    for (const { group } of this.made) {
      const members = group.playerIds.filter((p) => present.has(p));
      if (!members.length) continue;
      const listed = groups.find((g) => g.id === group.id);
      // Only lay a group over the list if it gained players or is new. One that
      // dropped players would leave them in no group at all, as far as the list
      // shows, and they would look offline.
      if (listed && listed.playerIds.some((p) => !members.includes(p))) continue;
      groups = groups
        .filter((g) => g.id !== group.id)
        .map((g) => {
          const playerIds = g.playerIds.filter((p) => !members.includes(p));
          return { ...g, playerIds, coordinatorId: playerIds.includes(g.coordinatorId) ? g.coordinatorId : (playerIds[0] ?? g.coordinatorId) };
        })
        .filter((g) => g.playerIds.length > 0);
      groups.push({ ...group, playerIds: members, playbackState: listed?.playbackState ?? group.playbackState });
    }
    return { groups, players: reported.players };
  }

  async createGroup(householdId: string, playerIds: string[]) {
    return this.remember(await this.inner.createGroup(householdId, playerIds));
  }

  async setGroupMembers(groupId: string, playerIds: string[]) {
    return this.remember(await this.inner.setGroupMembers(groupId, playerIds));
  }

  households() {
    return this.inner.households();
  }
  favorites(householdId: string) {
    return this.inner.favorites(householdId);
  }
  nowPlaying(groupId: string) {
    return this.inner.nowPlaying(groupId);
  }
  loadFavorite(groupId: string, favoriteId: string, opts: { shuffle: boolean }) {
    return this.inner.loadFavorite(groupId, favoriteId, opts);
  }
  play(groupId: string) {
    return this.inner.play(groupId);
  }
  pause(groupId: string) {
    return this.inner.pause(groupId);
  }
  playbackState(groupId: string) {
    return this.inner.playbackState(groupId);
  }
  getVolume(playerId: string) {
    return this.inner.getVolume(playerId);
  }
  setVolume(playerId: string, volume: number) {
    return this.inner.setVolume(playerId, volume);
  }
  chime(playerId: string, volume: number, streamUrl?: string) {
    return this.inner.chime(playerId, volume, streamUrl);
  }
}
