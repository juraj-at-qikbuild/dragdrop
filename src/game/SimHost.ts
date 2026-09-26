// What the client shell (Game) needs from "the world": the entities to draw, the local player's state,
// and a way to act. Offline that's a Sim running in the page (LocalSimHost); online it's the server,
// seen through snapshots (NetSimHost).
import type { Ped, WeaponId } from '../shared/entities/Ped';
import type { Vehicle } from '../shared/entities/Vehicle';
import type { Tram } from '../shared/entities/Tram';
import type { Prop } from '../shared/entities/Props';
import type { Helicopter } from '../shared/entities/Helicopter';
import type { Pickup } from '../shared/sim/Pickups';
import type { ShotReport } from '../shared/sim/Combat';
import type { PrivateEvent } from '../shared/sim/events';
import type { Observer, PlayerState, Profile } from '../shared/sim/SimPlayer';
import type { NetStatus } from '../net/Connection';
import type { RosterRow } from '../shared/net/protocol';
import type { ChallengeState, DailyState, EventEntry, JobState, PartyState, RaceState, ReviveState } from '../shared/sim/rules/types';

/** The local player as the client sees it (SimPlayer offline, server-fed state online). */
export interface MeView {
  id: number;
  ped: Ped;
  wanted: number;
  state: PlayerState;
  stateTimer: number;
  ammo: Record<WeaponId, number>;
  profile: Profile;
  searchZone: { x: number; y: number; r: number } | null;
  searching: boolean;
  lastCar: Vehicle | null;
}

export interface NetView {
  status: NetStatus;
  roster: RosterRow[];
  nick: string;
  setNick(n: string): void;
  /** name + wanted level for a player's figure, for name tags; partyId/flags from the roster (ROSTER_*) */
  tagFor(playerId: number): { nick: string; wanted: number; partyId: number; flags: number } | null;
  /** playing as a signed-in Supabase account rather than a guest (src/ui/AccountUi.ts) */
  account: boolean;
  /** GDPR self-delete; the server answers with `bye: 'deleted'` */
  deleteAccount(): void;
}

/** What the social features show, kept the same way by both hosts: offline straight from the rules,
 *  online from the server's `wev` message and private events. HUD and map code read only this. */
export interface LiveState {
  /** active world events */
  events: EventEntry[];
  /** when `events` arrived (performance.now() ms): each entry's `left` counts down from then */
  eventsAt: number;
  daily: DailyState | null;
  party: PartyState | null;
  job: JobState | null;
  race: RaceState | null;
  /** someone challenged this player to a race */
  challenge: ChallengeState | null;
  revive: ReviveState | null;
  /** party tags of everyone online (from the roster): partyId → tag + colour */
  partyTags: Map<number, { tag: string; color: string }>;
}

export function emptyLive(): LiveState {
  return { events: [], eventsAt: 0, daily: null, party: null, job: null, race: null, challenge: null, revive: null, partyTags: new Map() };
}

/** seconds left in a world event's phase, now */
export function eventLeft(live: LiveState, e: EventEntry, now = performance.now()) {
  return Math.max(0, e.left - (now - live.eventsAt) / 1000);
}

/** keep LiveState in step with the private events that carry feature state (both hosts call this) */
export function applyLive(live: LiveState, e: PrivateEvent) {
  switch (e.k) {
    case 'party':
      live.party = e.s;
      break;
    case 'job':
      live.job = e.s;
      break;
    case 'race':
      live.race = e.s;
      break;
    case 'challenge':
      live.challenge = e.s;
      break;
    case 'revive':
      live.revive = e.s;
      break;
  }
}

export interface SimHost {
  readonly mode: 'local' | 'net';
  readonly me: MeView;
  readonly vehicles: readonly Vehicle[];
  readonly peds: readonly Ped[];
  readonly trams: readonly Tram[];
  readonly props: readonly Prop[];
  readonly helis: readonly Helicopter[];
  /** pickups this player can see (Čumils they already found are left out) */
  readonly pickups: readonly Pickup[];
  readonly net: NetView | null;
  /** offline only: the menus freeze the world, and slow-mo / hit-stop are allowed */
  readonly allowsPause: boolean;
  readonly allowsTimeScale: boolean;
  readonly missionsEnabled: boolean;
  /** state of the social features (world events, party, job, race…) */
  readonly live: LiveState;

  vehicleById(id: number): Vehicle | null;
  pedById(id: number): Ped | null;
  setObserver(o: Observer): void;
  /** advance the world by dt (offline: the simulation; online: mirrors and the player's own car) */
  update(dt: number): void;
  /** the local player fired a traced shot */
  fire(shot: ShotReport): void;
  /** the local player punched (target ped id, 0 = air) */
  punch(targetId: number): void;
  requestEnter(v: Vehicle): void;
  requestExit(): void;
  horn(): void;
  /** downed (Revive): skip the bleed-out wait and go straight to hospital; a no-op offline (no downing there) */
  giveUp(): void;
  /** combo cash (offline only) */
  styleCash(n: number): void;
  /** host-specific reaction to a private event (before the generic effects) */
  onPrivate(e: PrivateEvent): void;
  persist(): void;
  dispose(): void;
}
