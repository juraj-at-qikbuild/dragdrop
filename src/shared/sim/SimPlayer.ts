// Everything the simulation knows about one player: their figure, wanted level and police pursuit,
// money/progress, weapons, and the camera "observer" that drives NPC spawning around them.
import type { Ped, WeaponId } from '../entities/Ped';
import type { Vehicle } from '../entities/Vehicle';
import type { Helicopter } from '../entities/Helicopter';
import type { Prop } from '../entities/Props';
import type { Level } from '../world/World';

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
  roadblocks: Roadblock[];
  rbTimer: number;
  spikeTimer: number;
}

export class SimPlayer {
  wanted = 0;
  unseen = 0;
  /** last-known-position circle the police search while they've lost sight (grows over time) */
  searchZone: { x: number; y: number; r: number } | null = null;
  lastSeenPos = { x: 0, y: 0 };
  /** police lost sight this frame (HUD flashes the stars) */
  searching = false;
  shotCops = false;
  crimeCooldown = new Map<string, number>();
  ammo: Record<WeaponId, number> = { fist: Infinity, pistol: 0, uzi: 0, shotgun: 0 };
  state: PlayerState = 'play';
  stateTimer = 0;
  lastCar: Vehicle | null = null;
  sprayCooldown = 0;
  drown = 0;
  observer: Observer;
  police: PlayerPolice = { heli: null, roadblocks: [], rbTimer: 0, spikeTimer: 0 };
  /** bumped on every teleport (respawn); stale client reports carry an older epoch */
  epoch = 0;
  /** the last player who hurt this one (kill credit), and when (sim time) */
  lastAttacker = 0;
  lastAttackedAt = -1e9;
  /** server: still connected (disconnected players stay in the world for a grace period) */
  connected = true;
  /** server: no state reports for a while (tab in the background): not an observer */
  afk = false;
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
}
