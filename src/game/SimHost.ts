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
import type { ChallengeState, DailyState, EventEntry, EventSchedule, JobKind, JobState, PartyState, RaceState, ReviveState } from '../shared/sim/rules/types';
import type { ShopReq } from '../shared/sim/rules/Shops';
import type { Prices } from '../shared/sim/shops/catalog';

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
  /** when `events` (and `schedule`) arrived (performance.now() ms): each entry's `left` counts down
   *  from then */
  eventsAt: number;
  /** what's coming next: the director's plan (null from a server that doesn't send one) */
  schedule: EventSchedule | null;
  daily: DailyState | null;
  party: PartyState | null;
  job: JobState | null;
  race: RaceState | null;
  /** someone challenged this player to a race */
  challenge: ChallengeState | null;
  revive: ReviveState | null;
  /** party tags of everyone online (from the roster): partyId → tag + colour */
  partyTags: Map<number, { tag: string; color: string }>;
  /** this player's leaderboard points (the server's `score`): today, this week, all time, today's
   *  rank (0: nothing today) of `n` players. Null offline, and on a server without a leaderboard. */
  score: { d: number; w: number; a: number; r: number; n: number } | null;
  /** what the police know in the chase now on (the `police` event, docs/plans/gameplay.md): null
   *  without one, and from a server that doesn't say */
  police: PoliceView | null;
  /** an arrest this player can buy off (Úplatok): the price, and until when (performance.now() ms) */
  bribe: { price: number; until: number } | null;
  /** the shops' price list (docs/plans/gameplay.md, Phase 2): offline the rule's, online the server's
   *  `catalog`; null from a server without shops, which then offers none */
  catalog: Prices | null;
  /** how the last shop request went, and when (performance.now() ms): the open shop panel shows it */
  shop: { ok: boolean; text: string; at: number } | null;
}

/** the `police` private event, as kept: the description (car 0: on foot), whether the player matches
 *  it, recognition (0..1) and whether a unit is looking them over, and lying low (2: in a hideout) */
export interface PoliceView {
  car: number;
  kind: string;
  color: string;
  match: boolean;
  spot: number;
  watched: boolean;
  low: 0 | 1 | 2;
  /** on foot: the hat they're looking for (HATS; 0 none) */
  hat: number;
}

export function emptyLive(): LiveState {
  return {
    events: [], eventsAt: 0, schedule: null, daily: null, party: null, job: null, race: null, challenge: null, revive: null,
    partyTags: new Map(), score: null, police: null, bribe: null, catalog: null, shop: null,
  };
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
    case 'police':
      live.police = e.car < 0 ? null : { car: e.car, kind: e.kind, color: e.color, match: !!e.m, spot: e.spot, watched: !!e.w, low: e.low, hat: e.hat ?? 0 };
      break;
    case 'bribe':
      live.bribe = e.price > 0 ? { price: e.price, until: performance.now() + e.t * 1000 } : null;
      break;
    case 'respawn':
      live.bribe = null;
      break;
    case 'shop':
      live.shop = { ok: e.ok, text: e.text, at: performance.now() };
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
  /** Závod?: challenge a nearby player's car (or answer one you were sent); no-ops offline (races are online only) */
  challenge(target: number): void;
  challengeAnswer(from: number, ok: boolean): void;
  /** jobs (Vlk courier / Hopík taxi): start a shift; a no-op if one is already running */
  jobStart(kind: JobKind): void;
  /** ends the current job shift, if any */
  jobStop(): void;
  /** combo cash (offline only) */
  styleCash(n: number): void;
  /** Úplatok: pay off the arrest on offer (LiveState.bribe) */
  bribe(): void;
  /** the shop the player is in (rules/Shops.ts): buy, park the car in the garage, take one out. The
   *  answer comes as a `shop` event (LiveState.shop); online, nothing is sent without a catalog. */
  shop(req: ShopReq): void;
  /** host-specific reaction to a private event (before the generic effects) */
  onPrivate(e: PrivateEvent): void;
  /** the pause menu opened or closed (Game.setPaused): offline nothing to do (the menu freezes the
   *  world), online the server marks the player away (⏸) and shields them when it's safe */
  setAway(on: boolean): void;
  persist(): void;
  dispose(): void;
}
