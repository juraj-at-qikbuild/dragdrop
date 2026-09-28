import type { GraphJSON } from '../types';
import { polylineLength, hypot } from '../util/math';

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
  /** car graph: how far right of the centre line traffic drives, going a -> b (laneF) and
   *  b -> a (laneR); fitted to the street by World so cars keep clear of the buildings */
  laneF?: number;
  laneR?: number;
  /** car graph: even the best lane that way runs into a building (a garage door, a courtyard the
   *  map has no passage into): traffic doesn't use it */
  blockedF?: boolean;
  blockedR?: boolean;
  /** pedestrian graph: how far from the centre line people walk on the right (walkR) and the
   *  left (walkL) of a -> b; fitted by World so they stay clear of walls and water */
  walkR?: number;
  walkL?: number;
  /** pedestrian graph: bollards or blocks across it stop cars (police routing avoids it) */
  noCars?: boolean;
  /** pedestrian graph: nobody walks it: it leads off the map, or even its best walking line runs
   *  into a building or the river (steps down to the water, a door the path ends at) */
  noWalk?: boolean;
  /** car graph: marked lanes a -> b and b -> a, when either way has more than one (else undefined) */
  lanesF?: number;
  lanesR?: number;
  /** tram graph: bit mask of the tram lines running along it (1 << line number) */
  lines: number;
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
  /** car graph: per node, how many links it is into a dead-end branch (cul-de-sac, courtyard,
   *  a road off the edge of the map); 0 on the through network. Set by World. */
  depth: Int32Array | null = null;
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
      noCars: e.x === 1 || undefined,
      lanesF: e.ln?.[0],
      lanesR: e.ln?.[1],
      lines: e.r ?? 0,
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

  /** every edge segment by grid cell (edge id << 12 | segment index), built on first use */
  private segs: Map<number, number[]> | null = null;

  /** The edge segment nearest (x, y) within `maxDist`: its edge, its direction a → b (a unit vector)
   *  and how far away it is. (The style combo's wrong way down a one-way street: rules/Style.ts.) */
  segmentAt(x: number, y: number, maxDist = 6): { edge: Edge; dx: number; dy: number; d: number } | null {
    if (!this.segs) this.segs = this.indexSegments();
    let best: { edge: Edge; dx: number; dy: number; d: number } | null = null;
    let bd = maxDist * maxDist;
    const r = Math.ceil(maxDist / CELL);
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let gx = cx - r; gx <= cx + r; gx++)
      for (let gy = cy - r; gy <= cy + r; gy++)
        for (const code of this.segs.get((gx + 1000) * 4096 + gy + 1000) ?? []) {
          const e = this.edges[code >> 12], k = (code & 4095) * 2, p = e.p;
          const ax = p[k], ay = p[k + 1], bx = p[k + 2], by = p[k + 3];
          const ux = bx - ax, uy = by - ay, l2 = ux * ux + uy * uy;
          if (l2 < 1e-6) continue;
          const t = Math.max(0, Math.min(1, ((x - ax) * ux + (y - ay) * uy) / l2));
          const qx = ax + ux * t - x, qy = ay + uy * t - y, d2 = qx * qx + qy * qy;
          if (d2 >= bd) continue;
          bd = d2;
          const l = Math.sqrt(l2);
          best = { edge: e, dx: ux / l, dy: uy / l, d: Math.sqrt(d2) };
        }
    return best;
  }

  private indexSegments() {
    const out = new Map<number, number[]>();
    for (const e of this.edges) {
      const p = e.p;
      for (let k = 0; k + 3 < p.length && k / 2 < 4096; k += 2) {
        const x0 = Math.floor(Math.min(p[k], p[k + 2]) / CELL), x1 = Math.floor(Math.max(p[k], p[k + 2]) / CELL);
        const y0 = Math.floor(Math.min(p[k + 1], p[k + 3]) / CELL), y1 = Math.floor(Math.max(p[k + 1], p[k + 3]) / CELL);
        for (let gx = x0; gx <= x1; gx++)
          for (let gy = y0; gy <= y1; gy++) {
            const key = (gx + 1000) * 4096 + gy + 1000;
            let c = out.get(key);
            if (!c) out.set(key, (c = []));
            c.push((e.id << 12) | (k / 2));
          }
      }
    }
    return out;
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
            if (!this.out[i].length) continue;
            const d = (this.nodes[i * 2] - x) ** 2 + (this.nodes[i * 2 + 1] - y) ** 2;
            // (the filter can be costly: only asked about nodes that would be the nearest yet)
            if (d < bestD && (!filter || filter(i))) (bestD = d), (best = i);
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
          const d = hypot(this.nodes[i * 2] - x, this.nodes[i * 2 + 1] - y);
          if (d >= rMin && d <= rMax && this.out[i].length) res.push(i);
        }
      }
    return res;
  }

  /** A* scratch, reused by every search on this graph: g, the link and node each node was reached
   *  by, valid only where `seen` holds the current search's stamp (so nothing is refilled per search),
   *  and the open list as a binary heap over parallel arrays (no [f, node] pair per push) */
  private sg: Float64Array | null = null;
  private sPrev: (Link | null)[] = [];
  private sPrevNode: Int32Array | null = null;
  private sSeen: Uint32Array | null = null;
  private sStamp = 0;
  private hf = new Float64Array(256);
  private hn = new Int32Array(256);

  /** A* shortest path, returns the list of links to follow (or null). */
  path(from: number, to: number, maxIter = 6000): Link[] | null {
    if (from < 0 || to < 0) return null;
    if (from === to) return [];
    const n = this.out.length;
    if (!this.sg) (this.sg = new Float64Array(n)), (this.sPrev = new Array(n).fill(null)), (this.sPrevNode = new Int32Array(n)), (this.sSeen = new Uint32Array(n));
    if (++this.sStamp === 0xffffffff) (this.sSeen!.fill(0), (this.sStamp = 1));
    const g = this.sg, prev = this.sPrev, prevNode = this.sPrevNode!, seen = this.sSeen!, stamp = this.sStamp;
    const tx = this.nx(to), ty = this.ny(to);
    let hf = this.hf, hn = this.hn, len = 1;
    hf[0] = 0;
    hn[0] = from;
    seen[from] = stamp;
    g[from] = 0;
    prev[from] = null;
    prevNode[from] = -1;
    let iter = 0;
    while (len && iter++ < maxIter) {
      // binary heap pop
      const cur = hn[0];
      len--;
      if (len) {
        hf[0] = hf[len];
        hn[0] = hn[len];
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < len && hf[l] < hf[m]) m = l;
          if (r < len && hf[r] < hf[m]) m = r;
          if (m === i) break;
          const f = hf[i], k = hn[i];
          (hf[i] = hf[m]), (hn[i] = hn[m]), (hf[m] = f), (hn[m] = k);
          i = m;
        }
      }
      if (cur === to) break;
      const gc = seen[cur] === stamp ? g[cur] : Infinity;
      for (const link of this.out[cur]) {
        const t = link.to;
        const ng = gc + this.cost[link.edge.id];
        if (ng < (seen[t] === stamp ? g[t] : Infinity)) {
          seen[t] = stamp;
          g[t] = ng;
          prev[t] = link;
          prevNode[t] = cur;
          const f = ng + hypot(this.nx(t) - tx, this.ny(t) - ty);
          if (len === hf.length) {
            const f2 = new Float64Array(len * 2), n2 = new Int32Array(len * 2);
            f2.set(hf), n2.set(hn);
            (this.hf = hf = f2), (this.hn = hn = n2);
          }
          hf[len] = f;
          hn[len] = t;
          let i = len++;
          while (i > 0) {
            const p = (i - 1) >> 1;
            if (hf[p] <= hf[i]) break;
            const pf = hf[p], pk = hn[p];
            (hf[p] = hf[i]), (hn[p] = hn[i]), (hf[i] = pf), (hn[i] = pk);
            i = p;
          }
        }
      }
    }
    if (seen[to] !== stamp || !prev[to]) return null;
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
    const l = hypot(dx, dy) || 1;
    // right-hand normal in a y-down world is (-dy, dx)
    out.push(pts[k * 2] - (dy / l) * offset, pts[k * 2 + 1] + (dx / l) * offset);
  }
  return out;
}
