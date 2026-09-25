// Police helicopter state: follows its target player with lag at altitude and fires bursts at 5 stars.
// Shared by the browser and the game server; drawing lives in src/render/drawHeli.ts.
import { dist, lerp } from '../util/math';

/** what the helicopter follows: a player's focus position and, if driving, their car's velocity */
export interface HeliTarget {
  x: number;
  y: number;
  vx: number;
  vy: number;
  inCar: boolean;
}

/** coverage radius of the searchlight / spotter */
export const HELI_SEE_R = 24;

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
  /** last known target position (drawn as the searchlight on clients) */
  tx = 0;
  ty = 0;

  spawn(t: HeliTarget) {
    this.x = t.x + 40;
    this.y = t.y - 40;
    this.tx = t.x;
    this.ty = t.y;
    this.spawned = true;
  }

  /** @param fire called with an aim angle when it opens fire (5 stars, roughly overhead) */
  update(dt: number, t: HeliTarget, stars: number, rand: () => number, fire: (angle: number) => void) {
    if (!this.spawned) return;
    this.tx = t.x;
    this.ty = t.y;
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
    if (stars >= 5 && this.fireCooldown <= 0 && dist(this.x, this.y, t.x, t.y) < 26) {
      this.fireCooldown = 1.4 + rand() * 0.8;
      fire(Math.atan2(t.y - this.y, t.x - this.x));
    }
  }

  /** rotor and nav-light animation (clients run this for mirrors too) */
  animate(dt: number) {
    this.rotor += dt * 55;
    this.navBlink += dt;
  }

  /** does the heli's view (or, at night, its searchlight) currently cover this point? */
  sees(x: number, y: number): boolean {
    return this.spawned && dist(this.x, this.y, x, y) < HELI_SEE_R;
  }
}
