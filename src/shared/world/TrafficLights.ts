// Pure world data and timing (no DOM, canvas or audio): the game server runs the same lights as
// every client. Drawn by the client's Renderer.drawTrafficLights.
import type { World } from './World';
import type { Edge, Link } from './Graph';
import { rng } from '../util/math';

/** Where traffic on one approach waits for a red light. */
export interface StopLine {
  x: number;
  y: number;
  /** travel direction */
  ux: number;
  uy: number;
  /** half-width of the street (the signal stands at its right-hand kerb) */
  hw: number;
  junction: number;
  /** approaches roughly parallel to the junction's main axis share phase 0, crossing ones phase 1 */
  phase: 0 | 1;
}

/** junction timing (s): green, amber, then both directions red to clear the junction. The cycles
 *  (40 s, and 36 s below) divide the 1440 s game day, so the phase doesn't jump at midnight. */
const GREEN = 15, AMBER = 3, CLEAR = 2;
/** a signalled pedestrian crossing on its own: a long green for cars, then the walkers' turn */
const PED_GREEN = 24, PED_WALK = 9;
/** signals within this distance of each other run as one junction */
const CLUSTER = 40;
/** how far before a signalled junction node traffic stops */
const JUNCTION_BACK = 6;

/** The traffic lights mapped in OpenStreetMap, turned into stop lines on the car graph, with a
 *  fixed-time cycle per junction. The phase is a pure function of the junction and the world
 *  clock (Clock.time in seconds of the game day, which online clients sync to the server's), so
 *  every player and the server's traffic see the same colour. Junction offsets are
 *  deterministic, so the city isn't in lock-step. */
export class TrafficLights {
  lines: StopLine[] = [];
  private byEdge = new Map<number, { fwd: StopLine[]; rev: StopLine[] }>();
  private junctions: { offset: number; ped: boolean }[] = [];

  constructor(private world: World) {
    this.build();
  }

  private build() {
    const s = this.world.data.signals;
    if (!s) return;
    const g = this.world.car;
    const n = s.length / 5;

    // junctions: signals close together, and whether they only guard a pedestrian crossing
    const parent = Int32Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        if (Math.hypot(s[i * 5] - s[j * 5], s[i * 5 + 1] - s[j * 5 + 1]) < CLUSTER) parent[find(i)] = find(j);
    const jIndex = new Map<number, number>();
    const axis: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = find(i);
      let j = jIndex.get(r);
      if (j === undefined) {
        jIndex.set(r, (j = this.junctions.length));
        this.junctions.push({ offset: rng(((s[r * 5] * 10) | 0) * 73856093 ^ ((s[r * 5 + 1] * 10) | 0) * 19349663)() * 60, ped: true });
        axis.push(s[r * 5 + 2]);
      }
      if (!s[i * 5 + 4]) this.junctions[j].ped = false;
    }

    // edges touching each node, and a coarse grid of edge segments
    const incident: Edge[][] = Array.from({ length: g.nodes.length / 2 }, () => []);
    const grid = new Map<number, Edge[]>();
    const G = 32;
    for (const e of g.edges) {
      incident[e.a].push(e);
      incident[e.b].push(e);
      for (let i = 0; i < e.p.length; i += 2) {
        const k = Math.floor(e.p[i] / G) * 4096 + Math.floor(e.p[i + 1] / G);
        const c = grid.get(k);
        if (!c) grid.set(k, [e]);
        else if (c[c.length - 1] !== e) c.push(e);
      }
    }
    const add = (e: Edge, fwd: boolean, d: number, j: number) => {
      const { x, y, dx, dy } = along(e.p, d);
      const ux = fwd ? dx : -dx, uy = fwd ? dy : -dy;
      const a = Math.atan2(uy, ux);
      const line: StopLine = { x, y, ux, uy, hw: e.width / 2, junction: j, phase: Math.abs(Math.cos(a - axis[j])) >= Math.SQRT1_2 ? 0 : 1 };
      let entry = this.byEdge.get(e.id);
      if (!entry) this.byEdge.set(e.id, (entry = { fwd: [], rev: [] }));
      const list = fwd ? entry.fwd : entry.rev;
      // one stop line per approach: a second signal a few metres away is the same line
      if (list.some((o) => Math.hypot(o.x - x, o.y - y) < 8)) return;
      list.push(line);
      this.lines.push(line);
    };

    for (let i = 0; i < n; i++) {
      const x = s[i * 5], y = s[i * 5 + 1], ang = s[i * 5 + 2], dir = s[i * 5 + 3];
      const j = jIndex.get(find(i))!;
      // a signal on a junction node guards every approach to it, a few metres out
      const node = g.nearest(x, y, 1.5);
      if (node >= 0 && incident[node].length >= 3) {
        for (const e of incident[node]) {
          const back = Math.min(JUNCTION_BACK, e.len * 0.4);
          if (e.b === node && e.oneway !== -1) add(e, true, e.len - back, j);
          if (e.a === node && e.oneway !== 1) add(e, false, back, j);
        }
        continue;
      }
      // otherwise it stands at its stop line, on the street(s) through it
      const seen = new Set<Edge>();
      for (let gx = Math.floor((x - 3) / G); gx <= Math.floor((x + 3) / G); gx++)
        for (let gy = Math.floor((y - 3) / G); gy <= Math.floor((y + 3) / G); gy++)
          for (const e of grid.get(gx * 4096 + gy) ?? []) {
            if (seen.has(e)) continue;
            seen.add(e);
            const pr = project(e.p, x, y);
            if (!pr || pr.dist > 2.5) continue;
            // travel along the edge is along the signal's way when their directions agree
            const same = Math.cos(ang - Math.atan2(pr.dy, pr.dx)) > 0;
            for (const fwd of [true, false]) {
              if ((fwd && e.oneway === -1) || (!fwd && e.oneway === 1)) continue;
              if (dir !== 0 && dir !== (fwd === same ? 1 : -1)) continue;
              add(e, fwd, pr.s, j);
            }
          }
    }
    // stop lines in travel order along each edge
    for (const [id, entry] of this.byEdge) {
      const e = g.edges[id];
      const pos = (l: StopLine) => (l.x - e.p[0]) * l.ux + (l.y - e.p[1]) * l.uy;
      entry.fwd.sort((a, b) => pos(a) - pos(b));
      entry.rev.sort((a, b) => pos(a) - pos(b));
    }
  }

  /** Stop lines met while driving `link`, in order. */
  forLink(link: Link): StopLine[] {
    const entry = this.byEdge.get(link.edge.id);
    return entry ? (link.fwd ? entry.fwd : entry.rev) : NONE;
  }

  /** 0 green, 1 amber, 2 red, at world clock time `t` (seconds into the game day). */
  state(l: StopLine, t: number): 0 | 1 | 2 {
    const j = this.junctions[l.junction];
    if (j.ped) {
      const u = (t + j.offset) % (PED_GREEN + AMBER + PED_WALK);
      return u < PED_GREEN ? 0 : u < PED_GREEN + AMBER ? 1 : 2;
    }
    const half = GREEN + AMBER + CLEAR;
    let u = (t + j.offset) % (half * 2);
    if (l.phase === 1) u = (u + half) % (half * 2);
    return u < GREEN ? 0 : u < GREEN + AMBER ? 1 : 2;
  }
}

const NONE: StopLine[] = [];

/** Point at arc length `d` along a flat polyline, with the direction there. */
function along(p: ArrayLike<number>, d: number) {
  let acc = 0;
  for (let i = 0; i < p.length - 2; i += 2) {
    const dx = p[i + 2] - p[i], dy = p[i + 3] - p[i + 1];
    const L = Math.hypot(dx, dy);
    if (acc + L >= d || i + 4 >= p.length) {
      const t = L > 1e-6 ? Math.max(0, Math.min(1, (d - acc) / L)) : 0;
      return { x: p[i] + dx * t, y: p[i + 1] + dy * t, dx: L > 1e-6 ? dx / L : 1, dy: L > 1e-6 ? dy / L : 0 };
    }
    acc += L;
  }
  return { x: p[0], y: p[1], dx: 1, dy: 0 };
}

/** Closest point of a flat polyline to (x, y): arc length, distance and direction there. */
function project(p: ArrayLike<number>, x: number, y: number) {
  let best: { s: number; dist: number; dx: number; dy: number } | null = null;
  let acc = 0;
  for (let i = 0; i < p.length - 2; i += 2) {
    const dx = p[i + 2] - p[i], dy = p[i + 3] - p[i + 1];
    const L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
    if (L < 1e-6) continue;
    const t = Math.max(0, Math.min(1, ((x - p[i]) * dx + (y - p[i + 1]) * dy) / L2));
    const dist = Math.hypot(p[i] + dx * t - x, p[i + 1] + dy * t - y);
    if (!best || dist < best.dist) best = { s: acc + t * L, dist, dx: dx / L, dy: dy / L };
    acc += L;
  }
  return best;
}
