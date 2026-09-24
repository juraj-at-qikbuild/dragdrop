import type { MapJSON } from '../types';
import { Graph } from './Graph';
import { bboxOf, pointInRings, ringArea, segDist2, segIntersect, type BBox } from '../util/math';

export interface Building {
  rings: Float32Array[];
  bbox: BBox;
  cx: number;
  cy: number;
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
  /** named road segments [ax, ay, bx, by, halfWidth, nameIdx, bridge] */
  private roadSegs: Float32Array;
  private roadGrid = new Map<number, number[]>();
  private water: { rings: Float32Array[]; bbox: BBox }[] = [];

  constructor(data: MapJSON) {
    this.data = data;
    const [x0, y0, x1, y1] = data.bounds;
    this.bounds = { x0, y0, x1, y1 };
    this.names = data.names;
    for (const l of data.landmarks) this.landmarks.set(l.id, { id: l.id, name: l.n, x: l.x, y: l.y });

    this.buildings = data.buildings.map((b) => {
      const rings = b.r.map((r) => Float32Array.from(r));
      const bbox = bboxOf(rings[0]);
      const area = ringArea(rings[0]);
      return {
        rings,
        bbox,
        cx: (bbox.x0 + bbox.x1) / 2,
        cy: (bbox.y0 + bbox.y1) / 2,
        levels: b.l,
        kind: b.k,
        seed: b.s,
        name: b.n ?? -1,
        color: b.c,
        wallColor: b.w,
        area,
        solid: b.k !== 4 && area > 6,
      };
    });

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
    for (const r of data.roads) {
      if (r.n === undefined && !r.b) continue;
      for (let i = 0; i < r.p.length - 2; i += 2)
        segs.push(r.p[i], r.p[i + 1], r.p[i + 2], r.p[i + 3], r.w / 2, r.n ?? -1, r.b ? 1 : 0);
    }
    this.roadSegs = Float32Array.from(segs);
    for (let i = 0; i < this.roadSegs.length; i += 7) this.addToGrid(this.roadGrid, i, this.roadSegs, 12);

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

  /** Push a circle out of walls. Returns the collision normal and depth (or null). */
  collideCircle(x: number, y: number, r: number): { nx: number; ny: number; depth: number } | null {
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

  insideBuilding(x: number, y: number) {
    // cheap test: only buildings whose bbox contains the point
    const c = this.wallGrid.get(this.key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!c) return false;
    for (const b of this.buildings) {
      if (!b.solid || x < b.bbox.x0 || x > b.bbox.x1 || y < b.bbox.y0 || y > b.bbox.y1) continue;
      if (pointInRings(x, y, b.rings)) return true;
    }
    return false;
  }

  inWater(x: number, y: number) {
    for (const w of this.water) {
      if (x < w.bbox.x0 || x > w.bbox.x1 || y < w.bbox.y0 || y > w.bbox.y1) continue;
      if (pointInRings(x, y, w.rings) && !this.onBridge(x, y)) return true;
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
