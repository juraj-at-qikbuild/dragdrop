// A pluggable piece of game rules: a world event, revive, a race, jobs… The Sim calls every rule's
// hooks at fixed points (see Sim.ts); a rule keeps its own state and reaches players only through
// sim.events, sim.payout and the like, so the same rule runs on the server and offline.
import type { Crime } from '../Sim';
import type { PlayerState, SimPlayer } from '../SimPlayer';
import type { Vehicle } from '../../entities/Vehicle';
import type { Pickup } from '../Pickups';

export interface SimRule {
  readonly id: string;
  /** once per Sim.step, after the built-in systems */
  step?(dt: number): void;
  /** false: `attacker` can't hurt `victim`, nor take their car (parties) */
  allowPvp?(attacker: SimPlayer, victim: SimPlayer): boolean;
  /** false: the crime doesn't count, no stars (bounty hunters, the derby arena). `target`: the player
   *  it was done to, for hitPlayer/killPlayer */
  allowCrime?(p: SimPlayer, kind: Crime, target?: SimPlayer): boolean;
  /** a player's state changed: play → downed/wasted/busted, downed → play (revived) or wasted
   *  (finished off, bled out), wasted/busted → play (respawned). `by`: the player responsible, if any */
  onState?(p: SimPlayer, from: PlayerState, to: PlayerState, by?: SimPlayer): void;
  /** PvP kill credit (a player downed or killed another) */
  onKill?(victim: SimPlayer, killer: SimPlayer): void;
  onEnter?(p: SimPlayer, v: Vehicle): void;
  onExit?(p: SimPlayer, v: Vehicle): void;
  /** gunfire hit a car at (hx, hy) for `dmg` (0 when it didn't hurt it) */
  onVehicleHit?(v: Vehicle, dmg: number, byPid: number, hx: number, hy: number): void;
  onPickup?(p: SimPlayer, pk: Pickup): void;
  onAdd?(p: SimPlayer): void;
  /** a player left the world for good */
  onRemove?(p: SimPlayer): void;
}

/** Who gets a payout. The server's Party feature splits event and job money among party members
 *  nearby; without a policy the earner gets it all. */
export type PayoutPolicy = (p: SimPlayer, amount: number, reason: PayoutReason) => { p: SimPlayer; amount: number }[];

/** why money was paid (parties split some of these; `activity` logs them) */
export type PayoutReason =
  | 'kofolka' | 'bounty' | 'wanted' | 'escape' | 'cumil' | 'armored' | 'derby'
  | 'courier' | 'taxi' | 'tip' | 'samaritan' | 'race' | 'daily';
