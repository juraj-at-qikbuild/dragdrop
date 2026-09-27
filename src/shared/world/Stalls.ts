// Market stalls (docs/plans/non-violent.md: MOJE LOKŠE!): lokše, langoše, klobásy and punč on the
// pavement beside a street at a few of the city's squares. A car ploughing through one sends the food
// flying and the stallholder yelling; it's back up a couple of minutes later. Placed from the map (by
// the landmarks and the car graph), so every simulation agrees where they are. Each keeps its own
// knocked-over state, like the gate booms (Street.ts Gates): the server's (offline, the game's) pays
// the combo, and a client online only draws.
import type { World } from './World';

export type StallKind = 'lokse' | 'langos' | 'klobasa' | 'punc';

/** the squares with a stall, and what it sells */
const PLACES: { at: string; kind: StallKind }[] = [
  { at: 'hviezdoslav', kind: 'lokse' },
  { at: 'kamenne', kind: 'langos' },
  { at: 'eurovea', kind: 'punc' },
  { at: 'snpsquare', kind: 'klobasa' },
  { at: 'hodzovo', kind: 'lokse' },
  { at: 'market', kind: 'langos' },
];

/** a stall's size: a car's collision circle within this of its centre knocks it over (m) */
export const STALL_R = 1.2;
/** seconds until one knocked over is back up */
export const STALL_REBUILD = 120;
/** a car slower than this only nudges it (m/s) */
const MIN_SPEED = 3;

/** what a stall needs to know about a car */
export interface StallCar {
  x: number;
  y: number;
  vx: number;
  vy: number;
  level: number;
  wrecked: boolean;
  circles: number[];
  circleX(i: number): number;
  circleY(i: number): number;
  spec: { width: number; twoWheeler?: boolean; boat?: boolean };
}

export class Stalls {
  readonly x: number[] = [];
  readonly y: number[] = [];
  /** facing the street */
  readonly a: number[] = [];
  readonly kind: StallKind[] = [];
  /** seconds until it's back up (0: standing) */
  readonly broken: Float32Array;
  /** which way it went over (the car's heading), for the drawing */
  readonly fling: Float32Array;
  /** told when one goes over (the client's effects) */
  onKnock?: (i: number, x: number, y: number, speed: number) => void;

  constructor(world: World) {
    for (const pl of PLACES) {
      const l = world.landmarks.get(pl.at);
      const s = l && place(world, l.x, l.y, (x, y) => this.x.every((ox, j) => Math.hypot(ox - x, this.y[j] - y) > 25));
      if (!s) continue;
      this.x.push(s.x);
      this.y.push(s.y);
      this.a.push(s.a);
      this.kind.push(pl.kind);
    }
    this.broken = new Float32Array(this.x.length);
    this.fling = new Float32Array(this.x.length);
  }

  get n() {
    return this.x.length;
  }

  /** Once a step: the stalls knocked over come back up in time, and any car ploughing through one
   *  knocks it over (`hit`: which one and the car that did it, for the simulation's reward). */
  sweep<C extends StallCar>(cars: Iterable<C>, dt: number, hit?: (i: number, v: C) => void) {
    const n = this.n;
    if (!n) return;
    for (let i = 0; i < n; i++) if (this.broken[i] > 0) this.broken[i] = Math.max(0, this.broken[i] - dt);
    for (const v of cars) {
      if (v.level !== 0 || v.wrecked || v.spec.twoWheeler || v.spec.boat) continue;
      const sp = Math.hypot(v.vx, v.vy);
      if (sp < MIN_SPEED) continue;
      for (let i = 0; i < n; i++) {
        if (this.broken[i] > 0 || Math.abs(v.x - this.x[i]) > 8 || Math.abs(v.y - this.y[i]) > 8) continue;
        let touch = false;
        for (let c = 0; c < v.circles.length && !touch; c++)
          touch = Math.hypot(v.circleX(c) - this.x[i], v.circleY(c) - this.y[i]) < v.spec.width / 2 + STALL_R;
        if (!touch) continue;
        this.broken[i] = STALL_REBUILD;
        this.fling[i] = Math.atan2(v.vy, v.vx);
        this.onKnock?.(i, this.x[i], this.y[i], sp);
        hit?.(i, v);
      }
    }
  }
}

/** On the pavement beside a proper street near (lx, ly), on the landmark's side of it, facing the
 *  street: clear of buildings, walls, the water, bridges and tunnels, and `free` (away from the other
 *  stalls). Null if there's nowhere. */
function place(world: World, lx: number, ly: number, free: (x: number, y: number) => boolean): { x: number; y: number; a: number } | null {
  const g = world.car;
  const nodes = g.nodesAround(lx, ly, 0, 160).sort((i, j) => Math.hypot(g.nx(i) - lx, g.ny(i) - ly) - Math.hypot(g.nx(j) - lx, g.ny(j) - ly));
  for (const n of nodes.slice(0, 40))
    for (const link of g.out[n]) {
      const e = link.edge;
      if (e.cls > 6 || e.width < 5) continue;
      const dx = g.nx(link.to) - g.nx(n), dy = g.ny(link.to) - g.ny(n), d = Math.hypot(dx, dy);
      if (d < 24) continue;
      const ux = dx / d, uy = dy / d;
      // (clear of the junction)
      const mx = g.nx(n) + ux * 11, my = g.ny(n) + uy * 11;
      let nx = -uy, ny = ux;
      if ((lx - mx) * nx + (ly - my) * ny < 0) (nx = -nx), (ny = -ny);
      for (const off of [e.width / 2 + 2.3, e.width / 2 + 3.2]) {
        const x = mx + nx * off, y = my + ny * off;
        if (!free(x, y) || world.insideBuilding(x, y) || world.inWater(x, y, 0) || world.onBridge(x, y) || world.tunnelDepth(x, y) >= 0 || world.collideCircle(x, y, 1.4, 0)) continue;
        return { x, y, a: Math.atan2(-ny, -nx) };
      }
    }
  return null;
}
