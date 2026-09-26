// Server-side sanity checks for client-reported movement. Movement stays client-authoritative
// (see docs/multiplayer.md); these only reject impossible speeds, teleports and garbage.
import type { Level } from '../../src/shared/world/World';

/** metres per second a player can plausibly cover on foot (running is 7.2) */
export const FOOT_MAX = 7.2 * 1.5;
/** fastest vehicle (sport, 62 m/s) with nitro (x1.25) and the physics clamp (x1.15), plus slack */
export const CAR_MAX = 62 * 1.25 * 1.15 * 1.3;
/** downed players crawl at up to 0.8 m/s (Revive; Room.applyReport), plus the same slack factor as FOOT_MAX */
export const CRAWL_MAX = 0.8 * 1.5;
/** a jump larger than this is always a teleport */
export const TELEPORT_M = 40;
/** extra distance allowed per update to absorb jitter and packet bunching */
const SLACK_M = 2;

export interface Pose {
  x: number;
  y: number;
}

/** map extent plus margin; positions outside are rejected */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const finite = (...v: number[]) => v.every(Number.isFinite);

/**
 * Checks one movement step. `dtMs` is the wall-clock time since the previous accepted update.
 * Returns 'ok', 'reject' (drop the update) or 'teleport' (drop it and send the client a correction).
 * `maxSpeed` overrides the inCar/on-foot pick (Revive: a downed player may only crawl, CRAWL_MAX).
 */
export function checkMove(prev: Pose | null, next: Pose, dtMs: number, inCar: boolean, bounds: Bounds, maxSpeed?: number): 'ok' | 'reject' | 'teleport' {
  if (!finite(next.x, next.y)) return 'reject';
  if (next.x < bounds.x0 || next.x > bounds.x1 || next.y < bounds.y0 || next.y > bounds.y1) return 'reject';
  if (!prev) return 'ok';
  const d = Math.hypot(next.x - prev.x, next.y - prev.y);
  if (d > TELEPORT_M) return 'teleport';
  // updates can bunch up after a stall, so clamp the time window generously
  const dt = Math.min(Math.max(dtMs, 50), 2000) / 1000;
  const max = (maxSpeed ?? (inCar ? CAR_MAX : FOOT_MAX)) * dt + SLACK_M;
  return d <= max ? 'ok' : 'teleport';
}

/** Simple token bucket for per-connection rate limits. */
export class Bucket {
  private tokens: number;
  private last: number;
  constructor(private rate: number, private burst: number, now: number) {
    this.tokens = burst;
    this.last = now;
  }
  take(now: number, n = 1): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

// ------------------------------------------------------------- hit claims

/** a claimed hit may be this far off the target's recorded position (m), plus 5 cm per m/s it moved */
export const HIT_TOLERANCE = 0.75;
/** rewinding further than this into the past isn't allowed (ms) */
export const MAX_REWIND_MS = 1000;

export interface PelletClaim {
  /** muzzle */
  ox: number;
  oy: number;
  /** pellet direction */
  a: number;
  /** claimed end point */
  hx: number;
  hy: number;
  range: number;
}

export interface TargetThen {
  x: number;
  y: number;
  lvl: Level;
  alive: boolean;
  speed: number;
  /** body radius: ped radius, or half the car's width plus half its length for cars */
  radius: number;
}

/**
 * Is this pellet's claimed hit plausible? The end point must lie on the pellet's ray, within range,
 * near where the target was at the shooter's render time, with no wall in between.
 * `wallT` is world.raycast(ox, oy, hx, hy): the fraction of the way before the first wall (1 = clear).
 */
export function plausibleHit(c: PelletClaim, target: TargetThen | null, lvl: Level, wallT: number): boolean {
  if (!target || !target.alive || target.lvl !== lvl) return false;
  const dx = c.hx - c.ox, dy = c.hy - c.oy;
  const along = dx * Math.cos(c.a) + dy * Math.sin(c.a);
  const off = Math.abs(-dx * Math.sin(c.a) + dy * Math.cos(c.a));
  if (along < -0.5 || along > c.range + 1 || off > 0.3) return false;
  if (Math.hypot(c.hx - target.x, c.hy - target.y) > target.radius + HIT_TOLERANCE + 0.05 * target.speed) return false;
  return wallT >= 0.98;
}

/** clamp a client-supplied render time to the rewind window */
export function rewindTime(rt: unknown, now: number) {
  const t = typeof rt === 'number' && Number.isFinite(rt) ? rt : now;
  return Math.min(now, Math.max(now - MAX_REWIND_MS, t));
}
