// Everything the simulation knows about one player: their figure, wanted level and police pursuit,
// money/progress, weapons, and the camera "observer" that drives NPC spawning around them.
import type { Ped, WeaponId } from '../entities/Ped';
import type { Vehicle } from '../entities/Vehicle';
import type { Helicopter } from '../entities/Helicopter';
import type { Prop } from '../entities/Props';
import type { Level } from '../world/World';
import type { Desc } from './Pursuit';
import type { Gear } from './shops/catalog';

/** downed: lying wounded, revivable by another player until they bleed out (online; see Revive) */
export type PlayerState = 'play' | 'wasted' | 'busted' | 'downed';

/** Persistent progress. Offline this is the localStorage save; online the server's profile. */
export interface Profile {
  money: number;
  /** completed mission ids (offline only) */
  done: string[];
  /** discovered landmark ids */
  found: string[];
  /** collected Čumil statue indices */
  cumils: number[];
  /** time of day in hours (offline save only) */
  clock?: number;
  /** counters for the social features (golden Čumils, deliveries, fares, races and daily puzzles won…) */
  stats?: Record<string, number>;
  /** what money bought (docs/plans/gameplay.md, Phase 2): clothes, garages and their cars, the
   *  collection, a lawyer */
  gear?: Gear;
}

/** A player's view of the world: focus (their ped/car) and camera rectangle, in metres. */
export interface Observer {
  fx: number;
  fy: number;
  /** camera centre */
  cx: number;
  cy: number;
  /** camera half extents */
  hw: number;
  hh: number;
}

export interface Roadblock {
  cars: Vehicle[];
  cops: Ped[];
  props: Prop[];
  age: number;
  x: number;
  y: number;
}

/** per-player police escalation (helicopter, roadblocks, spike strips) */
export interface PlayerPolice {
  heli: Helicopter | null;
  /** the point of the search circle the helicopter is flying to, and for how long more (s) */
  heliSearch: { x: number; y: number; t: number } | null;
  roadblocks: Roadblock[];
  rbTimer: number;
  spikeTimer: number;
}

/** seconds a downed player has to be revived before they bleed out (SimOptions.downed). Here, not in
 *  Sim.ts, so rules can import it without a runtime import cycle (Sim.ts imports the rules). */
export const DOWNED_BLEED = 25;

export class SimPlayer {
  wanted = 0;
  /** the police's search clock: runs while nobody sees the player (faster when they've changed car or
   *  lie low, see Pursuit), and a star drops each time it runs out */
  unseen = 0;
  /** last-known-position circle the police search while they've lost sight (grows over time) */
  searchZone: { x: number; y: number; r: number } | null = null;
  lastSeenPos = { x: 0, y: 0 };
  /** sim.time the police last saw this player (roadblocks go up only just after) */
  lastSeenAt = -1e9;
  /** police lost sight this frame (HUD flashes the stars) */
  searching = false;
  /** what the police are looking for: the car they last saw the player in (0: on foot), see Pursuit */
  desc: Desc = { car: 0, kind: null, color: '' };
  /** 0..1: how far a unit looking over a player who doesn't match `desc` has got to recognising them */
  spot = 0;
  /** seconds stood (nearly) still */
  still = 0;
  /** lying low (still and out of sight): 0 no, 1 yes, 2 in a hideout (a car park, under cover) */
  low: 0 | 1 | 2 = 0;
  /** the `police` status last sent (Pursuit, change detection; 'off': no chase) */
  policeKey = 'off';
  /** Úplatok: the price of buying off the arrest under way (0: none on offer), and sim.time of the
   *  last one bought off */
  bribeOffer = 0;
  bribeAt = -1e9;
  /** where they last died: a death's fee drops there (docs/plans/gameplay.md, Phase 2) */
  diedAt: { x: number; y: number } | null = null;
  shotCops = false;
  crimeCooldown = new Map<string, number>();
  ammo: Record<WeaponId, number> = { fist: Infinity, pistol: 0, uzi: 0, shotgun: 0 };
  state: PlayerState = 'play';
  /** seconds left in the current non-'play' state before Sim.step respawns the player: 4 s wasted/
   *  busted, 25 s downed (DOWNED_BLEED) before bleeding out */
  stateTimer = 0;
  lastCar: Vehicle | null = null;
  sprayCooldown = 0;
  drown = 0;
  observer: Observer;
  police: PlayerPolice = { heli: null, heliSearch: null, roadblocks: [], rbTimer: 0, spikeTimer: 0 };
  /** bumped on every teleport (respawn); stale client reports carry an older epoch */
  epoch = 0;
  /** the last player who hurt this one (kill credit), and when (sim time) */
  lastAttacker = 0;
  lastAttackedAt = -1e9;
  /** server: still connected (disconnected players stay in the world for a grace period) */
  connected = true;
  /** server: no state reports for a while (tab in the background): not an observer */
  afk = false;
  /** server: paused, the page hidden, or disconnected and still in the city (rules/Presence.ts) */
  away = false;
  /** sim.time `away` last turned on */
  awaySince = 0;
  /** away and safe: nothing can hurt, arrest or carjack them (rules/Presence.ts) */
  shielded = false;
  /** sim.time this player last hurt, or was hurt by, another player (a carjacking counts) */
  lastPvpAt = -1e9;
  /** the police chase now on: when it started (sim.time; -1: none) and the most stars it reached,
   *  for the leaderboard's getaway points (Sim.updateWanted) */
  chaseSince = -1;
  chasePeak = 0;
  /** sim.time of the last getaway that scored */
  lastGetawayAt = -1e9;
  /** party this player is in (0 = none); set by the server's Party feature */
  partyId = 0;
  /** opted in to voice chat; set by the server's Voice feature */
  voiceOn = false;
  /** playing as a Supabase account rather than a guest */
  account = false;

  constructor(
    public id: number,
    public nick: string,
    public ped: Ped,
    public profile: Profile,
    /** true on the server: the player's client simulates their figure and car */
    public kinematic: boolean,
  ) {
    this.observer = { fx: ped.x, fy: ped.y, cx: ped.x, cy: ped.y, hw: 20, hh: 12 };
  }

  get look() {
    return this.ped.look;
  }

  /** where the player is: their car if driving, else their figure */
  focus(): { x: number; y: number } {
    const v = this.ped.vehicle;
    return v ? { x: v.x, y: v.y } : { x: this.ped.x, y: this.ped.y };
  }

  /** -1 in a tunnel, 0 on the ground, 1 on a bridge deck (the car's level while driving) */
  focusLevel(): Level {
    return this.ped.vehicle ? this.ped.vehicle.level : this.ped.level;
  }

  get stars() {
    return Math.ceil(this.wanted - 0.01);
  }

  /** counts as someone NPCs should spawn around / think near */
  get observing() {
    return this.connected && !this.afk;
  }

  /** counts as taking part: world events, the most-wanted pick, a party's payout split. An away
   *  player (in the menu) still observes, so the city keeps living around them. */
  get active() {
    return this.observing && !this.away;
  }
}
