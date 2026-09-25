import type { BuildingJSON, MapJSON, RoadJSON } from '../types';
import { Graph } from './Graph';
import { bboxOf, pointInRings, ringArea, rng, segDist2, segIntersect, type BBox } from '../util/math';

export interface Building {
  /** outer rings wound with positive signed area, courtyard holes negative, so for every edge
   *  (ax,ay)->(bx,by) the normal (by-ay, ax-bx) points away from the building's material */
  rings: Float32Array[];
  /** bbox of rings[0] */
  bbox: BBox;
  /** bbox of every ring (multipolygon buildings can have several outer rings) */
  bboxAll: BBox;
  cx: number;
  cy: number;
  /** storeys drawn (see `drawnLevels`: untagged buildings get a deterministic variation) */
  levels: number;
  kind: number;
  seed: number;
  name: number;
  color?: string;
  wallColor?: string;
  area: number;
  solid: boolean;
}

export interface Landmark {
  id: string;
  name: string;
  x: number;
  y: number;
}

const CELL = 16;
/** building lookup grid cell size */
const BCELL = 32;
/** floats per `roadSegs` entry: ax, ay, bx, by, halfWidth, nameIdx, bridge, openA, openB */
const SEG = 9;
/** floats per deck-end record: x, y, inward ux, uy, halfWidth */
const END = 5;
/** an entity only goes up onto a deck it fits on with at least this much room either side */
const DECK_FIT = 0.5;

/** where a circle is relative to the nearest bridge deck it fits on (reused, see `deckFit`) */
interface DeckFit {
  /** on a deck (within its railings) or past one of its open ends */
  on: boolean;
  /** distance outside the nearest deck's railings (0 when `on`) */
  depth: number;
  /** unit push back toward that deck */
  nx: number;
  ny: number;
  /** that deck segment's direction */
  ux: number;
  uy: number;
}

/** Static city data plus spatial queries (collision, water, street names). */
export class World {
  data: MapJSON;
  bounds: BBox;
  names: string[];
  buildings: Building[];
  car: Graph;
  ped: Graph;
  tram: Graph;
  landmarks = new Map<string, Landmark>();

  /** wall segments [ax, ay, bx, by] */
  private walls: Float32Array;
  private wallGrid = new Map<number, number[]>();
  /** named and bridge road segments, SEG floats each (see SEG); openA/openB flag a bridge
   *  segment end that is a real deck end, where entities may drive or walk off the deck */
  private roadSegs: Float32Array;
  private roadGrid = new Map<number, number[]>();
  /** all road segments for surface queries [ax, ay, bx, by, halfWidth, class] */
  private surfSegs: Float32Array;
  private surfGrid = new Map<number, number[]>();
  private water: { rings: Float32Array[]; bbox: BBox }[] = [];
  /** deck ends (where a ramp or street meets a bridge deck), END floats each (see END) */
  private bridgeEnds: Float32Array = new Float32Array(0);
  private fit: DeckFit = { on: false, depth: 0, nx: 0, ny: 0, ux: 1, uy: 0 };
  /** building indices by BCELL cell (over each building's `bboxAll`) */
  private buildingGrid = new Map<number, number[]>();
  /** per-building query stamp, so `forBuildingsNear` visits each building once */
  private buildingStamp: Uint32Array;
  private stamp = 0;

  constructor(data: MapJSON) {
    this.data = data;
    const [x0, y0, x1, y1] = data.bounds;
    this.bounds = { x0, y0, x1, y1 };
    this.names = data.names;
    for (const l of data.landmarks) this.landmarks.set(l.id, { id: l.id, name: l.n, x: l.x, y: l.y });

    // ordinary buildings with no height in OSM (older baked maps don't flag them: those came out
    // as exactly 3 storeys); churches, landmarks and commercial blocks keep their height
    const untagged = (b: BuildingJSON) => b.k === 0 && (data.flagsUntagged ? b.u === 1 : b.l === 3);
    this.buildings = data.buildings.map((b) => {
      const rings = orientRings(b.r.map((r) => Float32Array.from(r)));
      const bbox = bboxOf(rings[0]);
      const bboxAll = { ...bbox };
      for (let i = 1; i < rings.length; i++) bboxOf(rings[i], 0, bboxAll);
      const area = ringArea(rings[0]);
      const cx = (bbox.x0 + bbox.x1) / 2, cy = (bbox.y0 + bbox.y1) / 2;
      return {
        rings,
        bbox,
        bboxAll,
        cx,
        cy,
        levels: untagged(b) ? drawnLevels(area, cx, cy, b.s) : b.l,
        kind: b.k,
        seed: b.s,
        name: b.n ?? -1,
        color: b.c,
        wallColor: b.w,
        area,
        solid: b.k !== 4 && area > 6,
      };
    });

    this.buildings.forEach((b, i) => {
      const g0x = Math.floor(b.bboxAll.x0 / BCELL), g1x = Math.floor(b.bboxAll.x1 / BCELL);
      const g0y = Math.floor(b.bboxAll.y0 / BCELL), g1y = Math.floor(b.bboxAll.y1 / BCELL);
      for (let gx = g0x; gx <= g1x; gx++)
        for (let gy = g0y; gy <= g1y; gy++) {
          const k = this.key(gx, gy);
          let c = this.buildingGrid.get(k);
          if (!c) this.buildingGrid.set(k, (c = []));
          c.push(i);
        }
    });
    this.buildingStamp = new Uint32Array(this.buildings.length);

    // collision walls
    const walls: number[] = [];
    for (const b of this.buildings) {
      if (!b.solid) continue;
      for (const r of b.rings)
        for (let i = 0; i < r.length - 2; i += 2) walls.push(r[i], r[i + 1], r[i + 2], r[i + 3]);
    }
    this.walls = Float32Array.from(walls);
    for (let i = 0; i < this.walls.length; i += 4) this.addToGrid(this.wallGrid, i, this.walls, 0);

    // road segments for street names and bridges
    const segs: number[] = [];
    /** index (in `segs`) of each bridge road's first and last segment */
    const bridgeSegs: [RoadJSON, number, number][] = [];
    for (const r of data.roads) {
      if (r.n === undefined && !r.b) continue;
      const first = segs.length;
      for (let i = 0; i < r.p.length - 2; i += 2)
        segs.push(r.p[i], r.p[i + 1], r.p[i + 2], r.p[i + 3], r.w / 2, r.n ?? -1, r.b ? 1 : 0, 0, 0);
      if (r.b && segs.length > first) bridgeSegs.push([r, first, segs.length - SEG]);
    }
    this.roadSegs = Float32Array.from(segs);
    for (let i = 0; i < this.roadSegs.length; i += SEG) this.addToGrid(this.roadGrid, i, this.roadSegs, 12);

    // deck ends: first/last vertex of every bridge polyline where the deck meets a ramp or street.
    // OSM splits long bridges into several ways, so an end only counts if the road continues off
    // the bridge there: an ordinary road shares that vertex, or a probe a few metres further out
    // is no longer on any deck. Rails stay open at deck ends so entities can leave the bridge.
    const groundVerts = new Set<string>();
    for (const r of data.roads) if (!r.b) for (let i = 0; i < r.p.length; i += 2) groundVerts.add(`${r.p[i]}|${r.p[i + 1]}`);
    const ends: number[] = [];
    const deckEnd = (p: number[], fromEnd: boolean, hw: number) => {
      const n = p.length;
      const x = fromEnd ? p[n - 2] : p[0], y = fromEnd ? p[n - 1] : p[1];
      // inward direction: toward the point ~3m along the deck (short first segments give a poor heading)
      let ix = x, iy = y;
      for (let k = 1; k < n / 2; k++) {
        const j = fromEnd ? n - 2 - k * 2 : k * 2;
        (ix = p[j]), (iy = p[j + 1]);
        if (Math.hypot(ix - x, iy - y) >= 3) break;
      }
      const d = Math.hypot(ix - x, iy - y) || 1;
      const ux = (ix - x) / d, uy = (iy - y) / d;
      const open = groundVerts.has(`${x}|${y}`) || !this.onBridge(x - ux * 6, y - uy * 6);
      if (open) ends.push(x, y, ux, uy, hw);
      return open ? 1 : 0;
    };
    for (const [r, first, last] of bridgeSegs) {
      this.roadSegs[first + 7] = deckEnd(r.p, false, r.w / 2);
      this.roadSegs[last + 8] = deckEnd(r.p, true, r.w / 2);
    }
    this.bridgeEnds = Float32Array.from(ends);

    // surface lookup: every road (not just named/bridged ones), tagged with its class
    const surf: number[] = [];
    for (const r of data.roads)
      for (let i = 0; i < r.p.length - 2; i += 2) surf.push(r.p[i], r.p[i + 1], r.p[i + 2], r.p[i + 3], r.w / 2, r.c);
    this.surfSegs = Float32Array.from(surf);
    for (let i = 0; i < this.surfSegs.length; i += 6) this.addToGrid(this.surfGrid, i, this.surfSegs, 6);

    for (const w of data.areas.water) {
      const rings = w.map((r) => Float32Array.from(r));
      if (ringArea(rings[0]) < 4000) continue; // fountains are decoration only
      this.water.push({ rings, bbox: bboxOf(rings[0]) });
    }

    this.car = new Graph(data.graph.car, true);
    this.ped = new Graph(data.graph.ped, false);
    this.tram = new Graph(data.graph.tram, false);
  }

  private addToGrid(grid: Map<number, number[]>, idx: number, arr: Float32Array, pad: number) {
    const ax = arr[idx], ay = arr[idx + 1], bx = arr[idx + 2], by = arr[idx + 3];
    const gx0 = Math.floor((Math.min(ax, bx) - pad) / CELL), gx1 = Math.floor((Math.max(ax, bx) + pad) / CELL);
    const gy0 = Math.floor((Math.min(ay, by) - pad) / CELL), gy1 = Math.floor((Math.max(ay, by) + pad) / CELL);
    for (let gx = gx0; gx <= gx1; gx++)
      for (let gy = gy0; gy <= gy1; gy++) {
        const k = this.key(gx, gy);
        let c = grid.get(k);
        if (!c) grid.set(k, (c = []));
        c.push(idx);
      }
  }
  private key(gx: number, gy: number) {
    return (gx + 2000) * 8192 + gy + 2000;
  }

  /** Visit wall segments near a circle. */
  forWalls(x: number, y: number, r: number, fn: (ax: number, ay: number, bx: number, by: number) => void) {
    const gx0 = Math.floor((x - r) / CELL), gx1 = Math.floor((x + r) / CELL);
    const gy0 = Math.floor((y - r) / CELL), gy1 = Math.floor((y + r) / CELL);
    const seen = gx0 === gx1 && gy0 === gy1 ? null : new Set<number>();
    const w = this.walls;
    for (let gx = gx0; gx <= gx1; gx++)
      for (let gy = gy0; gy <= gy1; gy++) {
        const c = this.wallGrid.get(this.key(gx, gy));
        if (!c) continue;
        for (const i of c) {
          if (seen) {
            if (seen.has(i)) continue;
            seen.add(i);
          }
          fn(w[i], w[i + 1], w[i + 2], w[i + 3]);
        }
      }
  }

  /** Push a circle out of walls, and (with level 1) off a bridge deck's railings. Returns the collision normal and depth (or null). */
  collideCircle(x: number, y: number, r: number, level?: 0 | 1): { nx: number; ny: number; depth: number } | null {
    let px = x, py = y, hit = false;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      this.forWalls(px, py, r, (ax, ay, bx, by) => {
        const dx = bx - ax, dy = by - ay;
        const l2 = dx * dx + dy * dy;
        let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + dx * t, cy = ay + dy * t;
        const ex = px - cx, ey = py - cy;
        const d2 = ex * ex + ey * ey;
        if (d2 < r * r) {
          const d = Math.sqrt(d2) || 1e-4;
          const push = r - d;
          px += (ex / d) * push;
          py += (ey / d) * push;
          hit = moved = true;
        }
      });
      if (!moved) break;
    }
    if (level === 1) {
      const rp = this.railPush(px, py, r);
      if (rp) {
        px += rp.nx * rp.depth;
        py += rp.ny * rp.depth;
        hit = true;
      }
    }
    // world edge
    const b = this.bounds;
    if (px < b.x0 + r) (px = b.x0 + r), (hit = true);
    if (px > b.x1 - r) (px = b.x1 - r), (hit = true);
    if (py < b.y0 + r) (py = b.y0 + r), (hit = true);
    if (py > b.y1 - r) (py = b.y1 - r), (hit = true);
    if (!hit) return null;
    const nx = px - x, ny = py - y;
    const depth = Math.hypot(nx, ny);
    if (depth < 1e-6) return null;
    return { nx: nx / depth, ny: ny / depth, depth };
  }

  /** First wall hit along a ray; returns fraction t in [0, 1] or 1. */
  raycast(ax: number, ay: number, bx: number, by: number): number {
    let best = 1;
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len / CELL));
    const seen = new Set<number>();
    for (let s = 0; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps;
      const c = this.wallGrid.get(this.key(Math.floor(x / CELL), Math.floor(y / CELL)));
      if (c) {
        const w = this.walls;
        for (const i of c) {
          if (seen.has(i)) continue;
          seen.add(i);
          const t = segIntersect(ax, ay, bx, by, w[i], w[i + 1], w[i + 2], w[i + 3]);
          if (t >= 0 && t < best) best = t;
        }
      }
      if (best < 1 && (s + 1) / steps > best + CELL / len) break;
    }
    return best;
  }

  /** Where a circle of radius `r` is relative to the nearest bridge deck it fits on (decks too
   *  narrow for it, e.g. footbridges for a bus, are ignored). It is `on` a deck while within any
   *  deck segment's railings or past one of its open ends. Null when no such deck is nearby.
   *  Returns a shared scratch object: read it before the next call. */
  private deckFit(x: number, y: number, r: number): DeckFit | null {
    const c = this.roadGrid.get(this.key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!c) return null;
    const s = this.roadSegs, f = this.fit;
    let any = false;
    f.depth = Infinity;
    for (const i of c) {
      if (!s[i + 6]) continue;
      const limit = s[i + 4] - r;
      if (limit <= 0) continue;
      const ax = s[i], ay = s[i + 1], bx = s[i + 2], by = s[i + 3];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const len = Math.sqrt(l2) || 1;
      const tr = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      any = true;
      // past an open deck end (and still close to it, not beside some other deck's end)
      const openHere = tr < 0 ? s[i + 7] && (x - ax) ** 2 + (y - ay) ** 2 < (s[i + 4] + 1.5) ** 2 : tr > 1 && s[i + 8] && (x - bx) ** 2 + (y - by) ** 2 < (s[i + 4] + 1.5) ** 2;
      if (openHere) {
        f.on = true;
        f.depth = 0;
        (f.ux = dx / len), (f.uy = dy / len);
        return f;
      }
      const t = tr < 0 ? 0 : tr > 1 ? 1 : tr;
      const ex = x - (ax + dx * t), ey = y - (ay + dy * t);
      const d = Math.hypot(ex, ey) || 1e-4;
      if (d <= limit) {
        f.on = true;
        f.depth = 0;
        (f.ux = dx / len), (f.uy = dy / len);
        return f;
      }
      if (d - limit < f.depth) (f.depth = d - limit), (f.nx = -ex / d), (f.ny = -ey / d), (f.ux = dx / len), (f.uy = dy / len);
    }
    if (!any) return null;
    f.on = false;
    return f;
  }

  /** Push a circle on a bridge deck back inside the railings. It only pushes when the circle is
   *  outside every deck it fits on (twin carriageways and multi-segment decks don't fight each
   *  other), never at an open deck end, and never by more than a small correction: anything
   *  further out isn't really on that deck, and `updateLevel` drops it back to ground level. */
  private railPush(x: number, y: number, r: number): { nx: number; ny: number; depth: number } | null {
    const f = this.deckFit(x, y, r);
    if (!f || f.on || f.depth > r + 1) return null;
    return { nx: f.nx, ny: f.ny, depth: f.depth };
  }

  /** Update an entity's bridge level: 0 on the ground/underneath, 1 on the deck. (vx, vy) is its
   *  velocity and `r` its radius. From the ground it only goes up at an open deck end, moving
   *  along the deck onto it, and only onto a deck it fits on: traffic passing underneath near a
   *  deck end (e.g. along Staromestská under Albertova lávka) stays below. `rescue` also lifts an
   *  entity that ended up underneath a deck over water while travelling along it, so a missed
   *  ramp can't drown it. It drops back to 0 once it leaves the bridge footprint or strays well
   *  off every deck it fits on. */
  updateLevel(e: { x: number; y: number; level: 0 | 1 }, vx: number, vy: number, r: number, rescue = true) {
    if (!this.onBridge(e.x, e.y)) {
      e.level = 0;
      return;
    }
    if (e.level === 1) {
      const f = this.deckFit(e.x, e.y, r);
      if (!f || (!f.on && f.depth > r + 1)) e.level = 0;
      return;
    }
    const sp = Math.hypot(vx, vy);
    if (sp < 0.3) return;
    const ends = this.bridgeEnds;
    for (let i = 0; i < ends.length; i += END) {
      const hw = ends[i + 4];
      if (hw - r < DECK_FIT) continue;
      const dx = e.x - ends[i], dy = e.y - ends[i + 1];
      const ux = ends[i + 2], uy = ends[i + 3];
      const along = dx * ux + dy * uy;
      if (along < -(hw + 2) || along > 12 || Math.abs(dx * uy - dy * ux) > hw) continue;
      if (vx * ux + vy * uy < 0.5 * sp) continue;
      e.level = 1;
      return;
    }
    if (rescue && this.inWater(e.x, e.y, 0) && this.onDeckAlong(e.x, e.y, vx / sp, vy / sp, r)) e.level = 1;
  }

  /** True when the circle is on a deck it fits on and heading along that deck (within ~37°). */
  private onDeckAlong(x: number, y: number, hx: number, hy: number, r: number) {
    const f = this.deckFit(x, y, r + DECK_FIT);
    return !!f && f.on && Math.abs(hx * f.ux + hy * f.uy) > 0.8;
  }

  /** Bridge level for something that has just appeared at (x, y) facing `angle` (spawned traffic,
   *  parked cars, trams, pedestrians): 1 if it is on a deck it fits on, heading along it (or, with
   *  no heading, only when over water so pedestrians under a deck stay underneath). */
  spawnLevel(x: number, y: number, r: number, angle?: number): 0 | 1 {
    if (!this.onBridge(x, y)) return 0;
    if (angle === undefined) {
      const f = this.deckFit(x, y, r + DECK_FIT);
      return f && f.on && this.inWater(x, y, 0) ? 1 : 0;
    }
    return this.onDeckAlong(x, y, Math.cos(angle), Math.sin(angle), r) ? 1 : 0;
  }

  insideBuilding(x: number, y: number) {
    const c = this.buildingGrid.get(this.key(Math.floor(x / BCELL), Math.floor(y / BCELL)));
    if (!c) return false;
    for (const i of c) {
      const b = this.buildings[i], bb = b.bboxAll;
      if (!b.solid || x < bb.x0 || x > bb.x1 || y < bb.y0 || y > bb.y1) continue;
      if (pointInRings(x, y, b.rings)) return true;
    }
    return false;
  }

  /** Visit every building whose `bboxAll` overlaps the box, once each. */
  forBuildingsNear(x0: number, y0: number, x1: number, y1: number, fn: (b: Building) => void) {
    const stamp = ++this.stamp;
    const seen = this.buildingStamp;
    for (let gx = Math.floor(x0 / BCELL); gx <= Math.floor(x1 / BCELL); gx++)
      for (let gy = Math.floor(y0 / BCELL); gy <= Math.floor(y1 / BCELL); gy++) {
        const c = this.buildingGrid.get(this.key(gx, gy));
        if (!c) continue;
        for (const i of c) {
          if (seen[i] === stamp) continue;
          seen[i] = stamp;
          const bb = this.buildings[i].bboxAll;
          if (bb.x1 < x0 || bb.x0 > x1 || bb.y1 < y0 || bb.y0 > y1) continue;
          fn(this.buildings[i]);
        }
      }
  }

  /** `level`: pass an entity's bridge level so someone underneath a deck (0) still drowns in the
   *  water below it, while the default (omitted) keeps the bridge footprint dry, as before. */
  inWater(x: number, y: number, level?: 0 | 1) {
    for (const w of this.water) {
      if (x < w.bbox.x0 || x > w.bbox.x1 || y < w.bbox.y0 || y > w.bbox.y1) continue;
      if (!pointInRings(x, y, w.rings)) continue;
      if (level === 0 || !this.onBridge(x, y)) return true;
    }
    return false;
  }

  onBridge(x: number, y: number) {
    const c = this.roadGrid.get(this.key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!c) return false;
    const s = this.roadSegs;
    for (const i of c) {
      if (!s[i + 6]) continue;
      const hw = s[i + 4] + 1.5;
      if (segDist2(x, y, s[i], s[i + 1], s[i + 2], s[i + 3]) < hw * hw) return true;
    }
    return false;
  }

  /** Name of the nearest named street within ~15 m. */
  streetName(x: number, y: number): string | null {
    const c = this.roadGrid.get(this.key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!c) return null;
    const s = this.roadSegs;
    let best = -1, bestD = Infinity;
    for (const i of c) {
      if (s[i + 5] < 0) continue;
      const d = Math.sqrt(segDist2(x, y, s[i], s[i + 1], s[i + 2], s[i + 3])) - s[i + 4];
      if (d < bestD) (bestD = d), (best = s[i + 5]);
    }
    return best >= 0 && bestD < 15 ? this.names[best] : null;
  }

  /** Surface under a point, for tyre grip/drag: bridge deck, cobble (class >= 8), asphalt, or off-road. */
  surfaceAt(x: number, y: number): 'asphalt' | 'cobble' | 'offroad' | 'bridge' {
    if (this.onBridge(x, y)) return 'bridge';
    const c = this.surfGrid.get(this.key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!c) return 'offroad';
    const s = this.surfSegs;
    let bestD = Infinity, bestCls = -1;
    for (const i of c) {
      const d = Math.sqrt(segDist2(x, y, s[i], s[i + 1], s[i + 2], s[i + 3])) - s[i + 4];
      if (d < bestD) (bestD = d), (bestCls = s[i + 5]);
    }
    if (bestD > 2) return 'offroad';
    return bestCls >= 8 ? 'cobble' : 'asphalt';
  }

  district(x: number, y: number): string {
    // rough boundaries of the real city districts inside the playable area
    if (y > 250 + x * 0.12 && !this.inWater(x, y)) return 'Petržalka';
    if (x < -650 && y < 150) return 'Hradný vrch';
    if (x > 950 && y < 150) return 'Ružinov';
    if (y < -700) return 'Staré Mesto – sever';
    return 'Staré Mesto';
  }

  pois(kind: 'police' | 'hospital' | 'fuel' | 'shop') {
    return this.data.pois.filter((p) => p.k === kind);
  }

  /** Walkable spot near a point (outside buildings and water). */
  walkableNear(x: number, y: number) {
    const n = this.ped.nearest(x, y, 300);
    if (n >= 0) return { x: this.ped.nx(n), y: this.ped.ny(n) };
    return { x, y };
  }

  landmark(id: string, fx = 0, fy = 0): Landmark {
    return this.landmarks.get(id) ?? { id, name: id, x: fx, y: fy };
  }
}

/** Signed area (positive for the winding whose (by-ay, ax-bx) edge normal points outward). */
function signedArea(r: ArrayLike<number>) {
  let a = 0;
  for (let i = 0; i < r.length - 2; i += 2) a += r[i] * r[i + 3] - r[i + 2] * r[i + 1];
  return a / 2;
}

/** OSM gives rings in either winding. Wind outer rings positive and courtyard holes negative, so
 *  wall normals and facade back-face tests work the same for every building. A ring is a hole
 *  when most of its vertices lie inside an odd number of the building's other rings. */
function orientRings(rings: Float32Array[]): Float32Array[] {
  return rings.map((r, i) => {
    let hole = false;
    if (rings.length > 1) {
      const others = rings.filter((_, j) => j !== i);
      let inside = 0;
      const n = r.length / 2 - 1;
      for (let k = 0; k < n; k++) if (pointInRings(r[k * 2], r[k * 2 + 1], others)) inside++;
      hole = inside * 2 > n;
    }
    if (signedArea(r) > 0 === !hole) return r;
    const out = new Float32Array(r.length);
    for (let k = 0; k < r.length; k += 2) (out[k] = r[r.length - 2 - k]), (out[k + 1] = r[r.length - 1 - k]);
    return out;
  });
}

/** Storeys to draw for a building OSM gives no height for (the map builder defaults them to 3,
 *  which makes whole streets one flat slab). Small sheds and kiosks get 1-2; otherwise a ~60 m
 *  cell picks 3 or 4 so a street stays coherent, and each building varies by one storey either
 *  way now and then, clamped to 2-5. Deterministic, and only visual (collision is 2D). */
function drawnLevels(area: number, cx: number, cy: number, seed: number): number {
  if (area < 30) return 1;
  if (area < 55) return 2;
  const cell = rng((Math.floor(cx / 60) * 73856093) ^ (Math.floor(cy / 60) * 19349663))();
  const own = rng((seed * 7717) ^ ((cx * 131) | 0) ^ ((cy * 977) | 0))();
  const base = cell < 0.55 ? 3 : 4;
  return Math.max(2, Math.min(5, base + (own < 0.15 ? -1 : own > 0.85 ? 1 : 0)));
}
