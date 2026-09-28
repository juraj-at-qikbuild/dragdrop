// Výtlky: potholes along the city's streets (docs/plans/non-violent.md). Placed from the map's own road
// data with a stable hash, so the server and every client agree where they are without a word sent.
// They fill with rain, and a few never dry (it's Bratislava). A car's wheel through one soaks whoever
// it passes (the splash, sim/rules/Splash.ts); the renderer draws them (world/Renderer.ts).
import { RoadClass } from '../types';
import { hash01, polylineLength, walkPolyline } from '../util/math';
import type { World } from './World';

/** metres between the places a pothole may be along a street, and the share of them that are one */
const STEP = 26;
const SHARE = 0.16;
/** of those, the ones that never dry */
const ALWAYS = 0.35;
/** no pothole this close to either end of a street (the junctions) */
const END_GAP = 8;
/** grid cell (m) for `at` */
const CELL = 16;

/** positions hashed at a quarter of a metre, so a float's last bit can't move a pothole */
const q = (v: number) => Math.round(v * 4);
const key = (gx: number, gy: number) => (gx + 4000) * 8192 + gy + 4000;

export interface Pothole {
  x: number;
  y: number;
  /** along the street (unit), and the half-length and half-width across it (m) */
  ux: number;
  uy: number;
  hl: number;
  hw: number;
  /** holds water even when it hasn't rained */
  always: boolean;
}

export class Puddles {
  readonly holes: Pothole[] = [];
  private grid = new Map<number, number[]>();

  constructor(world: World) {
    for (const r of world.data.roads) {
      if (r.b || r.c < RoadClass.Primary || r.c > RoadClass.Living || r.w < 5) continue;
      const len = polylineLength(r.p);
      if (len < END_GAP * 2 + 2) continue;
      let along = hash01(q(r.p[0]), q(r.p[1])) * STEP;
      const start = along;
      walkPolyline(r.p, STEP, start, (x, y, nx, ny) => {
        const at = along;
        along += STEP;
        if (at < END_GAP || at > len - END_GAP) return;
        if (hash01(q(x) * 37, q(y) * 53) >= SHARE) return;
        // in the wheel track by one kerb or the other
        const side = hash01(q(x) * 11, q(y) * 17) < 0.5 ? 1 : -1;
        const off = side * (r.w / 2 - 0.9);
        const px = x + nx * off, py = y + ny * off;
        if (world.inWater(px, py, 0) || world.onBridge(px, py) || world.tunnelDepth(px, py) >= 0 || world.insideBuilding(px, py)) return;
        const surf = world.surfaceAt(px, py, 0);
        if (surf !== 'asphalt' && surf !== 'cobble') return;
        const i = this.holes.length;
        this.holes.push({
          x: px, y: py, ux: ny, uy: -nx,
          hl: 0.5 + hash01(q(x) * 29, q(y) * 31) * 0.45,
          hw: 0.28 + hash01(q(x) * 41, q(y) * 43) * 0.12,
          always: hash01(q(x) * 7, q(y) * 13) < ALWAYS,
        });
        const k = key(Math.floor(px / CELL), Math.floor(py / CELL));
        const c = this.grid.get(k);
        if (c) c.push(i);
        else this.grid.set(k, [i]);
      });
    }
  }

  /** the pothole (index into `holes`) that (x, y) is in, give or take `pad` metres, or -1.
   *  `alwaysOnly`: only one holding water in the dry */
  at(x: number, y: number, pad = 0, alwaysOnly = false): number {
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    for (let ix = gx - 1; ix <= gx + 1; ix++)
      for (let iy = gy - 1; iy <= gy + 1; iy++) {
        const c = this.grid.get(key(ix, iy));
        if (!c) continue;
        for (const i of c) {
          const h = this.holes[i];
          if (alwaysOnly && !h.always) continue;
          const dx = x - h.x, dy = y - h.y;
          const a = dx * h.ux + dy * h.uy, b = -dx * h.uy + dy * h.ux;
          if (Math.abs(a) <= h.hl + pad && Math.abs(b) <= h.hw + pad) return i;
        }
      }
    return -1;
  }
}
