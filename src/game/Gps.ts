// Satnav: a route from the player to their waypoint (set on the city map) or to the current mission
// target, over the real street network: by car along the roads (one-way streets respected), on foot
// along the footpaths. Drawn on the minimap and the city map; client only.
import type { Game } from './Game';
import type { Graph } from '../shared/world/Graph';
import { linkPoints } from '../shared/world/Graph';
import { dist } from '../shared/util/math';

/** how often the route is worked out again (s) */
const REFRESH = 1.5;
/** further than this off the route (m), it's worked out again right away */
const OFF_ROUTE = 22;
/** a waypoint this close (m) counts as reached */
const ARRIVED = 14;

export interface GpsTarget {
  x: number;
  y: number;
  /** a waypoint the player set, or where the mission wants them */
  kind: 'waypoint' | 'mission';
}

export class Gps {
  /** the player's own waypoint (the mission target, when there is one, takes precedence) */
  waypoint: { x: number; y: number } | null = null;
  /** what the route leads to right now */
  target: GpsTarget | null = null;
  /** the route: flat [x, y, ...] from the player to the target */
  route: number[] = [];
  /** its length (m) */
  length = 0;
  private timer = 0;
  private key = '';

  constructor(private g: Game) {}

  setWaypoint(x: number, y: number) {
    this.waypoint = { x, y };
    this.timer = 0;
  }

  clearWaypoint() {
    this.waypoint = null;
    this.timer = 0;
  }

  update(dt: number) {
    const g = this.g;
    const mt = g.missions.active ? g.missions.target() : null;
    this.target = mt ? { x: mt.x, y: mt.y, kind: 'mission' } : this.waypoint ? { ...this.waypoint, kind: 'waypoint' } : null;
    const t = this.target;
    if (!t) {
      this.route = [];
      this.length = 0;
      return;
    }
    const f = g.focus();
    if (t.kind === 'waypoint' && dist(f.x, f.y, t.x, t.y) < ARRIVED) {
      this.waypoint = null;
      this.route = [];
      g.message('', 'Cieľ dosiahnutý', 2, '#b388ff');
      return;
    }
    const inCar = !!g.player.vehicle;
    const key = `${t.kind}|${t.x.toFixed(1)}|${t.y.toFixed(1)}|${inCar}`;
    this.timer -= dt;
    if (key !== this.key || this.timer <= 0 || this.offRoute(f.x, f.y)) {
      this.key = key;
      this.timer = REFRESH;
      this.plan(inCar ? g.world.car : g.world.ped, f.x, f.y, t.x, t.y);
    }
    this.trim(f.x, f.y);
  }

  /** Work the route out on `graph` (A*). Falls back to a straight line when there is none. */
  private plan(graph: Graph, fx: number, fy: number, tx: number, ty: number) {
    const a = graph.nearest(fx, fy, 250), b = graph.nearest(tx, ty, 400);
    const links = a >= 0 && b >= 0 ? graph.path(a, b, 40000) : null;
    const out = [fx, fy];
    if (links) for (const l of links) out.push(...linkPoints(l).slice(2));
    else if (a >= 0 && b >= 0 && a === b) out.push(graph.nx(a), graph.ny(a));
    out.push(tx, ty);
    this.route = out;
  }

  /** further than OFF_ROUTE from every segment of the route? */
  private offRoute(x: number, y: number) {
    const r = this.route;
    if (r.length < 4) return true;
    let best = Infinity;
    for (let i = 0; i < r.length - 2 && best > OFF_ROUTE; i += 2) best = Math.min(best, segDist(x, y, r[i], r[i + 1], r[i + 2], r[i + 3]));
    return best > OFF_ROUTE;
  }

  /** start the route where the player is along it, and measure what's left */
  private trim(x: number, y: number) {
    const r = this.route;
    if (r.length < 4) return;
    // the closest segment among the first few (the player moves along the start of the route)
    let bi = 0, bd = Infinity, bt = 0;
    for (let i = 0; i < Math.min(r.length - 2, 60); i += 2) {
      const ax = r[i], ay = r[i + 1], dx = r[i + 2] - ax, dy = r[i + 3] - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
      if (d < bd) (bd = d), (bi = i), (bt = t);
    }
    const px = r[bi] + (r[bi + 2] - r[bi]) * bt, py = r[bi + 1] + (r[bi + 3] - r[bi + 1]) * bt;
    this.route = [x, y, px, py, ...r.slice(bi + 2)];
    let L = 0;
    for (let i = 0; i < this.route.length - 2; i += 2) L += Math.hypot(this.route[i + 2] - this.route[i], this.route[i + 3] - this.route[i + 1]);
    this.length = L;
  }
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(ax + dx * t - px, ay + dy * t - py);
}
