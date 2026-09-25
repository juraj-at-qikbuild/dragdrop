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
  /** name + wanted level for a player's figure, for name tags */
  tagFor(playerId: number): { nick: string; wanted: number } | null;
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
  /** combo cash (offline only) */
  styleCash(n: number): void;
  /** host-specific reaction to a private event (before the generic effects) */
  onPrivate(e: PrivateEvent): void;
  persist(): void;
  dispose(): void;
}
