export interface Vec {
  x: number;
  y: number;
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay);
export const dist2 = (ax: number, ay: number, bx: number, by: number) => (bx - ax) ** 2 + (by - ay) ** 2;

/** Smallest signed difference between two angles, in (-PI, PI]. */
export function angleDiff(a: number, b: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const pick = <T>(arr: readonly T[]) => arr[(Math.random() * arr.length) | 0];

/** Closest point on segment AB to P; returns t in [0,1]. */
export function segT(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return 0;
  return clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
}

export function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const t = segT(px, py, ax, ay, bx, by);
  return dist2(px, py, ax + (bx - ax) * t, ay + (by - ay) * t);
}

/** Even-odd point in polygon test over several flat rings. */
export function pointInRings(x: number, y: number, rings: ArrayLike<number>[]) {
  let inside = false;
  for (const r of rings) {
    const n = r.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Segment-segment intersection; returns t along the first segment or -1. */
export function segIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (den === 0) return -1;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function bboxOf(flat: ArrayLike<number>, pad = 0, into?: BBox): BBox {
  const b = into ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] - pad < b.x0) b.x0 = flat[i] - pad;
    if (flat[i] + pad > b.x1) b.x1 = flat[i] + pad;
    if (flat[i + 1] - pad < b.y0) b.y0 = flat[i + 1] - pad;
    if (flat[i + 1] + pad > b.y1) b.y1 = flat[i + 1] + pad;
  }
  return b;
}

export const bboxHit = (a: BBox, b: BBox) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

export function polylineLength(p: ArrayLike<number>) {
  let l = 0;
  for (let i = 2; i < p.length; i += 2) l += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return l;
}

export function ringArea(r: ArrayLike<number>) {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += (r[j] + r[i]) * (r[j + 1] - r[i + 1]);
  return Math.abs(a / 2);
}

export function formatMoney(v: number) {
  return '€' + Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
