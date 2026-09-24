import type { GraphJSON } from '../types';
import { polylineLength } from '../util/math';

export interface Edge {
  id: number;
  a: number;
  b: number;
  p: Float32Array;
  len: number;
  cls: number;
  width: number;
  oneway: 0 | 1 | -1;
  name: number;
  speed: number;
}

/** A directed traversal of an edge: forward (a -> b) or reverse (b -> a). */
export interface Link {
  edge: Edge;
  fwd: boolean;
  to: number;
}

const CELL = 64;
/** default speed (m/s) by road class when the data has none */
const CLASS_SPEED = [22, 18, 14, 13, 12, 10, 6, 6, 5, 4, 3];

/** Street network used for AI navigation (cars, trams, pedestrians). */
export class Graph {
  nodes: Float32Array;
  edges: Edge[];
  out: Link[][];
  /** path cost per edge id (defaults to length) */
  cost: Float32Array;
  private grid = new Map<number, number[]>();

  constructor(json: GraphJSON, directed: boolean, costFn?: (e: Edge) => number) {
    this.nodes = Float32Array.from(json.nodes);
    const n = this.nodes.length / 2;
    this.out = Array.from({ length: n }, () => []);
    this.edges = json.edges.map((e, id) => ({
      id,
      a: e.a,
      b: e.b,
      p: Float32Array.from(e.p),
      len: polylineLength(e.p),
      cls: e.c,
      width: e.w,
      oneway: directed ? (e.o ?? 0) : 0,
      name: e.n ?? -1,
      speed: e.s ?? CLASS_SPEED[e.c] ?? 5,
    }));
    this.cost = Float32Array.from(this.edges, (e) => (costFn ? costFn(e) : e.len));
    for (const e of this.edges) {
      if (e.oneway !== -1) this.out[e.a].push({ edge: e, fwd: true, to: e.b });
      if (e.oneway !== 1) this.out[e.b].push({ edge: e, fwd: false, to: e.a });
    }
    for (let i = 0; i < n; i++) {
      const k = this.key(this.nodes[i * 2], this.nodes[i * 2 + 1]);
      let c = this.grid.get(k);
      if (!c) this.grid.set(k, (c = []));
      c.push(i);
    }
  }

  private key(x: number, y: number) {
    return (Math.floor(x / CELL) + 1000) * 4096 + Math.floor(y / CELL) + 1000;
  }

  nx(i: number) {
    return this.nodes[i * 2];
  }
  ny(i: number) {
    return this.nodes[i * 2 + 1];
  }

  /** Nearest node with at least one outgoing link (within maxDist). */
  nearest(x: number, y: number, maxDist = 400, filter?: (i: number) => boolean) {
    let best = -1, bestD = maxDist * maxDist;
    const r = Math.ceil(maxDist / CELL);
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let ring = 0; ring <= r; ring++) {
      for (let gx = cx - ring; gx <= cx + ring; gx++) {
        for (let gy = cy - ring; gy <= cy + ring; gy++) {
          if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== ring) continue;
          const cell = this.grid.get((gx + 1000) * 4096 + gy + 1000);
          if (!cell) continue;
          for (const i of cell) {
            if (!this.out[i].length || (filter && !filter(i))) continue;
            const d = (this.nodes[i * 2] - x) ** 2 + (this.nodes[i * 2 + 1] - y) ** 2;
            if (d < bestD) (bestD = d), (best = i);
          }
        }
      }
      // once found, one extra ring is enough to guarantee the true nearest
      if (best >= 0 && ring * CELL > Math.sqrt(bestD) + CELL) break;
    }
    return best;
  }

  /** All nodes in the annulus [rMin, rMax] around (x, y). */
  nodesAround(x: number, y: number, rMin: number, rMax: number) {
    const res: number[] = [];
    const r = Math.ceil(rMax / CELL);
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let gx = cx - r; gx <= cx + r; gx++)
      for (let gy = cy - r; gy <= cy + r; gy++) {
        const cell = this.grid.get((gx + 1000) * 4096 + gy + 1000);
        if (!cell) continue;
        for (const i of cell) {
          const d = Math.hypot(this.nodes[i * 2] - x, this.nodes[i * 2 + 1] - y);
          if (d >= rMin && d <= rMax && this.out[i].length) res.push(i);
        }
      }
    return res;
  }

  /** A* shortest path, returns the list of links to follow (or null). */
  path(from: number, to: number, maxIter = 6000): Link[] | null {
    if (from < 0 || to < 0) return null;
    if (from === to) return [];
    const n = this.out.length;
    const g = new Float64Array(n).fill(Infinity);
    const prev: (Link | null)[] = new Array(n).fill(null);
    const prevNode = new Int32Array(n).fill(-1);
    const tx = this.nx(to), ty = this.ny(to);
    const open: [number, number][] = [[0, from]];
    g[from] = 0;
    let iter = 0;
    while (open.length && iter++ < maxIter) {
      // binary heap pop
      const [, cur] = open[0];
      const last = open.pop()!;
      if (open.length) {
        open[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < open.length && open[l][0] < open[m][0]) m = l;
          if (r < open.length && open[r][0] < open[m][0]) m = r;
          if (m === i) break;
          [open[i], open[m]] = [open[m], open[i]];
          i = m;
        }
      }
      if (cur === to) break;
      for (const link of this.out[cur]) {
        const ng = g[cur] + this.cost[link.edge.id];
        if (ng < g[link.to]) {
          g[link.to] = ng;
          prev[link.to] = link;
          prevNode[link.to] = cur;
          const f = ng + Math.hypot(this.nx(link.to) - tx, this.ny(link.to) - ty);
          open.push([f, link.to]);
          let i = open.length - 1;
          while (i > 0) {
            const p = (i - 1) >> 1;
            if (open[p][0] <= open[i][0]) break;
            [open[p], open[i]] = [open[i], open[p]];
            i = p;
          }
        }
      }
    }
    if (!prev[to]) return null;
    const res: Link[] = [];
    for (let c = to; c !== from; c = prevNode[c]) res.push(prev[c]!);
    return res.reverse();
  }
}

/** Polyline points of a link in travel order, with an optional lateral offset
 *  to the right-hand side (driving on the right in Slovakia). */
export function linkPoints(link: Link, offset = 0): number[] {
  const p = link.edge.p;
  const pts: number[] = [];
  const n = p.length / 2;
  for (let k = 0; k < n; k++) {
    const i = link.fwd ? k : n - 1 - k;
    pts.push(p[i * 2], p[i * 2 + 1]);
  }
  if (!offset) return pts;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const k0 = Math.max(0, k - 1), k1 = Math.min(n - 1, k + 1);
    const dx = pts[k1 * 2] - pts[k0 * 2], dy = pts[k1 * 2 + 1] - pts[k0 * 2 + 1];
    const l = Math.hypot(dx, dy) || 1;
    // right-hand normal in a y-down world is (-dy, dx)
    out.push(pts[k * 2] - (dy / l) * offset, pts[k * 2 + 1] + (dx / l) * offset);
  }
  return out;
}
