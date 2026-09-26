// Aim assist for touch play: which target the fire button locks onto, and a light pull of a hand-aimed
// drag toward the target right next to it. Pure (no DOM, no world): the caller builds the candidates
// and supplies the line-of-sight test, so test/client/aimAssist.test.ts can check the choice alone.
// Only the angle changes: a gun shot is still traced and validated as any other (Room.onFire).

export interface AimCandidate {
  /** unique across peds and cars (see `aimKey`) */
  key: number;
  x: number;
  y: number;
  /** someone after the player: a cop while wanted, a civilian fighting them or phoning the police */
  threat: boolean;
  /** another player: helped, never hunted (see `playerCone`) */
  player: boolean;
}

export interface AimOpts {
  /** the weapon's reach (m) */
  range: number;
  /** half-angle of the cone ahead of the facing (rad) anyone can be picked in; Math.PI = all around */
  cone: number;
  /** ...wider for threats */
  threatCone: number;
  /** ...narrower for other players, so a touch player gets aim help but no aimbot over a mouse */
  playerCone: number;
}

/** ped and car ids come from separate pools */
export const aimKey = (id: number, car: boolean) => (car ? -id : id);

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** how much closer (in score) a threat counts, and the current target over a newcomer */
const THREAT_BONUS = 0.6;
const STICKY = 0.3;

/** The best target from (x, y) facing `facing`, or null. Score: distance over range plus the angle
 *  off the facing over the cone, less a bonus for threats and for the target already locked
 *  (`prev`, 0 = none) so the lock doesn't flicker between two similar targets. */
export function pickTarget(
  from: { x: number; y: number },
  facing: number,
  candidates: Iterable<AimCandidate>,
  o: AimOpts,
  los: (x: number, y: number) => boolean,
  prev = 0,
): AimCandidate | null {
  let best: AimCandidate | null = null, bestScore = Infinity;
  for (const c of candidates) {
    const d = Math.hypot(c.x - from.x, c.y - from.y);
    if (d > o.range || d < 1e-3) continue;
    const off = Math.abs(wrap(Math.atan2(c.y - from.y, c.x - from.x) - facing));
    const cone = c.player ? Math.min(o.playerCone, o.cone) : c.threat ? Math.max(o.cone, o.threatCone) : o.cone;
    if (off > cone) continue;
    let score = d / o.range + off / Math.max(cone, 0.3);
    if (c.threat && !c.player) score -= THREAT_BONUS;
    if (prev && c.key === prev) score -= STICKY;
    if (score >= bestScore || !los(c.x, c.y)) continue;
    best = c;
    bestScore = score;
  }
  return best;
}

/** A hand-aimed angle pulled onto the target it's already almost on (within `maxOff` rad), with that
 *  target; the angle unchanged and null when none is that close. */
export function magnet(
  from: { x: number; y: number },
  angle: number,
  candidates: Iterable<AimCandidate>,
  range: number,
  los: (x: number, y: number) => boolean,
  maxOff = 0.2,
): { angle: number; target: AimCandidate | null } {
  let best: AimCandidate | null = null, bestOff = maxOff, bestA = angle;
  for (const c of candidates) {
    const d = Math.hypot(c.x - from.x, c.y - from.y);
    if (d > range || d < 1e-3) continue;
    const a = Math.atan2(c.y - from.y, c.x - from.x);
    const off = Math.abs(wrap(a - angle));
    if (off >= bestOff || !los(c.x, c.y)) continue;
    best = c;
    bestOff = off;
    bestA = a;
  }
  return { angle: bestA, target: best };
}
