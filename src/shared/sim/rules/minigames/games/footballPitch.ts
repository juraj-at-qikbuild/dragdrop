// Where Vydrž do 95. minúty (games/football.ts, docs/plans/minigames.md) is played: a pitch marked out
// on a parking lot near the player, clear of walls, kerbs, trees, bridges and the streets traffic
// drives through, with a goal at each end. Also the pitch's own frame (x along its length, the home
// team's goal at -x), which the game and its NPC drivers think in. DOM-free.
import type { Pen } from '../../../../entities/Vehicle';
import type { World } from '../../../../world/World';
import { bboxOf, dist, pointInRings, ringArea } from '../../../../util/math';

/** how far from the player a pitch may be (m, to its lot's middle) */
export const PITCH_REACH = 900;
/** the pitch's half-length (m), goals not included: at least, and at most (a bigger lot gets a pitch
 *  this big, where it fits best) */
export const HL_MIN = 15, HL_MAX = 28;
/** its half-width against the whole length, goals included */
const ASPECT = 0.62;
/** a goal's depth (m); its width is a share of the pitch's width, within these */
export const GOAL_D = 2.5;
const GOAL_W_MIN = 6, GOAL_W_MAX = 8;
/** the grid the lots are searched on (m), and how many of the nearest lots are tried */
const CELL = 2;
const LOTS_MAX = 14;
/** a bigger pitch is worth this much further to go (m of walking per m of half-length) */
const WORTH = 40;

/** A candidate lot: its outline, and how far its middle is. */
interface Lot {
  ring: number[];
  cx: number;
  cy: number;
  d: number;
}

/** The pitch for a round started at (x, y): on the best parking lot within `reach`, the nearest one
 *  unless one a little further holds a much bigger pitch. Null when no lot near enough has room. */
export function findPitch(world: World, x: number, y: number, reach = PITCH_REACH): { pitch: Pen; d: number } | null {
  const lots: Lot[] = [];
  for (const rings of world.data.areas.parking ?? []) {
    const ring = rings[0];
    if (!ring || ring.length < 6) continue;
    // (the smallest pitch with its goals is about 35 × 22 m)
    if (Math.abs(ringArea(ring)) < 2 * (HL_MIN + GOAL_D) * 2 * ASPECT * (HL_MIN + GOAL_D) * 0.9) continue;
    const b = bboxOf(ring);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const d = dist(cx, cy, x, y);
    if (d <= reach) lots.push({ ring, cx, cy, d });
  }
  lots.sort((a, b) => a.d - b.d);
  let best: { pitch: Pen; d: number; score: number } | null = null;
  for (const lot of lots.slice(0, LOTS_MAX)) {
    // (further lots can't beat the best any more, however big)
    if (best && HL_MAX - lot.d / WORTH <= best.score) break;
    const pitch = fitPitch(world, lot.ring);
    if (!pitch) continue;
    const d = dist(pitch.x, pitch.y, x, y);
    const score = pitch.hl - d / WORTH;
    if (!best || score > best.score) best = { pitch, d, score };
  }
  return best && { pitch: best.pitch, d: best.d };
}

/** The biggest pitch (up to HL_MAX) that fits on the lot `ring` along one of its longest sides: a
 *  grid of cells over it, each free when it's on the lot, clear of every wall, trunk and post, at
 *  street level, dry, outside every building and away from the car graph (a street through a car
 *  park brings its traffic), and for every cell as the middle the longest free rectangle round it
 *  (a summed-area table makes each try one lookup). */
export function fitPitch(world: World, ring: number[]): Pen | null {
  const sides: { a: number; l: number }[] = [];
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    const dx = ring[j] - ring[i], dy = ring[j + 1] - ring[i + 1];
    sides.push({ a: Math.atan2(dy, dx), l: Math.hypot(dx, dy) });
  }
  sides.sort((p, q) => q.l - p.l);
  const angles: number[] = [];
  for (const s of sides.slice(0, 3)) {
    const a = ((s.a % Math.PI) + Math.PI) % Math.PI;
    if (!angles.some((b) => Math.abs(Math.sin(a - b)) < 0.1)) angles.push(a);
  }
  const bb = bboxOf(ring);
  const mx = (bb.x0 + bb.x1) / 2, my = (bb.y0 + bb.y1) / 2;
  let best: { T: number; x: number; y: number; a: number; mid: number } | null = null;
  for (const a of angles.slice(0, 2)) {
    const ca = Math.cos(a), sa = Math.sin(a);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      const u = ring[i] * ca + ring[i + 1] * sa, v = -ring[i] * sa + ring[i + 1] * ca;
      (u0 = Math.min(u0, u)), (u1 = Math.max(u1, u)), (v0 = Math.min(v0, v)), (v1 = Math.max(v1, v));
    }
    const nu = Math.floor((u1 - u0) / CELL), nv = Math.floor((v1 - v0) / CELL);
    if (nu < 4 || nv < 4) continue;
    const W = nv + 1;
    // blocked cells, summed: S[(i + 1) * W + j + 1] counts them in [0, i] × [0, j]
    const S = new Int32Array((nu + 1) * W);
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        const u = u0 + (i + 0.5) * CELL, v = v0 + (j + 0.5) * CELL;
        const x = u * ca - v * sa, y = u * sa + v * ca;
        const bad =
          !pointInRings(x, y, [ring]) || !!world.collideCircle(x, y, CELL * 0.75, 0, false) || world.spawnLevel(x, y, 1) !== 0 ||
          world.inWater(x, y, 0) || world.insideBuilding(x, y) || !!world.car.segmentAt(x, y, 4);
        S[(i + 1) * W + j + 1] = (bad ? 1 : 0) + S[i * W + j + 1] + S[(i + 1) * W + j] - S[i * W + j];
      }
    const blocked = (i0: number, j0: number, i1: number, j1: number) => S[(i1 + 1) * W + j1 + 1] - S[i0 * W + j1 + 1] - S[(i1 + 1) * W + j0] + S[i0 * W + j0];
    // `k` cells either side of the middle cell along the length: T = (k + 0.5) cells, goals included
    const kMax = Math.floor((HL_MAX + GOAL_D) / CELL - 0.5);
    const fits = (i: number, j: number, k: number) => {
      const kw = Math.ceil((ASPECT * (k + 0.5) * CELL) / CELL - 0.5);
      if (i - k < 0 || i + k >= nu || j - kw < 0 || j + kw >= nv) return false;
      return blocked(i - k, j - kw, i + k, j + kw) === 0;
    };
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        if (!fits(i, j, 0)) continue;
        let lo = 0, hi = Math.min(kMax, i, nu - 1 - i);
        while (lo < hi) {
          const k = (lo + hi + 1) >> 1;
          if (fits(i, j, k)) lo = k;
          else hi = k - 1;
        }
        const T = (lo + 0.5) * CELL;
        const u = u0 + (i + 0.5) * CELL, v = v0 + (j + 0.5) * CELL;
        const x = u * ca - v * sa, y = u * sa + v * ca;
        // the biggest, and of equals the one nearest the lot's middle
        const mid = dist(x, y, mx, my);
        if (!best || T > best.T + 0.01 || (Math.abs(T - best.T) <= 0.01 && mid < best.mid)) best = { T, x, y, a, mid };
      }
  }
  if (!best) return null;
  // a hair inside what's free, so the boards never touch a wall
  const hl = Math.min(HL_MAX, best.T - GOAL_D - 0.3);
  if (hl < HL_MIN) return null;
  const hw = Math.round(ASPECT * (hl + GOAL_D) * 10) / 10;
  const gw = Math.max(GOAL_W_MIN, Math.min(GOAL_W_MAX, Math.round(hw * 0.45)));
  return { x: Math.round(best.x * 10) / 10, y: Math.round(best.y * 10) / 10, a: Math.round(best.a * 1000) / 1000, hl: Math.round(hl * 10) / 10, hw, gw, gd: GOAL_D };
}

/** The pitch's own frame: x along its length (the home team defends -x and attacks +x), y across. */
export class PitchFrame {
  readonly ca: number;
  readonly sa: number;
  constructor(readonly p: Pen) {
    this.ca = Math.cos(p.a);
    this.sa = Math.sin(p.a);
  }
  /** a point of the city, in the pitch's frame */
  lx(x: number, y: number) {
    return (x - this.p.x) * this.ca + (y - this.p.y) * this.sa;
  }
  ly(x: number, y: number) {
    return -(x - this.p.x) * this.sa + (y - this.p.y) * this.ca;
  }
  /** a point of the pitch, in the city */
  wx(lx: number, ly: number) {
    return this.p.x + lx * this.ca - ly * this.sa;
  }
  wy(lx: number, ly: number) {
    return this.p.y + lx * this.sa + ly * this.ca;
  }
  /** is (x, y) on the pitch, or within `pad` metres of it (goals included) */
  on(x: number, y: number, pad = 0) {
    return Math.abs(this.lx(x, y)) <= this.p.hl + this.p.gd + pad && Math.abs(this.ly(x, y)) <= this.p.hw + pad;
  }
}
