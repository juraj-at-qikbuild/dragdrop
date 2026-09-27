// Trams (docs/plans/gameplay.md, Phase 3): ride one, or drive it from the front cab.
//
// A rider gets on at an open door of a tram standing at a stop, and off at a door once it's stopped
// again. Aboard they move with it and aren't drawn, nothing outside touches them (Physics, Combat, the
// server's snapshots), and a police unit takes twice as long to pick them out of the passengers
// (Pursuit). A driver takes the cab of a stopped tram, which is a crime (like a police car): the
// throttle and the brake, the steering picks the branch at the next junction (Tram.drive), H rings
// the bell, and the tram goes back to the AI when they leave or drop. Both modes: offline the Game asks
// straight away, online by the `tram` message (server/src/Room.ts); the tram stays the simulation's.
import type { Tram } from '../../entities/Tram';
import type { Level } from '../../world/World';
import { clamp, dist } from '../../util/math';
import type { Sim } from '../Sim';
import type { PlayerState, SimPlayer } from '../SimPlayer';
import type { SimRule } from './SimRule';

export type TramOp = 'board' | 'cab' | 'off';

/** a door's step this close (m) takes a player on foot aboard a tram standing at a stop */
export const DOOR_REACH = 2.2;
/** this close (m) to a stopped tram's nose, they climb into its cab */
export const CAB_REACH = 2.5;
/** slower than this (m/s), a tram is stopped: its cab can be taken, and anyone aboard can get off */
export const TRAM_STOPPED = 0.5;
/** where in the cab its driver sits, behind the nose (m) */
const CAB_AT = 1.2;

/** Is tram `t` standing at one of the `stops` (World.tramStops), where it opens its doors? Online the
 *  client goes by this (a snapshot doesn't say whether the doors are open: NetSimHost). */
export function atTramStop(stops: ArrayLike<number>, t: Tram): boolean {
  if (t.speed > 0.2) return false;
  for (let i = 0; i < stops.length; i += 2) if (Math.abs(stops[i] - t.x) < 3 && Math.abs(stops[i + 1] - t.y) < 3) return true;
  return false;
}

/** What a player on foot at (x, y) could do with a tram right there: take the cab of a stopped one
 *  nobody drives (by its nose), or get on one standing at a stop (by a door), whichever is nearer.
 *  The Game's prompt and the rule go by the same. */
export function tramUse(trams: readonly Tram[], x: number, y: number, level: Level): { t: Tram; op: 'board' | 'cab' } | null {
  let best: { t: Tram; op: 'board' | 'cab' } | null = null, bd = Infinity;
  for (const t of trams) {
    if (t.level !== level || !t.sections.length || Math.abs(t.x - x) > 45 || Math.abs(t.y - y) > 45) continue;
    if (t.speed < TRAM_STOPPED && !t.driver) {
      const d = dist(t.x + Math.cos(t.angle) * 0.8, t.y + Math.sin(t.angle) * 0.8, x, y);
      if (d < CAB_REACH && d < bd) (bd = d), (best = { t, op: 'cab' });
    }
    if (t.dwell > 0.3) {
      const s = t.doorSpots();
      for (let i = 0; i < s.length; i += 2) {
        const d = dist(s[i], s[i + 1], x, y);
        if (d < DOOR_REACH && d < bd) (bd = d), (best = { t, op: 'board' });
      }
    }
  }
  return best;
}

interface Aboard {
  t: Tram;
  cab: boolean;
}

export class Trams implements SimRule {
  readonly id = 'trams';
  private aboard = new Map<SimPlayer, Aboard>();

  constructor(private sim: Sim) {}

  /** the tram `p` is on, and whether in its cab (tests, the server) */
  of(p: SimPlayer): Readonly<Aboard> | null {
    return this.aboard.get(p) ?? null;
  }

  /** `p` asks to get on a tram, take its cab, or get off (the Game offline, a `tram` message online).
   *  Whether it happened. */
  act(p: SimPlayer, op: TramOp): boolean {
    const sim = this.sim, ped = p.ped;
    if (p.state !== 'play') return false;
    if (op === 'off') return this.leave(p);
    if (ped.vehicle || ped.aboard) return false;
    const use = tramUse(sim.trams, ped.x, ped.y, ped.level);
    if (!use || use.op !== op) return false;
    if (op === 'cab') {
      use.t.takeCab(p.id);
      sim.crime(p, 'stealTram');
    }
    this.aboard.set(p, { t: use.t, cab: op === 'cab' });
    ped.aboard = use.t;
    this.place(p, use.t, op === 'cab');
    sim.events.toPlayer(p.id, { k: 'tram', id: use.t.id, cab: op === 'cab' });
    return true;
  }

  /** the cab's controls, from its driver: throttle and brake, the branch to take, the bell */
  drive(p: SimPlayer, throttle: number, steer: number, bell: boolean) {
    const a = this.aboard.get(p);
    if (!a?.cab || p.state !== 'play') return;
    const t = a.t;
    t.ctl.throttle = clamp(throttle, -1, 1) || 0;
    t.ctl.steer = clamp(steer, -1, 1) || 0;
    if (bell && t.bell <= 0) {
      t.bell = 1.2;
      this.sim.events.bell(t.x, t.y);
    }
  }

  step() {
    for (const [p, a] of this.aboard) {
      // the tram went (nobody near any more), or something else took them off it (a teleport)
      if (p.ped.aboard !== a.t || !this.sim.trams.includes(a.t)) {
        this.leave(p, true);
        continue;
      }
      // a driver who's gone (disconnected, or in the pause menu online) brakes to a stop, and the AI
      // has it back
      if (a.cab && (!p.connected || p.away)) {
        a.t.ctl.throttle = -1;
        a.t.ctl.steer = 0;
        if (a.t.speed < TRAM_STOPPED && this.leave(p)) continue;
      }
      this.place(p, a.t, a.cab);
    }
  }

  onState(p: SimPlayer, _from: PlayerState, to: PlayerState) {
    if (to !== 'play') this.leave(p, true);
  }

  onRemove(p: SimPlayer) {
    this.leave(p, true);
  }

  /** Off the tram once it's stopped (`force`: now, wherever it is), at the nearest door with room:
   *  the cab's own at the front, for its driver. The cab goes back to the AI. */
  private leave(p: SimPlayer, force = false): boolean {
    const a = this.aboard.get(p);
    if (!a) return false;
    const t = a.t, ped = p.ped;
    if (!force && t.speed >= TRAM_STOPPED) return false;
    const at = this.door(t, a.cab, ped.x, ped.y);
    this.aboard.delete(p);
    if (a.cab && t.driver === p.id) t.takeCab(0);
    if (ped.aboard === t) ped.aboard = null;
    ped.x = at.x;
    ped.y = at.y;
    ped.vx = ped.vy = 0;
    ped.level = t.level;
    ped.levelInit = true;
    this.sim.events.toPlayer(p.id, { k: 'tram', id: 0, x: at.x, y: at.y });
    return true;
  }

  /** a step outside the door nearest (x, y) that has room (the front two, from the cab) */
  private door(t: Tram, cab: boolean, x: number, y: number): { x: number; y: number } {
    const w = this.sim.world, s = t.doorSpots();
    let best: { x: number; y: number } | null = null, bd = Infinity;
    for (let i = 0; i < (cab ? 4 : s.length); i += 2) {
      const dx = s[i], dy = s[i + 1];
      if (w.collideCircle(dx, dy, 0.4, t.level) || w.inWater(dx, dy, t.level) || w.insideBuilding(dx, dy)) continue;
      const d = dist(dx, dy, x, y);
      if (d < bd) (bd = d), (best = { x: dx, y: dy });
    }
    return best ?? (s.length ? w.walkableNear(s[0], s[1]) : { x: t.x, y: t.y });
  }

  /** a rider in the middle of the tram, its driver in the cab: moving with it */
  private place(p: SimPlayer, t: Tram, cab: boolean) {
    const ped = p.ped, ca = Math.cos(t.angle), sa = Math.sin(t.angle);
    const mid = t.sections[Math.min(1, t.sections.length - 1)];
    ped.x = cab || !mid ? t.x - ca * CAB_AT : mid.x;
    ped.y = cab || !mid ? t.y - sa * CAB_AT : mid.y;
    ped.vx = ca * t.speed;
    ped.vy = sa * t.speed;
    ped.angle = t.angle;
    ped.level = t.level;
  }
}
