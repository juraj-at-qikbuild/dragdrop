// Build-time building geometry for the fake-3D renderer: which parts of each wall are actually
// exposed (party walls shared with a neighbour are hidden, or only show above a lower neighbour's
// roof), and roof slopes (hipped/gabled bands) for pitched roofs. Pure functions over World data.

import type { Building, World } from '../shared/world/World';
import { pointInRings, segIntersect } from '../shared/util/math';

/** metres per storey */
export const STOREY = 3.2;

/** drawn height, in storeys, of a building (canopies are thin roofs on posts) */
export function heightBin(b: Building): number {
  return b.kind === 4 ? 0.6 : Math.min(14, Math.round(b.levels));
}

/** cheap deterministic hash -> [0,1) */
export function hash01(a: number, b: number) {
  let h = (a * 374761393 + b * 668265263) ^ ((a << 13) | 0);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return ((h >>> 0) % 10000) / 10000;
}

/** Floats per wall piece: the original edge's start (ax, ay), unit direction (ux, uy), outward
 *  normal (nx, ny) and length L; the piece's range u0..u1 (metres along that edge); the height
 *  (m) the visible wall starts at (0 = ground, else a lower neighbour's roof); facade variant
 *  (0-2); shopfront flag. Pieces of one edge share the edge's frame so facades stay aligned. */
export const WP = 12;

/** gap tolerance when looking for a neighbour against a wall (OSM outlines don't always touch) */
const PROBES = [0.35, 0.9];
/** wall pieces shorter than this are merged into their neighbour */
const MIN_PIECE = 0.3;

interface Cover {
  t0: number;
  t1: number;
  h: number;
}

/** Stretches of edge A->B (outward normal n) that stand against another solid building, and
 *  that building's drawn height: the edge, offset slightly outward, is clipped exactly against
 *  every nearby building's rings. `t` runs 0..1 along the edge. */
function coverage(world: World, self: Building, ax: number, ay: number, bx: number, by: number, nx: number, ny: number): Cover[] {
  const out: Cover[] = [];
  const pad = PROBES[PROBES.length - 1] + 0.1;
  world.forBuildingsNear(Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.max(ax, bx) + pad, Math.max(ay, by) + pad, (o) => {
    if (o === self || !o.solid) return;
    const oh = heightBin(o) * STOREY;
    for (const d of PROBES) {
      const px = ax + nx * d, py = ay + ny * d, qx = bx + nx * d, qy = by + ny * d;
      const ts = [0, 1];
      for (const r of o.rings)
        for (let i = 0; i < r.length - 2; i += 2) {
          const t = segIntersect(px, py, qx, qy, r[i], r[i + 1], r[i + 2], r[i + 3]);
          if (t > 0 && t < 1) ts.push(t);
        }
      ts.sort((a, b) => a - b);
      for (let k = 0; k < ts.length - 1; k++) {
        const t0 = ts[k], t1 = ts[k + 1];
        if (t1 - t0 < 1e-4) continue;
        const tm = (t0 + t1) / 2;
        if (pointInRings(px + (qx - px) * tm, py + (qy - py) * tm, o.rings)) out.push({ t0, t1, h: oh });
      }
    }
  });
  return out;
}

/** Split an edge of length L into runs of constant "wall base": the tallest neighbour standing
 *  against it there (capped at our own height `ownH`), or 0 where nothing does. */
function baseRuns(cover: Cover[], ownH: number, L: number): [number, number, number][] {
  if (!cover.length) return [[0, 1, 0]];
  const ts = [0, 1];
  for (const c of cover) ts.push(c.t0, c.t1);
  ts.sort((a, b) => a - b);
  const runs: [number, number, number][] = [];
  for (let k = 0; k < ts.length - 1; k++) {
    const t0 = ts[k], t1 = ts[k + 1];
    if (t1 - t0 < 1e-6) continue;
    const tm = (t0 + t1) / 2;
    let h = 0;
    for (const c of cover) if (c.t0 <= tm && tm <= c.t1 && c.h > h) h = c.h;
    const base = Math.min(h, ownH);
    const last = runs[runs.length - 1];
    if (last && last[2] === base) last[1] = t1;
    else runs.push([t0, t1, base]);
  }
  // fold slivers into a neighbouring run (the earlier one, or the next for the first run)
  for (let k = 0; k < runs.length && runs.length > 1; ) {
    if ((runs[k][1] - runs[k][0]) * L >= MIN_PIECE) {
      k++;
      continue;
    }
    if (k > 0) runs[k - 1][1] = runs[k][1];
    else runs[1][0] = runs[0][0];
    runs.splice(k, 1);
    // re-merge equal neighbours
    if (k > 0 && k < runs.length && runs[k - 1][2] === runs[k][2]) {
      runs[k - 1][1] = runs[k][1];
      runs.splice(k, 1);
    }
  }
  return runs;
}

/** Exposed wall pieces of a building (see WP), and per edge how much of it is exposed at
 *  ground level (for picking a shopfront). Party walls against a building at least as tall are
 *  dropped; against a lower one, the piece starts at that neighbour's roof. */
export function wallPieces(world: World, b: Building, ownH: number): number[] {
  const out: number[] = [];
  if (b.kind === 4) return out; // canopies: a roof on posts, no walls
  for (const r of b.rings) {
    for (let i = 0; i < r.length - 2; i += 2) {
      const ax = r[i], ay = r[i + 1], bx = r[i + 2], by = r[i + 3];
      const ex = bx - ax, ey = by - ay;
      const L = Math.hypot(ex, ey);
      if (L < 0.05) continue;
      const ux = ex / L, uy = ey / L, nx = uy, ny = -ux;
      const variant = (hash01((ax * 131 + ay * 977) | 0, 4) * 3) | 0;
      for (const [t0, t1, base] of baseRuns(coverage(world, b, ax, ay, bx, by, nx, ny), ownH, L)) {
        if (base >= ownH - 0.05) continue;
        out.push(ax, ay, ux, uy, nx, ny, L, t0 * L, t1 * L, base, variant, 0);
      }
    }
  }
  return out;
}

/** One roof slope: a polygon running up from an eave edge, the compass bucket (0-7, by angle of
 *  its downslope direction) it is shaded with, and its hip/ridge lines (flat x0,y0,x1,y1,...). */
export interface RoofBand {
  pts: number[];
  dir: number;
  lines: number[];
}

/** Drop near-duplicate vertices (< 0.3 m apart) and near-straight ones (turn < 12°) from a closed
 *  ring, so tiny OSM kinks don't turn into roof spikes. Returns open [x,y,...] or null if degenerate. */
function cleanRing(r: ArrayLike<number>): number[] | null {
  let pts: number[] = [];
  for (let i = 0; i < r.length - 2; i += 2) {
    const n = pts.length;
    if (n && Math.hypot(r[i] - pts[n - 2], r[i + 1] - pts[n - 1]) < 0.3) continue;
    pts.push(r[i], r[i + 1]);
  }
  if (pts.length >= 4 && Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1]) < 0.3) pts.length -= 2;
  const COS12 = Math.cos((12 * Math.PI) / 180);
  for (let changed = true; changed && pts.length >= 6; ) {
    changed = false;
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const p = (i + n - 1) % n, q = (i + 1) % n;
      const ax = pts[i * 2] - pts[p * 2], ay = pts[i * 2 + 1] - pts[p * 2 + 1];
      const bx = pts[q * 2] - pts[i * 2], by = pts[q * 2 + 1] - pts[i * 2 + 1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 1e-6 || lb < 1e-6 || (ax * bx + ay * by) / (la * lb) > COS12) {
        pts.splice(i * 2, 2);
        changed = true;
        break;
      }
    }
  }
  return pts.length >= 6 ? pts : null;
}

/** Distance from (px,py) along (dx,dy) to the nearest edge of `rings` (open [x,y,...] rings). */
function rayToRings(px: number, py: number, dx: number, dy: number, rings: number[][]): number {
  let best = Infinity;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = r[i * 2], ay = r[i * 2 + 1], j = (i + 1) % n;
      const ex = r[j * 2] - ax, ey = r[j * 2 + 1] - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((ax - px) * ey - (ay - py) * ex) / den;
      const u = ((ax - px) * dy - (ay - py) * dx) / den;
      if (t > 0.05 && u >= 0 && u <= 1 && t < best) best = t;
    }
  }
  return best;
}

/** Keep the part of convex polygon `poly` on the same side of the line through (ox,oy) with
 *  direction (dx,dy) as the point (kx,ky). */
function clipHalf(poly: number[], ox: number, oy: number, dx: number, dy: number, kx: number, ky: number): number[] {
  const side = (x: number, y: number) => dx * (y - oy) - dy * (x - ox);
  const ks = side(kx, ky) >= 0 ? 1 : -1;
  const out: number[] = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2], ay = poly[i * 2 + 1], bx = poly[j * 2], by = poly[j * 2 + 1];
    const sa = side(ax, ay) * ks, sb = side(bx, by) * ks;
    if (sa >= 0) out.push(ax, ay);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  return out;
}

/** Roof slopes for a pitched building. Eaves are the edges not standing against a neighbour;
 *  each gets a band sloping up to depth D (half the building's typical thickness, capped at 8 m),
 *  cut at each end along the corner bisector (another eave: a hip) or along the neighbouring
 *  party wall (a gable end), which for simple outlines is exactly a hipped/gabled roof, and on
 *  terraces gives one continuous roof along the street. Bands that don't fit cleanly inside the
 *  outline are dropped; null when nothing usable is left. */
export function roofSlopes(world: World, b: Building): RoofBand[] | null {
  const rings = b.rings.map(cleanRing).filter((r): r is number[] => !!r);
  if (!rings.length) return null;
  type Edge = { ax: number; ay: number; bx: number; by: number; ux: number; uy: number; nx: number; ny: number; L: number; eave: boolean; half: number };
  const ringEdges: Edge[][] = [];
  const depths: [number, number][] = [];
  for (const r of rings) {
    const n = r.length / 2;
    const edges: Edge[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = r[i * 2], ay = r[i * 2 + 1], bx = r[j * 2], by = r[j * 2 + 1];
      const L = Math.hypot(bx - ax, by - ay) || 1e-6;
      const ux = (bx - ax) / L, uy = (by - ay) / L;
      const nx = uy, ny = -ux;
      // party edge: at least half of it stands against another building (any height)
      let covered = 0;
      const cov = coverage(world, b, ax, ay, bx, by, nx, ny).sort((p, q) => p.t0 - q.t0);
      let reach = 0;
      for (const c of cov) {
        const t0 = Math.max(c.t0, reach);
        if (c.t1 > t0) (covered += c.t1 - t0), (reach = c.t1);
      }
      const eave = covered < 0.5;
      let half = Infinity;
      if (eave) {
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        half = rayToRings(mx - nx * 0.01, my - ny * 0.01, -nx, -ny, rings) / 2;
        if (L >= 2 && isFinite(half)) depths.push([half, L]);
      }
      edges.push({ ax, ay, bx, by, ux, uy, nx, ny, L, eave, half });
    }
    ringEdges.push(edges);
  }
  if (!depths.length) return null;
  // slope depth: length-weighted 20th percentile of the eaves' half-thickness (one notch
  // doesn't flatten the whole roof, a thin wing still gets bands that fit)
  depths.sort((p, q) => p[0] - q[0]);
  let total = 0;
  for (const d of depths) total += d[1];
  let acc = 0, D = depths[depths.length - 1][0];
  for (const d of depths) {
    acc += d[1];
    if (acc >= total * 0.2) {
      D = d[0];
      break;
    }
  }
  if (D < 0.8) return null;
  D = Math.min(8, Math.max(1.2, D));

  const all = ringEdges.flat();
  const bands: RoofBand[] = [];
  for (const edges of ringEdges) {
    const n = edges.length;
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      if (!e.eave) continue;
      const p = edges[(i + n - 1) % n], q = edges[(i + 1) % n];
      // a thin wing gets its own shallower band rather than none
      const own = Math.min(D, e.half);
      for (const d of own < D ? [D, own, own * 0.6] : [D, D * 0.6]) {
        if (d < 0.8) break;
        const band = slopeBand(e, p, q, d, all, b);
        if (band) {
          bands.push(band);
          break;
        }
      }
    }
  }
  return bands.length ? bands : null;
}

type SlopeEdge = { ax: number; ay: number; bx: number; by: number; ux: number; uy: number; nx: number; ny: number; eave: boolean };

/** The slope band for eave edge `e` (between edges `p` and `q`) at depth `D`, or null if it
 *  doesn't fit inside the outline. */
function slopeBand(e: SlopeEdge, p: SlopeEdge, q: SlopeEdge, D: number, all: SlopeEdge[], b: Building): RoofBand | null {
  const inx = -e.nx, iny = -e.ny;
  const ext = 3 * D;
  let poly = [
    e.ax - e.ux * ext, e.ay - e.uy * ext,
    e.bx + e.ux * ext, e.by + e.uy * ext,
    e.bx + e.ux * ext + inx * D, e.by + e.uy * ext + iny * D,
    e.ax - e.ux * ext + inx * D, e.ay - e.uy * ext + iny * D,
  ];
  const kx = (e.ax + e.bx) / 2 + inx * 0.01, ky = (e.ay + e.by) / 2 + iny * 0.01;
  // cut direction at each end: the corner bisector toward another eave (a hip), else along the
  // party wall (a gable end)
  const cut = (o: SlopeEdge): [number, number, boolean] => {
    if (!o.eave) return [o.ux, o.uy, true];
    const sx = -o.nx + inx, sy = -o.ny + iny;
    const l = Math.hypot(sx, sy);
    return l < 1e-3 ? [inx, iny, false] : [sx / l, sy / l, false];
  };
  const [adx, ady, aParty] = cut(p);
  const [bdx, bdy, bParty] = cut(q);
  poly = clipHalf(poly, e.ax, e.ay, adx, ady, kx, ky);
  if (poly.length >= 6) poly = clipHalf(poly, e.bx, e.by, bdx, bdy, kx, ky);
  if (poly.length < 6 || !bandFits(poly, e, p, q, all, b)) return null;
  // hip and ridge lines: every band edge except the eave itself and edges along a party wall
  const lines: number[] = [];
  const m = poly.length / 2;
  const onLine = (x: number, y: number, ox: number, oy: number, dx: number, dy: number) => Math.abs(dx * (y - oy) - dy * (x - ox)) < 0.02;
  for (let k = 0; k < m; k++) {
    const x0 = poly[k * 2], y0 = poly[k * 2 + 1], x1 = poly[((k + 1) % m) * 2], y1 = poly[((k + 1) % m) * 2 + 1];
    if (onLine(x0, y0, e.ax, e.ay, e.ux, e.uy) && onLine(x1, y1, e.ax, e.ay, e.ux, e.uy)) continue;
    if (aParty && onLine(x0, y0, e.ax, e.ay, adx, ady) && onLine(x1, y1, e.ax, e.ay, adx, ady)) continue;
    if (bParty && onLine(x0, y0, e.bx, e.by, bdx, bdy) && onLine(x1, y1, e.bx, e.by, bdx, bdy)) continue;
    if (Math.hypot(x1 - x0, y1 - y0) > 0.05) lines.push(x0, y0, x1, y1);
  }
  const dir = ((Math.round(Math.atan2(e.ny, e.nx) / (Math.PI / 4)) % 8) + 8) % 8;
  return { pts: poly, dir, lines };
}

/** A band is usable when its inner corners lie inside the outline (tested 5 cm in from the
 *  corner) and its edges don't cut across the outline anywhere but its own and adjacent edges. */
function bandFits(poly: number[], e: SlopeEdge, p: SlopeEdge, q: SlopeEdge, edges: SlopeEdge[], b: Building): boolean {
  const m = poly.length / 2;
  let cx = 0, cy = 0;
  for (let k = 0; k < m; k++) (cx += poly[k * 2]), (cy += poly[k * 2 + 1]);
  (cx /= m), (cy /= m);
  for (let k = 0; k < m; k++) {
    const x = poly[k * 2], y = poly[k * 2 + 1];
    if (Math.hypot(x - e.ax, y - e.ay) < 1e-3 || Math.hypot(x - e.bx, y - e.by) < 1e-3) continue;
    const d = Math.hypot(cx - x, cy - y) || 1;
    const s = Math.min(0.05, d * 0.5) / d;
    if (!pointInRings(x + (cx - x) * s, y + (cy - y) * s, b.rings)) return false;
  }
  for (let k = 0; k < m; k++) {
    const x0 = poly[k * 2], y0 = poly[k * 2 + 1], x1 = poly[((k + 1) % m) * 2], y1 = poly[((k + 1) % m) * 2 + 1];
    for (const o of edges) {
      if (o === e || o === p || o === q) continue;
      const t = segIntersect(x0, y0, x1, y1, o.ax, o.ay, o.bx, o.by);
      if (t > 1e-3 && t < 1 - 1e-3) return false;
    }
  }
  return true;
}
