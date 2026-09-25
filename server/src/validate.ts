// Server-side sanity checks for client-reported movement. Movement stays client-authoritative
// (see docs/multiplayer.md); these only reject impossible speeds, teleports and garbage.

/** metres per second a player can plausibly cover on foot (running is 7.2) */
export const FOOT_MAX = 7.2 * 1.5;
/** fastest vehicle (sport, 62 m/s) with nitro (x1.25) and the physics clamp (x1.15), plus slack */
export const CAR_MAX = 62 * 1.25 * 1.15 * 1.3;
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
 */
export function checkMove(prev: Pose | null, next: Pose, dtMs: number, inCar: boolean, bounds: Bounds): 'ok' | 'reject' | 'teleport' {
  if (!finite(next.x, next.y)) return 'reject';
  if (next.x < bounds.x0 || next.x > bounds.x1 || next.y < bounds.y0 || next.y > bounds.y1) return 'reject';
  if (!prev) return 'ok';
  const d = Math.hypot(next.x - prev.x, next.y - prev.y);
  if (d > TELEPORT_M) return 'teleport';
  // updates can bunch up after a stall, so clamp the time window generously
  const dt = Math.min(Math.max(dtMs, 50), 2000) / 1000;
  const max = (inCar ? CAR_MAX : FOOT_MAX) * dt + SLACK_M;
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
