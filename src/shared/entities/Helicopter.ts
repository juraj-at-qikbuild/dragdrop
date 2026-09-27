// Police helicopter state: follows the player it's after with lag at altitude, or searches where they
// were last seen, its searchlight sweeping round (docs/plans/gameplay.md, Phase 1); fires bursts at 5
// stars, only at a player it sees. Shared by the browser and the game server; drawing lives in
// src/render/drawHeli.ts.
import { dist, lerp } from '../util/math';
import { heliSees } from '../sim/sight';

/** what the helicopter follows: a player's focus position and, if driving, their car's velocity */
export interface HeliTarget {
  x: number;
  y: number;
  vx: number;
  vy: number;
  inCar: boolean;
}

/** while searching, the beam sweeps a circle this wide (m) round the point the helicopter is over */
const SWEEP_R = 14;
/** ...at this rate (rad/s) */
const SWEEP_RATE = 0.9;

export class Helicopter {
  /** network id, assigned by the Sim */
  id = 0;
  /** the player it is after */
  targetPid = 0;
  x = 0;
  y = 0;
  altitude = 42;
  angle = 0;
  rotor = 0;
  vx = 0;
  vy = 0;
  spawned = false;
  private fireCooldown = 2;
  navBlink = 0;
  /** where the searchlight points (on the wire; clients draw the beam there): on the player it sees,
   *  else sweeping round the point of the search it's over */
  tx = 0;
  ty = 0;
  private sweep = 0;

  spawn(t: HeliTarget) {
    this.x = t.x + 40;
    this.y = t.y - 40;
    this.tx = t.x;
    this.ty = t.y;
    this.spawned = true;
  }

  /** @param t the player it sees, or the point of the search it's heading for
   *  @param seen whether it sees `t` (else it searches: it hovers over the point, the beam sweeping)
   *  @param fire called with an aim angle when it opens fire (5 stars, roughly overhead, and only at
   *  a player it sees) */
  update(dt: number, t: HeliTarget, stars: number, rand: () => number, fire: (angle: number) => void, seen = true) {
    if (!this.spawned) return;
    // the beam: locked on a player it sees, sweeping round the search point otherwise
    this.sweep += dt * SWEEP_RATE;
    const lx = seen ? t.x : t.x + Math.cos(this.sweep) * SWEEP_R, ly = seen ? t.y : t.y + Math.sin(this.sweep) * SWEEP_R;
    const kb = Math.min(1, dt * (seen ? 6 : 1.5));
    this.tx = lerp(this.tx, lx, kb);
    this.ty = lerp(this.ty, ly, kb);
    // lag behind the target: spring toward a point offset ahead of their motion
    const lead = t.inCar ? 6 : 2;
    const gx = t.x + (t.inCar ? t.vx : 0) * lead * 0.3, gy = t.y + (t.inCar ? t.vy : 0) * lead * 0.3;
    const dx = gx - this.x, dy = gy - this.y;
    const k = Math.min(1, dt * 0.8);
    this.vx = lerp(this.vx, dx * 1.1, k);
    this.vy = lerp(this.vy, dy * 1.1, k);
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    const want = Math.atan2(dy, dx);
    if (Math.hypot(dx, dy) > 2) {
      let d = want - this.angle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.angle += d * Math.min(1, dt * 2);
    }
    this.animate(dt);
    this.fireCooldown -= dt;
    if (seen && stars >= 5 && this.fireCooldown <= 0 && dist(this.x, this.y, t.x, t.y) < 26) {
      this.fireCooldown = 1.4 + rand() * 0.8;
      fire(Math.atan2(t.y - this.y, t.x - this.x));
    }
  }

  /** rotor and nav-light animation (clients run this for mirrors too) */
  animate(dt: number) {
    this.rotor += dt * 55;
    this.navBlink += dt;
  }

  /** does its view (by day the circle under it, after dark its beam) cover this point? `dark`:
   *  sight.ts's darkness. Roofs, passages and decks in the way are the caller's (World.covered). */
  sees(x: number, y: number, dark: number): boolean {
    return this.spawned && heliSees(this, dark, x, y);
  }
}
