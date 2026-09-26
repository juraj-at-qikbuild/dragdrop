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

/** A stop or give-way sign where traffic on one approach yields, or a speed bump / raised table
 *  across the street (both directions), placed on the car graph. */
export interface Mark {
  x: number;
  y: number;
  /** travel direction */
  ux: number;
  uy: number;
  /** half-width of the street */
  hw: number;
  /** 0 stop sign, 1 give way, 2 speed bump, 3 raised table, 4 speed cushions, 5 rumble strip, 6 bus stop */
  kind: number;
}
export const MARK_STOP = 0, MARK_GIVE_WAY = 1, MARK_BUMP = 2, MARK_BUS_STOP = 6;

/** The map's stop and give-way signs and speed bumps, on the approaches of the car graph they
 *  apply to, in travel order along each edge (traffic reads them like the traffic lights). */
export class StreetMarks {
  /** every sign, for drawing (bumps are drawn from World.bumps) */
  signs: Mark[] = [];
  private byEdge = new Map<number, { fwd: Mark[]; rev: Mark[] }>();

  constructor(world: World) {
    const g = world.car;
    const grid = new Map<number, Edge[]>();
    const G = 32;
    for (const e of g.edges)
      for (let i = 0; i < e.p.length; i += 2) {
        const k = Math.floor(e.p[i] / G) * 4096 + Math.floor(e.p[i + 1] / G);
        const c = grid.get(k);
        if (!c) grid.set(k, [e]);
        else if (c[c.length - 1] !== e) c.push(e);
      }
    const near = (x: number, y: number, r: number, fn: (e: Edge) => void) => {
      const seen = new Set<Edge>();
      for (let gx = Math.floor((x - r) / G); gx <= Math.floor((x + r) / G); gx++)
        for (let gy = Math.floor((y - r) / G); gy <= Math.floor((y + r) / G); gy++)
          for (const e of grid.get(gx * 4096 + gy) ?? []) if (!seen.has(e)) seen.add(e), fn(e);
    };
    const add = (e: Edge, fwd: boolean, sAlong: number, kind: number) => {
      const { x, y, dx, dy } = along(e.p, sAlong);
      const m: Mark = { x, y, ux: fwd ? dx : -dx, uy: fwd ? dy : -dy, hw: e.width / 2, kind };
      let entry = this.byEdge.get(e.id);
      if (!entry) this.byEdge.set(e.id, (entry = { fwd: [], rev: [] }));
      const list = fwd ? entry.fwd : entry.rev;
      if (list.some((o) => o.kind === kind && Math.hypot(o.x - x, o.y - y) < 6)) return null;
      list.push(m);
      return m;
    };
    // signs: the approach whose travel direction they face, not the street carrying on past them
    const y = world.data.yields ?? [];
    for (let i = 0; i < y.length; i += 5) {
      const x0 = y[i], y0 = y[i + 1], a = y[i + 2], kind = y[i + 4];
      near(x0, y0, 3, (e) => {
        const pr = project(e.p, x0, y0);
        if (!pr || pr.dist > 2.5) return;
        const c = Math.cos(a - Math.atan2(pr.dy, pr.dx));
        const fwd = c > 0.3 ? true : c < -0.3 ? false : null;
        if (fwd === null || (fwd && e.oneway === -1) || (!fwd && e.oneway === 1)) return;
        // a sign at the very start of this edge (in travel order) belongs to the one before it
        if ((fwd ? pr.s : e.len - pr.s) < 0.5) return;
        const m = add(e, fwd, Math.max(0, Math.min(e.len, pr.s)), kind);
        if (m) this.signs.push(m);
      });
    }
    // bumps: both directions of the street they cross
    const b = world.data.calming ?? [];
    for (let i = 0; i < b.length; i += 5) {
      const x0 = b[i], y0 = b[i + 1], kind = 2 + b[i + 4];
      near(x0, y0, 3, (e) => {
        const pr = project(e.p, x0, y0);
        if (!pr || pr.dist > 2) return;
        if (e.oneway !== -1) add(e, true, pr.s, kind);
        if (e.oneway !== 1) add(e, false, pr.s, kind);
      });
    }
    // bus stops at the kerb: on the street beside them, for traffic going the way that has the
    // stop on its right
    const f = world.furniture;
    for (let i = 0; i < f.length; i += 4) {
      if (f[i + 3] !== 3 && f[i + 3] !== 4) continue;
      const x0 = f[i], y0 = f[i + 1];
      let best: Edge | null = null, bs = 0, bd = 9, bdx = 0, bdy = 0;
      near(x0, y0, 9, (e) => {
        if (e.cls > 5) return;
        const pr = project(e.p, x0, y0);
        if (pr && pr.dist < bd) (bd = pr.dist), (best = e), (bs = pr.s), (bdx = pr.dx), (bdy = pr.dy);
      });
      if (!best) continue;
      const e: Edge = best;
      const px = along(e.p, bs);
      // the stop is on the right of the direction whose right-hand normal points at it
      const right = (x0 - px.x) * -bdy + (y0 - px.y) * bdx > 0;
      const fwd = right;
      if ((fwd && e.oneway === -1) || (!fwd && e.oneway === 1)) continue;
      add(e, fwd, bs, MARK_BUS_STOP);
    }
    // Where no sign is mapped, a side street still gives way to the bigger road it comes out on
    // (the major road's priority signs are rarely in the map): an approach yields when a road of a
    // higher class runs through the junction ahead, unless traffic lights or a sign already
    // govern it. Not drawn: the map has no sign there.
    const incident: Edge[][] = Array.from({ length: g.nodes.length / 2 }, () => []);
    for (const e of g.edges) {
      incident[e.a].push(e);
      if (e.b !== e.a) incident[e.b].push(e);
    }
    const lights = world.lights;
    for (const e of g.edges) {
      if (e.len < 8) continue;
      for (const fwd of [true, false]) {
        if ((fwd && e.oneway === -1) || (!fwd && e.oneway === 1)) continue;
        const node = fwd ? e.b : e.a;
        const bigger = incident[node].filter((f) => f !== e && f.cls < e.cls).length;
        if (bigger < 2) continue;
        const link = { edge: e, fwd, to: node } as Link;
        const s = fwd ? e.len - 4.5 : 4.5;
        const near = (m: { x: number; y: number }) => Math.hypot(m.x - g.nx(node), m.y - g.ny(node)) < 18;
        if (lights.forLink(link).some(near) || this.forLink(link).some((m) => m.kind < MARK_BUMP && near(m))) continue;
        add(e, fwd, s, MARK_GIVE_WAY);
      }
    }
    for (const [id, entry] of this.byEdge) {
      const e = g.edges[id];
      const pos = (l: Mark) => (l.x - e.p[0]) * l.ux + (l.y - e.p[1]) * l.uy;
      entry.fwd.sort((p, q) => pos(p) - pos(q));
      entry.rev.sort((p, q) => pos(p) - pos(q));
    }
  }

  /** signs and bumps met while driving `link`, in order */
  forLink(link: Link): Mark[] {
    const entry = this.byEdge.get(link.edge.id);
    return entry ? (link.fwd ? entry.fwd : entry.rev) : NO_MARKS;
  }
}

const NO_MARKS: Mark[] = [];

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
