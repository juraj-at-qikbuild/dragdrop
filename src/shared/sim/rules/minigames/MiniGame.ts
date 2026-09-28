// One mini-game round's own rules (docs/plans/minigames.md): the base every game in games/ extends. The
// MiniGames rule runs the round around it: the lobby, who's in it, what each player is sent, paying
// out and cleaning up. A game only says how it plays: where it happens (create), what starts when the
// lobby is over (start), what changes each step (update), what a player sees (view) and what the
// action key does (act). Everything it puts into the city it adds through spawn…(), so it goes again
// when the round ends. DOM-free, and never Math.random (the Sim's rng): it runs on the server and
// offline alike.
import type { Sim, Crime } from '../../Sim';
import type { PlayerState, SimPlayer } from '../../SimPlayer';
import type { Vehicle } from '../../../entities/Vehicle';
import type { Ped } from '../../../entities/Ped';
import type { Prop } from '../../../entities/Props';
import type { MiniKind, MiniPhase, MiniState } from './types';
import { MINI_INFO } from './catalog';

/** What a game shows one player; the rule adds the rest of MiniState (the round, the phase, the time
 *  left, the players). */
export type MiniView = Pick<MiniState, 'goal' | 'stats' | 'bar' | 'marks' | 'act' | 'x'> & { board?: MiniState['board'] };

/** How one player did: the money (paid when the round ends), the points (by default 1 per €5 of it),
 *  and a line for the result card. */
export interface MiniOutcome {
  pay: number;
  points?: number;
  text: string;
}

/** The round a game runs in, as the rule keeps it: the players in it (the starter first), where it is
 *  (the Aktivity panel's "near you", joining from nearby), the phase and the time left in it. */
export interface MiniRound {
  readonly id: number;
  readonly kind: MiniKind;
  /** who started it (passes on to the next player if they leave during the lobby) */
  owner: SimPlayer;
  readonly players: SimPlayer[];
  /** where it is: the game can move it (to its arena, its zone) in create() */
  x: number;
  y: number;
  phase: MiniPhase;
  left: number;
  /** players when the lobby ended (a group round makes the news) */
  started: number;
}

/** The pieces of one game. `create` in the game's MiniGameDef builds one for a new round. */
export abstract class MiniGame {
  /** the live phase's length (s); 0: the game ends itself (finish) */
  duration = 0;
  /** others may join after the lobby, taking part from then on */
  late = false;
  /** how the round went: set by finish() */
  over = false;
  /** points per player id: the standings (board()), and the place in a group round */
  protected points = new Map<number, number>();
  private outcomes = new Map<number, MiniOutcome>();
  private owned = { vehicles: new Set<Vehicle>(), peds: new Set<Ped>(), props: new Set<Prop>() };

  constructor(
    readonly sim: Sim,
    readonly round: MiniRound,
  ) {}

  get kind() {
    return this.round.kind;
  }

  get players(): readonly SimPlayer[] {
    return this.round.players;
  }

  /** is `p` in this round */
  has(p: SimPlayer) {
    return this.round.players.includes(p);
  }

  // ------------------------------------------------------------------------------ the game's own
  /** the lobby is over: put the round's things in the city and begin */
  abstract start(): void;
  /** one step of the live phase (dt: seconds); call finish() when it's decided */
  abstract update(dt: number): void;
  /** what `p` sees now */
  abstract view(p: SimPlayer): MiniView;
  /** what `p` sees while the lobby waits (defaults to a line; a game can show its zone already) */
  lobbyView?(p: SimPlayer): MiniView;
  /** `p` pressed the action key */
  act?(p: SimPlayer): void;
  /** `p` joined (in the lobby, or late if `late` is set) */
  onJoin?(p: SimPlayer): void;
  /** `p` left or dropped out (the rule takes them off the round right after) */
  onLeave?(p: SimPlayer): void;
  /** the live phase's time ran out (with a `duration`): by default it's over, as it stands */
  onTimeout() {
    this.finish();
  }
  // the Sim's hooks, passed on for every round that's on (check `has(p)` where it matters)
  onState?(p: SimPlayer, from: PlayerState, to: PlayerState, by?: SimPlayer): void;
  onEnter?(p: SimPlayer, v: Vehicle): void;
  onExit?(p: SimPlayer, v: Vehicle): void;
  onVehicleHit?(v: Vehicle, dmg: number, byPid: number, hx: number, hy: number): void;
  allowCrime?(p: SimPlayer, kind: Crime, target?: SimPlayer): boolean;
  allowPvp?(attacker: SimPlayer, victim: SimPlayer): boolean;

  /** A player who's wasted or busted is out of the round, unless the game says otherwise: true keeps
   *  them in (a game that lets them carry on after the hospital). */
  keepAfterRespawn?(p: SimPlayer): boolean;

  // ------------------------------------------------------------------------------- the outcome
  /** the round is decided: it shows the results and pays out (the rule does, once this is set) */
  finish() {
    this.over = true;
  }

  /** how `p` did (the last call wins) */
  outcome(p: SimPlayer, o: MiniOutcome) {
    this.outcomes.set(p.id, { ...o, pay: Math.max(0, Math.round(o.pay)) });
  }

  /** the rule reads it when the round ends: what each player gets */
  outcomeOf(p: SimPlayer): MiniOutcome | undefined {
    return this.outcomes.get(p.id);
  }

  /** add to `p`'s standing */
  addPoints(p: SimPlayer, n: number) {
    this.points.set(p.id, (this.points.get(p.id) ?? 0) + n);
  }

  pointsOf(p: SimPlayer) {
    return this.points.get(p.id) ?? 0;
  }

  /** the players by their points, best first (ties keep the order they joined in) */
  ranked(): SimPlayer[] {
    return [...this.round.players].sort((a, b) => this.pointsOf(b) - this.pointsOf(a));
  }

  /** `p`'s place in the standings (1 = first) */
  placeOf(p: SimPlayer) {
    return this.ranked().indexOf(p) + 1;
  }

  /** the standings for the HUD: [nick, points], best first (none alone) */
  board(): [string, number][] | undefined {
    if (this.round.players.length < 2) return undefined;
    return this.ranked().map((p) => [p.nick, Math.round(this.pointsOf(p))]);
  }

  // ------------------------------------------------------------------------------------ helpers
  /** where `p` is: their car or their figure */
  pos(p: SimPlayer) {
    return p.focus();
  }

  /** a line on `p`'s screen */
  msg(p: SimPlayer, text: string, color = '#fff59d', time = 2.5) {
    this.sim.events.toPlayer(p.id, { k: 'msg', title: '', text, time, color });
  }

  /** a line on every player's screen */
  tell(text: string, color = '#fff59d', time = 2.5) {
    for (const p of this.round.players) this.msg(p, text, color, time);
  }

  /** floating text over (x, y) for `p` (a "+1", "POKUTA!") */
  pop(p: SimPlayer, text: string, x: number, y: number) {
    this.sim.events.toPlayer(p.id, { k: 'style', label: text, cash: 0, x, y });
  }

  get title() {
    return MINI_INFO[this.round.kind].title;
  }

  get color() {
    return MINI_INFO[this.round.kind].color;
  }

  // ------------------------------------------------------------ what the game puts in the city
  /** a vehicle for the round: it never despawns (mission), and goes when the round ends */
  spawnVehicle(v: Vehicle): Vehicle {
    v.mission = true;
    this.sim.addVehicle(v);
    this.owned.vehicles.add(v);
    return v;
  }

  /** a person for the round, moved by the game (kinematic: the AI leaves them alone and never
   *  despawns them); they go when the round ends */
  spawnPed(p: Ped, kinematic = true): Ped {
    p.kinematic = kinematic;
    this.sim.addPed(p);
    this.owned.peds.add(p);
    return p;
  }

  /** a prop for the round (a cone, a barrier): it goes when the round ends */
  spawnProp(p: Prop): Prop {
    p.life = 1e9;
    this.sim.addProp(p);
    this.owned.props.add(p);
    return p;
  }

  /** take one of the round's things out of the city now */
  despawn(o: Vehicle | Ped | Prop) {
    const sim = this.sim;
    if (this.owned.vehicles.delete(o as Vehicle)) {
      const v = o as Vehicle;
      if (v.driver && !v.driver.playerId) sim.peds = sim.peds.filter((q) => q !== v.driver);
      // a player still in it is put down beside it first
      for (const p of sim.players.values()) if (p.ped.vehicle === v) sim.exitVehicle(p, true);
      if (sim.vehicles.includes(v)) sim.removeVehicle(v);
    } else if (this.owned.peds.delete(o as Ped)) {
      const ped = o as Ped;
      sim.peds = sim.peds.filter((q) => q !== ped);
    } else if (this.owned.props.delete(o as Prop)) {
      const pr = o as Prop;
      sim.police.props = sim.police.props.filter((q) => q !== pr);
    }
  }

  /** the round is over and gone: everything it put in the city goes (a game with more to undo
   *  extends this, calling super) */
  dispose() {
    for (const v of [...this.owned.vehicles]) this.despawn(v);
    for (const p of [...this.owned.peds]) this.despawn(p);
    for (const pr of [...this.owned.props]) this.despawn(pr);
  }
}

/** A kind of mini-game, registered with the rule (games/index.ts). */
export interface MiniGameDef {
  kind: MiniKind;
  /** the lobby's wait for others (s) when anyone else could join; alone it's a short count-in */
  lobby?: number;
  /** why `p` can't start or join one now (null: they can) — "Potrebuješ auto." */
  check?(sim: Sim, p: SimPlayer): string | null;
  /** set up a new round for its starter (`round.owner`): a game, or why it can't start here */
  create(sim: Sim, round: MiniRound): MiniGame | string;
}
