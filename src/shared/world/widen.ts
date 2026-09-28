// Wider streets: a game's carriageways, not the surveyor's. Every car road (not a bridge deck, whose
// railings are its edge) is made up to ROAD_WIDEN times as wide as the map has it, as far as its
// own street has room: it stops short of the buildings, walls, fences, hedges, bollards, tree
// trunks and water on either side, wherever along it they come closest. What goes with a road's
// width goes with it: the graph edges along it (so the lanes spread, people walk on the new
// pavement and parked cars stand at the new kerb), its zebra crossings, speed bumps and stop signs;
// street furniture, lamps and trees the wider road would cover move out to its new kerb.
//
// The map builder does it before it bakes the lanes and walking lines (scripts/build-map.mjs), and
// scripts/widen-map.mjs did it to the map in the repository: the game loads the result, so it costs
// nothing at startup. `MapJSON.wide` says it's been done.
import { hypot } from '../util/math';
import type { EdgeJSON, MapJSON, RoadJSON } from '../types';
import type { World } from './World';

/** the most a car road is widened by (its width × this) */
export const ROAD_WIDEN = 1.35;
/** a road's edge keeps this far from anything solid (m) */
const MARGIN = 0.35;
/** how finely the river beside a road is felt out (m), along it and across it */
const SAMPLE = 4;
const STEP = 0.5;
/** a road's first and last metres (its junctions' corners, which turning traffic cuts anyway) don't count */
const SKIP = 3;
/** the road classes that are car roads (RoadClass: motorway to service) */
const CAR_MAX = 7;
/** street furniture, lamps and trees the wider road would cover stand this far outside its new edge */
const KERB_GAP = 0.4;

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** half-widths before and after */
  hw0: number;
  hw1: number;
  road: RoadJSON;
  /** the road's widening factor (new width / old) */
  k: number;
}

/** Widen the car roads of `map` (built into `world`, which must be the map as it is now) and move
 *  what goes with them. Returns how many roads got wider. */
export function widenRoads(map: MapJSON, world: World): number {
  if (map.wide) return 0;
  // each road's room: how close anything solid comes to its centre line, anywhere along it but its
  // ends, less its thickness and the margin (and the river, felt out beside it)
  const segs: Seg[] = [];
  let widened = 0;
  for (const r of map.roads) {
    if (r.c > CAR_MAX || r.b) continue;
    const hw = r.w / 2, max = hw * ROAD_WIDEN;
    let total = 0;
    for (let i = 0; i < r.p.length - 2; i += 2) total += hypot(r.p[i + 2] - r.p[i], r.p[i + 3] - r.p[i + 1]);
    let room = max, s0 = 0;
    for (let i = 0; i < r.p.length - 2 && room > hw; i += 2) {
      const px = r.p[i], py = r.p[i + 1], dx = r.p[i + 2] - px, dy = r.p[i + 3] - py, L = hypot(dx, dy);
      if (L < 1e-6) continue;
      const t0 = Math.max(0, (SKIP - s0) / L), t1 = Math.min(1, (total - SKIP - s0) / L);
      s0 += L;
      if (t1 <= t0) continue;
      const ax = px + dx * t0, ay = py + dy * t0, bx = px + dx * t1, by = py + dy * t1;
      const cx = (ax + bx) / 2, cy = (ay + by) / 2;
      world.forWalls(cx, cy, (L * (t1 - t0)) / 2 + max + MARGIN + 1, (wx, wy, vx, vy, ht, flags) => {
        // (sight-only lines are no obstacle; everything else, low or not, is)
        if (flags & 4) return;
        const d = segSegDist(ax, ay, bx, by, wx, wy, vx, vy) - ht - MARGIN;
        if (d < room) room = Math.max(hw, d);
      });
      const nx = -dy / L, ny = dx / L;
      for (let d = 0; d <= L * (t1 - t0) && room > hw; d += SAMPLE) {
        const x = ax + (dx / L) * d, y = ay + (dy / L) * d;
        for (const side of [1, -1])
          for (let o = hw + STEP; o < room + STEP / 2; o += STEP)
            if (world.inWater(x + side * nx * o, y + side * ny * o, 0)) {
              room = Math.max(hw, o - STEP);
              break;
            }
      }
    }
    const w1 = Math.max(r.w, Math.floor(Math.min(room, max) * 2 * 10) / 10);
    const k = w1 / r.w;
    for (let i = 0; i < r.p.length - 2; i += 2) segs.push({ ax: r.p[i], ay: r.p[i + 1], bx: r.p[i + 2], by: r.p[i + 3], hw0: hw, hw1: w1 / 2, road: r, k });
    if (w1 > r.w) widened++;
    r.w = w1;
  }

  // a grid of the car roads' segments, for finding the road under a point
  const G = 16;
  const grid = new Map<number, Seg[]>();
  const key = (gx: number, gy: number) => gx * 65536 + gy;
  for (const s of segs) {
    const pad = s.hw1 + 2;
    for (let gx = Math.floor((Math.min(s.ax, s.bx) - pad) / G); gx <= Math.floor((Math.max(s.ax, s.bx) + pad) / G); gx++)
      for (let gy = Math.floor((Math.min(s.ay, s.by) - pad) / G); gy <= Math.floor((Math.max(s.ay, s.by) + pad) / G); gy++) {
        const k = key(gx, gy);
        const c = grid.get(k);
        if (c) c.push(s);
        else grid.set(k, [s]);
      }
  }
  /** where (x, y) is across a segment: its distance from the centre line and the offset from there
   *  (ex, ey), and the segment's direction (ux, uy) */
  const across = (s: Seg, x: number, y: number) => {
    const dx = s.bx - s.ax, dy = s.by - s.ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((x - s.ax) * dx + (y - s.ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x - s.ax - dx * t, ey = y - s.ay - dy * t;
    return { d: hypot(ex, ey), ex, ey, ux: dx / Math.sqrt(l2 || 1), uy: dy / Math.sqrt(l2 || 1) };
  };
  /** the car road segment (x, y) lies on, within `within` of its centre line, running along heading
   *  `a` (when given) and of road class `c` (when given): the nearest */
  const roadAt = (x: number, y: number, within: number, a?: number, c?: number): Seg | null => {
    let best: Seg | null = null, bd = within;
    for (const s of grid.get(key(Math.floor(x / G), Math.floor(y / G))) ?? []) {
      if (c !== undefined && s.road.c !== c) continue;
      const q = across(s, x, y);
      if (q.d >= bd) continue;
      if (a !== undefined && Math.abs(Math.cos(a) * q.ux + Math.sin(a) * q.uy) < 0.8) continue;
      bd = q.d;
      best = s;
    }
    return best;
  };

  // the graph edges along each road: as wide as it is now (bridges' and footpaths' stay)
  const edge = (e: EdgeJSON) => {
    if (e.c > CAR_MAX) return;
    const m = midpoint(e.p);
    const s = roadAt(m.x, m.y, 1, m.a, e.c);
    if (s && s.k > 1) e.w = Math.round(e.w * s.k * 10) / 10;
  };
  map.graph.car.edges.forEach(edge);
  map.graph.ped.edges.forEach(edge);

  // zebra crossings, speed bumps and stop signs: across the whole of the new width
  const scale = (list: number[] | undefined, stride: number) => {
    if (!list) return;
    for (let i = 0; i < list.length; i += stride) {
      const s = roadAt(list[i], list[i + 1], 3, list[i + 2]);
      if (s && s.k > 1) list[i + 3] = Math.round(list[i + 3] * s.k * 10) / 10;
    }
  };
  scale(map.crossings, 4);
  scale(map.calming, 5);
  scale(map.yields, 5);

  // what stood on the pavement the road now covers: out to its new kerb
  const kerbside = (list: number[] | undefined, stride: number) => {
    if (!list) return;
    for (let i = 0; i < list.length; i += stride) {
      const x = list[i], y = list[i + 1];
      let s: Seg | null = null, q: ReturnType<typeof across> | null = null;
      for (const c of grid.get(key(Math.floor(x / G), Math.floor(y / G))) ?? []) {
        const cq = across(c, x, y);
        // on the old pavement (not in the old carriageway: a bollard across the street stays put)
        // and under the new one
        if (c.k > 1 && cq.d >= c.hw0 - 0.2 && cq.d < c.hw1 + KERB_GAP && (!q || cq.d < q.d)) (s = c), (q = cq);
      }
      // (a point right on the centre line has no side to go to: never on the pavement anyway)
      if (!s || !q || q.d < 1e-3) continue;
      // straight out from the road to its new kerb, unless that's in another road's carriageway
      const f = (s.hw1 + KERB_GAP) / q.d - 1;
      const nx = x + q.ex * f, ny = y + q.ey * f;
      if ((grid.get(key(Math.floor(nx / G), Math.floor(ny / G))) ?? []).some((c) => across(c, nx, ny).d < c.hw1)) continue;
      list[i] = Math.round(nx * 10) / 10;
      list[i + 1] = Math.round(ny * 10) / 10;
    }
  };
  kerbside(map.furniture, 4);
  kerbside(map.lamps, 2);
  kerbside(map.trees, 2);

  map.wide = ROAD_WIDEN;
  return widened;
}

/** the point halfway along a polyline, and its heading there */
function midpoint(p: number[]): { x: number; y: number; a: number } {
  let total = 0;
  for (let i = 0; i < p.length - 2; i += 2) total += hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
  let s = 0;
  for (let i = 0; i < p.length - 2; i += 2) {
    const dx = p[i + 2] - p[i], dy = p[i + 3] - p[i + 1], L = hypot(dx, dy);
    if (s + L >= total / 2 && L > 0) {
      const t = (total / 2 - s) / L;
      return { x: p[i] + dx * t, y: p[i + 1] + dy * t, a: Math.atan2(dy, dx) };
    }
    s += L;
  }
  return { x: p[0], y: p[1], a: 0 };
}

/** the shortest distance between segments ab and cd */
function segSegDist(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  // crossing: 0
  const d1 = cross(cx, cy, dx, dy, ax, ay), d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy), d4 = cross(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(ptSeg(ax, ay, cx, cy, dx, dy), ptSeg(bx, by, cx, cy, dx, dy), ptSeg(cx, cy, ax, ay, bx, by), ptSeg(dx, dy, ax, ay, bx, by));
}

const cross = (ax: number, ay: number, bx: number, by: number, px: number, py: number) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);

function ptSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return hypot(px - ax - dx * t, py - ay - dy * t);
}
