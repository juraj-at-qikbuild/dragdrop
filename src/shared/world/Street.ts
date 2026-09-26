// The street in detail, from the map (see scripts/build-map.mjs): raised traffic islands, lift gates,
// speed bumps and street furniture. Pure data and geometry (no DOM): the server runs the same code.
import { pointInRings, segDist2 } from '../util/math';

/** Per furniture kind (the map's `furniture[].kind`): what it is, how far a car's side must come to
 *  touch it (m), whether a car knocks it flying (or it just stands there), and whether someone can
 *  sit on it. */
export const FURNITURE: { name: string; r: number; knock: boolean; seat?: boolean }[] = [
  { name: 'bench', r: 0.8, knock: true, seat: true },
  { name: 'litter bin', r: 0.3, knock: true },
  { name: 'fire hydrant', r: 0.25, knock: true },
  { name: 'bus stop', r: 0.2, knock: true },
  { name: 'bus shelter', r: 1.4, knock: true, seat: true },
  { name: 'billboard', r: 1.6, knock: false },
  { name: 'advertising column', r: 0.6, knock: false },
  { name: 'bicycle stand', r: 0.9, knock: true },
  { name: 'post box', r: 0.3, knock: true },
  { name: 'café table', r: 0.7, knock: true },
  { name: 'drinking fountain', r: 0.25, knock: true },
  { name: 'recycling containers', r: 1.6, knock: true },
  { name: 'flagpole', r: 0.12, knock: true },
  { name: 'bike-share dock', r: 1.2, knock: true },
  { name: 'picnic table', r: 1.0, knock: true, seat: true },
  { name: 'charging station', r: 0.35, knock: false },
];
export const F_BENCH = 0, F_HYDRANT = 2, F_SHELTER = 4, F_COLUMN = 6, F_TABLE = 9;

/** grid cell (m) for the lookups below */
const CELL = 16;
const key = (gx: number, gy: number) => (gx + 2000) * 8192 + gy + 2000;

function addToGrid(grid: Map<number, number[]>, i: number, x0: number, y0: number, x1: number, y1: number) {
  for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++)
    for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
      const k = key(gx, gy);
      const c = grid.get(k);
      if (c) c.push(i);
      else grid.set(k, [i]);
    }
}

/** Raised, kerbed traffic islands: cars mount them with a jolt and drag across them. */
export class Islands {
  readonly rings: Float32Array[] = [];
  readonly grass: boolean[] = [];
  private bb: Float32Array;
  private grid = new Map<number, number[]>();

  constructor(data: { p: number[]; g?: 1 }[] = []) {
    this.bb = new Float32Array(data.length * 4);
    data.forEach((isl, i) => {
      const r = Float32Array.from(isl.p);
      this.rings.push(r);
      this.grass.push(!!isl.g);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < r.length; k += 2) (x0 = Math.min(x0, r[k])), (x1 = Math.max(x1, r[k])), (y0 = Math.min(y0, r[k + 1])), (y1 = Math.max(y1, r[k + 1]));
      this.bb.set([x0, y0, x1, y1], i * 4);
      addToGrid(this.grid, i, x0, y0, x1, y1);
    });
  }

  /** How deep a circle of radius r at (x, y) is into an island's kerb (m), 0 when clear of them. */
  overlap(x: number, y: number, r: number): number {
    let worst = 0;
    const seen = new Set<number>();
    for (let gx = Math.floor((x - r) / CELL); gx <= Math.floor((x + r) / CELL); gx++)
      for (let gy = Math.floor((y - r) / CELL); gy <= Math.floor((y + r) / CELL); gy++) {
        const c = this.grid.get(key(gx, gy));
        if (!c) continue;
        for (const i of c) {
          if (seen.has(i)) continue;
          seen.add(i);
          const bb = this.bb;
          if (x < bb[i * 4] - r || x > bb[i * 4 + 2] + r || y < bb[i * 4 + 1] - r || y > bb[i * 4 + 3] + r) continue;
          const ring = this.rings[i];
          let d2 = Infinity;
          for (let k = 0; k < ring.length - 2; k += 2) d2 = Math.min(d2, segDist2(x, y, ring[k], ring[k + 1], ring[k + 2], ring[k + 3]));
          const d = Math.sqrt(d2);
          const depth = pointInRings(x, y, [ring]) ? r + d : r - d;
          if (depth > worst) worst = depth;
        }
      }
    return worst;
  }

  /** index of the island (x, y) stands on (grown by `pad` metres), or -1 */
  at(x: number, y: number, pad = 0): number {
    const c = this.grid.get(key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!c) return -1;
    const bb = this.bb;
    for (const i of c) {
      if (x < bb[i * 4] - pad || x > bb[i * 4 + 2] + pad || y < bb[i * 4 + 1] - pad || y > bb[i * 4 + 3] + pad) continue;
      const r = this.rings[i];
      if (pointInRings(x, y, [r])) return i;
      if (pad > 0) for (let k = 0; k < r.length - 2; k += 2) if (segDist2(x, y, r[k], r[k + 1], r[k + 2], r[k + 3]) < pad * pad) return i;
    }
    return -1;
  }
}

/** Speed bumps, raised tables, cushions and rumble strips: a line across the street. */
export class Bumps {
  /** per bump: x, y, unit direction of the street (ux, uy), half-width, kind */
  readonly data: Float32Array;
  readonly n: number;
  private grid = new Map<number, number[]>();

  constructor(flat: number[] = []) {
    this.n = Math.floor(flat.length / 5);
    this.data = new Float32Array(this.n * 6);
    for (let i = 0; i < this.n; i++) {
      const x = flat[i * 5], y = flat[i * 5 + 1], a = flat[i * 5 + 2], hw = flat[i * 5 + 3];
      this.data.set([x, y, Math.cos(a), Math.sin(a), hw, flat[i * 5 + 4]], i * 6);
      addToGrid(this.grid, i, x - hw, y - hw, x + hw, y + hw);
    }
  }

  /** the kind of the bump a body moving from (x0, y0) to (x1, y1) rolled over (-1: none) */
  crossed(x0: number, y0: number, x1: number, y1: number): number {
    if (!this.n) return -1;
    const c = this.grid.get(key(Math.floor(x1 / CELL), Math.floor(y1 / CELL)));
    if (!c) return -1;
    const d = this.data;
    for (const i of c) {
      const bx = d[i * 6], by = d[i * 6 + 1], ux = d[i * 6 + 2], uy = d[i * 6 + 3], hw = d[i * 6 + 4];
      // along the street: the bump line is where this changes sign; across it: within the street
      const s0 = (x0 - bx) * ux + (y0 - by) * uy, s1 = (x1 - bx) * ux + (y1 - by) * uy;
      if ((s0 < 0) === (s1 < 0)) continue;
      if (Math.abs(-(x1 - bx) * uy + (y1 - by) * ux) > hw + 0.5) continue;
      return d[i * 6 + 5];
    }
    return -1;
  }
}

/** how long a snapped boom stays down before someone fixes it (s) */
const GATE_REPAIR = 150;

/** Lift gates: a boom across a car park or service entrance. It stops a car that creeps up to it
 *  and snaps when one rams it. Each simulation (the server, and every client for what it draws)
 *  keeps its own booms. */
export class Gates {
  readonly n: number;
  /** per gate: pivot x, y (at the right-hand kerb), unit direction of the boom across the way, its length */
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly ux: Float32Array;
  readonly uy: Float32Array;
  readonly len: Float32Array;
  /** seconds until a snapped boom is back (0: down, blocking cars) */
  readonly broken: Float32Array;
  /** how the boom went flying: its spin direction, for the drawing */
  readonly spin: Float32Array;
  /** told when a boom snaps (the client's effects) */
  onSnap?: (i: number, x: number, y: number, speed: number) => void;
  private grid = new Map<number, number[]>();

  constructor(flat: number[] = []) {
    const n = (this.n = Math.floor(flat.length / 4));
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.ux = new Float32Array(n);
    this.uy = new Float32Array(n);
    this.len = new Float32Array(n);
    this.broken = new Float32Array(n);
    this.spin = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = flat[i * 4], y = flat[i * 4 + 1], a = flat[i * 4 + 2], L = flat[i * 4 + 3];
      // across the way, from its right-hand side (y down: right of direction a is +90°)
      const ux = -Math.sin(a), uy = Math.cos(a);
      this.px[i] = x + ux * (L / 2);
      this.py[i] = y + uy * (L / 2);
      this.ux[i] = -ux;
      this.uy[i] = -uy;
      this.len[i] = L;
      // padded: a car touching the boom can stand a metre or so off it
      addToGrid(this.grid, i, x - L / 2 - 1.5, y - L / 2 - 1.5, x + L / 2 + 1.5, y + L / 2 + 1.5);
    }
  }

  /** the far end of boom i */
  endX(i: number) {
    return this.px[i] + this.ux[i] * this.len[i];
  }
  endY(i: number) {
    return this.py[i] + this.uy[i] * this.len[i];
  }

  /** Visit the booms still down near (x, y). */
  forDown(x: number, y: number, fn: (i: number) => void) {
    if (!this.n) return;
    const c = this.grid.get(key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (c) for (const i of c) if (this.broken[i] <= 0) fn(i);
  }

  /** A circle of radius r against boom i: how deep it overlaps it, and the push out, or null. */
  contact(i: number, x: number, y: number, r: number): { nx: number; ny: number; depth: number } | null {
    const ax = this.px[i], ay = this.py[i], dx = this.ux[i] * this.len[i], dy = this.uy[i] * this.len[i];
    let t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x - (ax + dx * t), ey = y - (ay + dy * t);
    const d = Math.hypot(ex, ey), rr = r + 0.06;
    if (d >= rr) return null;
    // a circle right on the boom's line is pushed back along the way it came from (the caller's
    // velocity decides the side; the normal of the boom is the fallback)
    const nx = d > 1e-4 ? ex / d : -this.uy[i], ny = d > 1e-4 ? ey / d : this.ux[i];
    return { nx, ny, depth: rr - d };
  }

  snap(i: number, vx: number, vy: number, speed: number) {
    if (this.broken[i] > 0) return;
    this.broken[i] = GATE_REPAIR;
    // the boom swings away in the direction it was hit
    this.spin[i] = vx * -this.uy[i] + vy * this.ux[i] >= 0 ? 1 : -1;
    this.onSnap?.(i, this.px[i] + this.ux[i] * this.len[i] * 0.5, this.py[i] + this.uy[i] * this.len[i] * 0.5, speed);
  }

  /** Once a frame: put repaired booms back, and snap the ones a car simulated somewhere else (a
   *  mirror of another player's car, a player's car on the server) is driving through, so a boom is
   *  never left standing through a car. Cars simulated here meet the booms in VehiclePhysics. */
  sweep(cars: Iterable<{ x: number; y: number; vx: number; vy: number; level: number; kinematic: boolean; spec: { width: number } }>, dt: number) {
    if (!this.n) return;
    for (let i = 0; i < this.n; i++) if (this.broken[i] > 0) this.broken[i] = Math.max(0, this.broken[i] - dt);
    for (const v of cars) {
      if (!v.kinematic || v.level !== 0) continue;
      const sp = Math.hypot(v.vx, v.vy);
      if (sp < 0.8) continue;
      this.forDown(v.x, v.y, (i) => {
        if (this.contact(i, v.x, v.y, v.spec.width / 2 + 0.3)) this.snap(i, v.vx, v.vy, sp);
      });
    }
  }
}
