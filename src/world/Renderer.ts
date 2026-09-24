import type { World, Building } from './World';
import { bboxOf, bboxHit, rng, pointInRings, ringArea, type BBox } from '../util/math';
import { ROOF_ADS, BRAND_COLORS } from '../data/brands';
import { Atmosphere } from './Atmosphere';
import type { LightLayer } from './Lighting';
import { texture, animateWater, type TexKind } from './Textures';
import { facadeTexture, groundTexture, facadeGlow, groundGlow, type FacadeStyle } from './Facades';

const CHUNK = 128;

/** `tex` (a pattern baked over `color`) replaces `color` when zoomed in enough to see it */
type DrawOp =
  | { kind: 'fill'; color: string; tex?: CanvasPattern }
  | { kind: 'stroke'; color: string; width: number; dash?: number[]; tex?: CanvasPattern };

interface Layer {
  op: DrawOp;
  order: number;
}

interface Ring {
  pts: Float32Array;
  /** +1/-1 winding sign, used to find the outward normal of each edge */
  sign: number;
  /** vertex index of the edge (in `pts`) chosen as this ring's shopfront edge, or -1 for doors-only */
  shopEdge: number;
  /** per-edge constants for the facade passes, EDGE_STRIDE floats per edge (edge i/2):
   *  length, unit direction (ux,uy), outward normal (nx,ny), facade tile variant (0-2) */
  edges: Float32Array;
}

const EDGE_STRIDE = 6;

/** Per-edge facade constants (see `Ring.edges`), so the per-frame facade loops do no
 *  sqrt/hash work of their own. */
function edgeData(pts: ArrayLike<number>, sign: number): Float32Array {
  const n = pts.length / 2 - 1;
  const out = new Float32Array(Math.max(0, n) * EDGE_STRIDE);
  for (let k = 0; k < n; k++) {
    const ax = pts[k * 2], ay = pts[k * 2 + 1];
    const ex = pts[k * 2 + 2] - ax, ey = pts[k * 2 + 3] - ay;
    const elen = Math.hypot(ex, ey);
    const inv = elen > 0 ? 1 / elen : 0;
    const o = k * EDGE_STRIDE;
    out[o] = elen;
    out[o + 1] = ex * inv;
    out[o + 2] = ey * inv;
    out[o + 3] = ey * inv * sign;
    out[o + 4] = -ex * inv * sign;
    out[o + 5] = (hash01((ax * 131 + ay * 977) | 0, 4) * 3) | 0;
  }
  return out;
}

/** 'rgba(...)' strings for the facade Lambert overlay, by alpha in 1/255 steps, so the
 *  per-edge loop reuses interned strings instead of formatting (and the canvas
 *  re-parsing) a fresh colour for every wall edge, every frame */
const SHADE_DARK: string[] = [];
const SHADE_LIGHT: string[] = [];
for (let i = 0; i <= 255; i++) {
  SHADE_DARK.push(`rgba(10,10,16,${i / 255})`);
  SHADE_LIGHT.push(`rgba(255,250,235,${i / 255})`);
}

interface BGroup {
  h: number;
  /** bbox of every member ring, for per-group screen culling */
  bbox: BBox;
  wall: string;
  wallDark: string;
  /** 4 quantised Lambert wall tones, dark to bright */
  wallShades: string[];
  roof: string;
  /** roof colour baked with a tile/concrete texture */
  roofTex?: CanvasPattern;
  pitched: boolean;
  path: Path2D;
  outline: Path2D;
  /** decorative ridge line(s) for pitched roofs */
  ridge: Path2D;
  /** HVAC/skylight/vent details for large flat roofs, chimneys for pitched ones */
  roofDetail: Path2D;
  chimneys: Path2D;
  rings: Ring[];
  levels: number;
  shadow?: Path2D;
  shadowKey?: number;
  /** facade style for close-up window/door rendering; undefined = fences/kind4, keep flat */
  facade?: FacadeStyle;
  /** cached wall-quad Path2D buckets, rebuilt only when the quantised roof offset changes;
   *  `used` flags the non-empty ones so empty tones cost no fill call */
  bucketCache?: { key: string; buckets: Path2D[]; used: boolean[] };
  /** whether ridge/roofDetail/chimneys got any geometry (most groups' are empty) */
  hasRidge: boolean;
  hasRoofDetail: boolean;
  hasChimneys: boolean;
  /** baked facade/ground CanvasPatterns for this group's 3 variants, keyed by day/night
   *  so the per-edge draw loop never has to touch the Facades pattern cache itself */
  facadeCache?: { lit: boolean; upper: CanvasPattern[]; door: CanvasPattern[]; shop: CanvasPattern[] };
  /** glow-only (transparent except lit windows) variants, redrawn after the light composite */
  glowCache?: { upper: (CanvasPattern | null)[]; door: (CanvasPattern | null)[]; shop: (CanvasPattern | null)[] };
  /** shop/brand signs on this group's walls */
  signs: SignInfo[];
}

interface TreeSet {
  shadow: Path2D;
  canopy: Path2D[];
  highlight: Path2D;
}

interface SignInfo {
  ax: number;
  ay: number;
  ux: number;
  uy: number;
  u0: number;
  name: string;
  colors?: [string, string];
}

interface Chunk {
  /** index in `Renderer.chunks`, for cheap visible-set keys */
  idx: number;
  bbox: BBox;
  cx: number;
  cy: number;
  layers: Map<string, Path2D>;
  bgroups: BGroup[];
  trees?: TreeSet;
  lamps?: number[];
  lampPath?: Path2D;
  manholePath?: Path2D;
  /** puddle shapes along roads; only filled at runtime when atmos.wet > 0.3 */
  puddlePath?: Path2D;
}

export interface View {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  camX: number;
  camY: number;
  /** virtual camera height used for the fake-3D building extrusion */
  camH: number;
  scale: number;
}

const AREA_COLORS: Record<string, string> = {
  plaza: '#cdc3ad',
  parking: '#9c9992',
  rail: '#a39c90',
  pitch: '#7aa75a',
  sand: '#dccb8e',
  green: '#86a860',
  wood: '#5e8948',
  water: '#3a6f93',
};
const AREA_ORDER = ['plaza', 'parking', 'rail', 'pitch', 'sand', 'green', 'wood', 'water'];
const AREA_TEX: Partial<Record<string, TexKind>> = { plaza: 'cobble', green: 'grass', pitch: 'grass', wood: 'wood', sand: 'sand', parking: 'asphalt', water: 'water' };

const ROAD_FILL = ['#3f4045', '#414247', '#45464b', '#47484d', '#4a4b50', '#4d4e52', '#555558', '#58595c', '#d6ccb4', '#c8bca1', '#a69a7f'];
const ROAD_CASING = ['#77746d', '#77746d', '#807d76', '#807d76', '#84817a', '#87847d', '#948f87', '#948f87', '#bcb096', '', ''];

const ROOFS = ['#b0583a', '#a04d33', '#b86b4b', '#8b8580', '#7b7772', '#6a6d72', '#94613f', '#b2a28e'];
const FLAT_ROOFS = ['#9fa2a5', '#b3b4b3', '#8e9196', '#a7a39b'];
/** warm pastel Central-European facade palette, replacing the old single brown wall */
const OLD_WALLS = ['#d9c9a8', '#e3d3b4', '#cdb89a', '#e6dcc8', '#c9b79c', '#d8c3a5', '#bfb2a0'];

/** wall brightness from away-from-sun to facing-sun (ambient keeps shaded walls readable) */
const WALL_SHADE_LEVELS = [0.7, 0.8, 0.92, 1.04];

/** generic Old Town shopfront labels for buildings without a named POI */
const GENERIC_SIGNS: [string, string, string][] = [
  ['Potraviny', '#2e7d32', '#fff'],
  ['Kaviareň', '#4e342e', '#ffcc80'],
  ['Lekáreň', '#00897b', '#fff'],
  ['Bar', '#37474f', '#ffca28'],
  ['Trafika', '#5d4037', '#fff'],
  ['Pekáreň', '#f9a825', '#3e2723'],
];

/** Walk a flat [x0,y0,x1,y1,...] polyline at a fixed arc-length step, calling
 *  fn(x, y, nx, ny) at each sample (nx,ny = unit normal to the segment). */
function walkPolyline(p: ArrayLike<number>, step: number, start: number, fn: (x: number, y: number, nx: number, ny: number) => void) {
  let carry = start;
  for (let i = 0; i < p.length - 2; i += 2) {
    const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
    const segLen = Math.hypot(bx - ax, by - ay);
    if (segLen < 1e-3) continue;
    const dx = (bx - ax) / segLen, dy = (by - ay) / segLen;
    const nx = -dy, ny = dx;
    let d = carry;
    while (d < segLen) {
      fn(ax + dx * d, ay + dy * d, nx, ny);
      d += step;
    }
    carry = d - segLen;
  }
}

/** Point at arc-length `dist` from the start of a flat polyline, plus its direction. */
function pointAlong(p: ArrayLike<number>, dist: number): { x: number; y: number; dx: number; dy: number } {
  let acc = 0;
  for (let i = 0; i < p.length - 2; i += 2) {
    const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
    const segLen = Math.hypot(bx - ax, by - ay);
    const dx = segLen > 1e-4 ? (bx - ax) / segLen : 1;
    const dy = segLen > 1e-4 ? (by - ay) / segLen : 0;
    if (acc + segLen >= dist || i + 4 >= p.length) {
      const t = segLen > 1e-4 ? Math.min(1, Math.max(0, (dist - acc) / segLen)) : 0;
      return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, dx, dy };
    }
    acc += segLen;
  }
  const n = p.length;
  return { x: p[n - 2], y: p[n - 1], dx: 1, dy: 0 };
}

/** offset every vertex of a flat polyline perpendicular to its local direction */
function offsetPolyline(p: ArrayLike<number>, off: number): number[] {
  const n = p.length / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = p[i * 2], y = p[i * 2 + 1];
    let dx = 0, dy = 0;
    if (i > 0) { dx += x - p[(i - 1) * 2]; dy += y - p[(i - 1) * 2 + 1]; }
    if (i < n - 1) { dx += p[(i + 1) * 2] - x; dy += p[(i + 1) * 2 + 1] - y; }
    const len = Math.hypot(dx, dy) || 1;
    out.push(x + (-dy / len) * off, y + (dx / len) * off);
  }
  return out;
}

/** cheap deterministic hash -> [0,1) */
function hash01(a: number, b: number) {
  let h = (a * 374761393 + b * 668265263) ^ ((a << 13) | 0);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return ((h >>> 0) % 10000) / 10000;
}

/** true for a ground layer that belongs to a bridge deck (drawn in `drawBridges`, not `drawGround`) */
function isBridgeLayer(key: string): boolean {
  return key.startsWith('bc:') || key.startsWith('br:') || key.startsWith('f1:') || key.startsWith('m1') || key.startsWith('edge1') || key.startsWith('kerb1');
}

function signedArea(p: ArrayLike<number>): number {
  let a = 0;
  const n = p.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return a / 2;
}

/** World-space rect actually covered by the canvas under its current transform (so it
 *  includes camera shake and dpr, unlike `View`), for culling draws that would land
 *  entirely off-canvas. Null if the transform isn't a plain scale+translate. */
function screenRect(ctx: CanvasRenderingContext2D): BBox | null {
  const m = ctx.getTransform();
  if (m.b !== 0 || m.c !== 0 || m.a <= 0 || m.d <= 0) return null;
  const x0 = -m.e / m.a, y0 = -m.f / m.d;
  return { x0, y0, x1: x0 + ctx.canvas.width / m.a, y1: y0 + ctx.canvas.height / m.d };
}

/** does `b` (grown by `pad` metres) overlap the screen rect? (always true without one) */
function onRect(sr: BBox | null, x0: number, y0: number, x1: number, y1: number, pad: number) {
  return !sr || (x1 + pad > sr.x0 && x0 - pad < sr.x1 && y1 + pad > sr.y0 && y0 - pad < sr.y1);
}

/** slack for group culling: strokes, chimney shadows, and shop sign boards that can be
 *  wider than the wall edge they hang on */
const GROUP_CULL_PAD = 6;

export class Renderer {
  private chunks: Chunk[] = [];
  private layers = new Map<string, Layer>();
  ads: { b: Building; ad: (typeof ROOF_ADS)[number]; chunk: Chunk; h: number; angle: number; w: number; len: number }[] = [];
  /** bridge deck polylines, for the cast shadow + railings drawn by `drawBridges` */
  private bridges: { p: Float32Array; hw: number; bbox: BBox }[] = [];
  private treeCount = 0;
  private sunKeyLast = NaN;
  /** merged ground-shadow path of the last frame, reused while the visible chunk set
   *  and every group's shadow stay the same (the common case: panning within a chunk) */
  private shadowMerged: Path2D | null = null;
  private shadowVisKey = '';
  /** layer draw order, sorted once (layers are fixed after build) */
  private sortedLayers: [string, Layer][] = [];
  private sortedBridgeLayers: [string, Layer][] = [];
  /** hard per-frame cap on facade edges drawn, so a dense Old Town view can't blow the frame budget */
  private facadeBudget = 0;

  /** set by Game after construction; read for sun direction, night and rain */
  atmos = new Atmosphere();
  /** textured facades (windows, doors, shopfronts); off on the lowest quality tier, where they cost most */
  facades = true;

  constructor(private world: World) {
    this.build();
    this.sortedLayers = [...this.layers.entries()].sort((a, b) => a[1].order - b[1].order);
    this.sortedBridgeLayers = this.sortedLayers.filter(([k]) => isBridgeLayer(k));
  }

  private chunkAt(bbox: BBox, map: Map<number, Chunk>) {
    const cx = Math.floor((bbox.x0 + bbox.x1) / 2 / CHUNK);
    const cy = Math.floor((bbox.y0 + bbox.y1) / 2 / CHUNK);
    const k = (cx + 500) * 1000 + cy + 500;
    let c = map.get(k);
    if (!c) {
      c = {
        idx: this.chunks.length,
        bbox: { x0: cx * CHUNK, y0: cy * CHUNK, x1: (cx + 1) * CHUNK, y1: (cy + 1) * CHUNK },
        cx: (cx + 0.5) * CHUNK,
        cy: (cy + 0.5) * CHUNK,
        layers: new Map(),
        bgroups: [],
      };
      map.set(k, c);
      this.chunks.push(c);
    }
    c.bbox.x0 = Math.min(c.bbox.x0, bbox.x0);
    c.bbox.y0 = Math.min(c.bbox.y0, bbox.y0);
    c.bbox.x1 = Math.max(c.bbox.x1, bbox.x1);
    c.bbox.y1 = Math.max(c.bbox.y1, bbox.y1);
    return c;
  }

  private path(chunk: Chunk, key: string, op: DrawOp, order: number) {
    if (!this.layers.has(key)) this.layers.set(key, { op, order });
    let p = chunk.layers.get(key);
    if (!p) chunk.layers.set(key, (p = new Path2D()));
    return p;
  }

  private build() {
    const w = this.world;
    const map = new Map<number, Chunk>();
    const addPoly = (p: Path2D, flat: ArrayLike<number>, close: boolean) => {
      p.moveTo(flat[0], flat[1]);
      for (let i = 2; i < flat.length; i += 2) p.lineTo(flat[i], flat[i + 1]);
      if (close) p.closePath();
    };

    // areas (+ a textured overlay for the ones that benefit from it)
    AREA_ORDER.forEach((kind, i) => {
      const tex = AREA_TEX[kind];
      for (const rings of w.data.areas[kind as keyof typeof w.data.areas]) {
        const c = this.chunkAt(bboxOf(rings[0]), map);
        const col = AREA_COLORS[kind];
        const p = this.path(c, 'a:' + kind, { kind: 'fill', color: col, tex: tex && texture(tex, col) }, i);
        for (const r of rings) addPoly(p, r, true);
        if (kind === 'water') {
          const edge = this.path(c, 'a:water:edge', { kind: 'stroke', color: 'rgba(220,240,255,0.35)', width: 0.5 }, i + 0.6);
          for (const r of rings) addPoly(edge, r, true);
        }
      }
    });

    // roads: casing, asphalt/cobble fill + grain overlay
    for (const r of w.data.roads) {
      const bridge = r.b ? 1 : 0;
      const wq = Math.round(r.w * 2) / 2;
      const base = 100 + bridge * 100;
      const c = this.chunkAt(bboxOf(r.p, r.w), map);
      if (bridge) {
        addPoly(this.path(c, `bc:${wq}`, { kind: 'stroke', color: '#2b2b2e', width: wq + 3 }, base + 1), r.p, false);
        addPoly(this.path(c, `br:${wq}`, { kind: 'stroke', color: '#8f8b84', width: wq + 1.6 }, base + 2), r.p, false);
        this.bridges.push({ p: Float32Array.from(r.p), hw: r.w / 2, bbox: bboxOf(r.p, r.w / 2 + 1) });
      } else if (ROAD_CASING[r.c]) {
        addPoly(this.path(c, `c:${r.c}:${wq}`, { kind: 'stroke', color: ROAD_CASING[r.c], width: wq + 1.6 }, base + 10 - r.c * 0.1), r.p, false);
      }
      const fill = ROAD_FILL[r.c];
      const tex = texture(r.c >= 8 ? 'cobble' : 'asphalt', fill);
      addPoly(this.path(c, `f${bridge}:${r.c}:${wq}`, { kind: 'stroke', color: fill, width: wq, tex }, base + 30 - r.c * 0.1), r.p, false);
      if (r.c <= 5 && r.w >= 7) {
        const key = r.o ? `m${bridge}:lane` : `m${bridge}:center`;
        addPoly(
          this.path(c, key, { kind: 'stroke', color: r.o ? 'rgba(255,255,255,0.55)' : '#e8e2c8', width: 0.18, dash: [3, 5] }, base + 50),
          r.p,
          false,
        );
      }
      if (r.c <= 3 && r.w >= 9) {
        addPoly(this.path(c, `edge${bridge}`, { kind: 'stroke', color: 'rgba(240,236,220,0.7)', width: 0.14 }, base + 51), offsetPolyline(r.p, r.w / 2 - 0.4), false);
        addPoly(this.path(c, `edge${bridge}`, { kind: 'stroke', color: 'rgba(240,236,220,0.7)', width: 0.14 }, base + 51), offsetPolyline(r.p, -r.w / 2 + 0.4), false);
        // kerb bevel: a darker line just outside the light edge line, so the road
        // reads as raised/cambered at close zoom instead of a flat colour change
        addPoly(this.path(c, `kerb${bridge}`, { kind: 'stroke', color: 'rgba(30,28,24,0.35)', width: 0.16 }, base + 50.5), offsetPolyline(r.p, r.w / 2 - 0.62), false);
        addPoly(this.path(c, `kerb${bridge}`, { kind: 'stroke', color: 'rgba(30,28,24,0.35)', width: 0.16 }, base + 50.5), offsetPolyline(r.p, -r.w / 2 + 0.62), false);
      }
      // manholes and puddles scattered deterministically along paved car roads
      if (!bridge && r.c <= 5 && r.w >= 7) {
        walkPolyline(r.p, 19, hash01(r.p[0] | 0, r.p[1] | 0) * 19, (x, y, nx, ny) => {
          const hs = hash01((x * 37) | 0, (y * 53) | 0);
          if (hs < 0.14) {
            const off = (hash01((x * 11) | 0, (y * 17) | 0) - 0.5) * (r.w - 2);
            const mx = x + nx * off, my = y + ny * off;
            const mc = this.chunkAt({ x0: mx, y0: my, x1: mx, y1: my }, map);
            const mp = (mc.manholePath ??= new Path2D());
            mp.moveTo(mx + 0.32, my);
            mp.arc(mx, my, 0.32, 0, Math.PI * 2);
          } else if (hs < 0.22) {
            const off = (hash01((x * 19) | 0, (y * 23) | 0) - 0.5) * (r.w - 3);
            const px_ = x + nx * off, py_ = y + ny * off;
            const pc = this.chunkAt({ x0: px_, y0: py_, x1: px_, y1: py_ }, map);
            const pp = (pc.puddlePath ??= new Path2D());
            const rw = 0.9 + hash01((x * 29) | 0, (y * 31) | 0) * 1.6;
            const angle = Math.atan2(-nx, ny) + hash01((x * 41) | 0, (y * 43) | 0) * 0.6; // roughly road-aligned
            pp.moveTo(px_ + rw, py_);
            pp.ellipse(px_, py_, rw, rw * 0.55, angle, 0, Math.PI * 2);
          }
        });
      }
    }

    // zebra crossings: where >=3 car roads of class <=5 meet
    {
      const deg = new Map<number, number>();
      for (const e of w.car.edges) {
        if (e.cls > 5) continue;
        deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
        deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
      }
      for (const e of w.car.edges) {
        if (e.cls > 5) continue;
        const len = e.len;
        const hw = e.width / 2;
        if (e.width > 18) continue;
        const chw = Math.min(hw, 6.5);
        const place = (fromStart: boolean) => {
          const dist = fromStart ? Math.min(len, 4.5) : Math.max(0, len - 4.5);
          const { x, y, dx, dy } = pointAlong(e.p, dist);
          const nx = -dy, ny = dx;
          const c = this.chunkAt({ x0: x - chw, y0: y - chw, x1: x + chw, y1: y + chw }, map);
          const stripe = this.path(c, 'z:cross', { kind: 'stroke', color: 'rgba(233,230,218,0.85)', width: 0.55, dash: [0.55, 0.45] }, 260);
          stripe.moveTo(x - nx * chw * 0.9, y - ny * chw * 0.9);
          stripe.lineTo(x + nx * chw * 0.9, y + ny * chw * 0.9);
        };
        if ((deg.get(e.a) ?? 0) >= 3) place(true);
        if ((deg.get(e.b) ?? 0) >= 3) place(false);
      }
    }

    // tram tracks: ballast bed + two thin steel rails at ~1.435m gauge
    for (const t of w.data.trams) {
      const c = this.chunkAt(bboxOf(t, 2), map);
      addPoly(this.path(c, 't:bed', { kind: 'stroke', color: '#65615a', width: 1.7 }, 260), t, false);
      addPoly(this.path(c, 't:railL', { kind: 'stroke', color: '#232326', width: 0.14 }, 261), offsetPolyline(t, 0.72), false);
      addPoly(this.path(c, 't:railR', { kind: 'stroke', color: '#232326', width: 0.14 }, 261), offsetPolyline(t, -0.72), false);
      addPoly(this.path(c, 't:wire', { kind: 'stroke', color: 'rgba(20,20,20,0.3)', width: 0.06 }, 262), t, false);
    }

    // street lamps every ~28m along car roads (class <=6), one side of the road
    for (const r of w.data.roads) {
      if (r.c > 6) continue;
      walkPolyline(r.p, 28, hash01(r.p[0] | 0, r.p[1] | 0) * 20, (x, y, nx, ny) => {
        const off = r.w / 2 + 0.8;
        const lx = x + nx * off, ly = y + ny * off;
        const c = this.chunkAt({ x0: lx, y0: ly, x1: lx, y1: ly }, map);
        (c.lamps ??= []).push(lx, ly);
        const lp = (c.lampPath ??= new Path2D());
        lp.moveTo(lx + 0.45, ly);
        lp.arc(lx, ly, 0.45, 0, Math.PI * 2);
        lp.moveTo(lx + 0.12, ly);
        lp.arc(lx, ly, 0.12, 0, Math.PI * 2);
      });
    }

    // trees: scattered through wood/green polygons, plus rows along major roads
    const addTree = (x: number, y: number, seed: number) => {
      if (this.treeCount >= 6000) return;
      if (w.insideBuilding(x, y)) return;
      const c = this.chunkAt({ x0: x, y0: y, x1: x, y1: y }, map);
      const t = (c.trees ??= { shadow: new Path2D(), canopy: [new Path2D(), new Path2D(), new Path2D(), new Path2D()], highlight: new Path2D() });
      const r = rng(seed);
      const rad = 2 + r() * 2.5;
      const tone = (r() * 4) | 0;
      t.shadow.moveTo(x + rad * 0.9, y + rad * 0.4);
      t.shadow.arc(x + rad * 0.15, y + rad * 0.3, rad * 0.85, 0, Math.PI * 2);
      const cp = t.canopy[tone];
      cp.moveTo(x + rad, y);
      cp.arc(x, y, rad, 0, Math.PI * 2);
      cp.moveTo(x + rad * 0.35 + rad * 0.7, y - rad * 0.25);
      cp.arc(x + rad * 0.35, y - rad * 0.25, rad * 0.68, 0, Math.PI * 2);
      t.highlight.moveTo(x + rad * 0.4, y - rad * 0.35);
      t.highlight.arc(x, y - rad * 0.35, rad * 0.38, 0, Math.PI * 2);
      this.treeCount++;
    };
    const scatterArea = (kind: 'wood' | 'green', perM2: number, maxPer: number) => {
      for (const rings of w.data.areas[kind]) {
        const bb = bboxOf(rings[0]);
        const area = ringArea(rings[0]);
        const n = Math.min(maxPer, Math.round(area / perM2));
        const r = rng(((bb.x0 * 131) ^ (bb.y0 * 977) ^ (n * 17)) | 0);
        let placed = 0, tries = 0;
        while (placed < n && tries < n * 6 && this.treeCount < 6000) {
          tries++;
          const x = bb.x0 + r() * (bb.x1 - bb.x0);
          const y = bb.y0 + r() * (bb.y1 - bb.y0);
          if (!pointInRings(x, y, rings)) continue;
          addTree(x, y, (x * 7349 + y * 613 + tries * 97) | 0);
          placed++;
        }
      }
    };
    scatterArea('wood', 85, 500);
    scatterArea('green', 260, 220);
    for (const r of w.data.roads) {
      if (r.c > 4 || r.b || this.treeCount >= 6000) continue;
      const side = hash01(r.p[0] | 0, r.p[1] | 0) < 0.5 ? 1 : -1;
      walkPolyline(r.p, 15, hash01(r.p[1] | 0, r.p[0] | 0) * 15, (x, y, nx, ny) => {
        const off = r.w / 2 + 1.5;
        addTree(x + nx * off * side, y + ny * off * side, (x * 331 + y * 971) | 0);
      });
    }

    // buildings grouped by chunk, height bin and colour
    const groups = new Map<Chunk, Map<string, BGroup>>();
    const buildingGroup = new Map<Building, BGroup>();
    const oldTownAt = w.landmark('main');
    for (const b of w.buildings) {
      const c = this.chunkAt(b.bbox, map);
      const r = rng(b.seed * 7919);
      const bin = b.kind === 4 ? 0.6 : Math.min(14, Math.round(b.levels));
      let wall = OLD_WALLS[(r() * OLD_WALLS.length) | 0], roof = ROOFS[(r() * ROOFS.length) | 0], flat = false;
      if (b.kind === 3 || (b.area > 2500 && b.levels >= 4)) (wall = '#767b82'), (roof = FLAT_ROOFS[(r() * FLAT_ROOFS.length) | 0]), (flat = true);
      if (b.levels >= 8) (wall = '#6c7179'), (roof = FLAT_ROOFS[(r() * FLAT_ROOFS.length) | 0]), (flat = true);
      if (b.kind === 1) (wall = '#cfc6b4'), (roof = r() < 0.6 ? '#5c8a73' : '#8c4a36');
      if (b.kind === 2) (wall = '#e9e3d6'), (roof = '#b8553a');
      if (b.kind === 4) (wall = 'rgba(80,80,80,0.5)'), (roof = 'rgba(150,150,150,0.55)');
      if (b.color) (roof = b.color), (wall = b.wallColor ?? wall);

      // facade style: churches/castles are always baroque-ish; otherwise by height,
      // then Old Town proximity, then a coin flip between panel and office/industrial
      let facade: FacadeStyle | undefined;
      if (b.kind !== 4) {
        if (b.kind === 1 || b.kind === 2) facade = 'oldtown';
        else if (bin >= 8) facade = hash01(b.seed, 1) < 0.55 ? 'panel' : 'office';
        else if (Math.hypot(b.cx - oldTownAt.x, b.cy - oldTownAt.y) < 450) facade = 'oldtown';
        else if (bin <= 2 && b.area > 700) facade = 'industrial';
        else facade = hash01(b.seed, 2) < 0.5 ? 'panel' : 'office';
      }

      const key = `${bin}|${wall}|${roof}|${facade ?? ''}`;
      let gm = groups.get(c);
      if (!gm) groups.set(c, (gm = new Map()));
      let g = gm.get(key);
      if (!g) {
        g = {
          h: bin * 3.2,
          bbox: { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
          wall,
          wallDark: darken(wall),
          wallShades: WALL_SHADE_LEVELS.map((f) => shade(wall, f)),
          roof,
          roofTex: roof.startsWith('#') && b.kind !== 4 ? texture(flat ? 'concrete' : 'roofTile', roof) : undefined,
          pitched: !flat && b.kind !== 4,
          path: new Path2D(),
          outline: new Path2D(),
          ridge: new Path2D(),
          roofDetail: new Path2D(),
          chimneys: new Path2D(),
          rings: [],
          levels: Math.max(1, bin),
          facade,
          signs: [],
          hasRidge: false,
          hasRoofDetail: false,
          hasChimneys: false,
        };
        gm.set(key, g);
        c.bgroups.push(g);
      }
      buildingGroup.set(b, g);
      // every ring, not `b.bbox`: that only covers rings[0], and multipolygon
      // buildings have further outer rings well outside it
      for (const ring of b.rings) bboxOf(ring, 0, g.bbox);
      // pick a shopfront edge (longest, near a named street) for commercial-ish buildings
      let shopEdge = -1;
      if (facade && b.rings.length === 1 && b.area > 30 && (b.kind === 3 || (facade === 'oldtown' && hash01(b.seed, 9) < 0.35))) {
        const ring = b.rings[0];
        let best = 0, bestK = -1;
        for (let k = 0; k < ring.length - 2; k += 2) {
          const l = Math.hypot(ring[k + 2] - ring[k], ring[k + 3] - ring[k + 1]);
          if (l > best) (best = l), (bestK = k);
        }
        if (bestK >= 0) {
          const mx = (ring[bestK] + ring[bestK + 2]) / 2, my = (ring[bestK + 1] + ring[bestK + 3]) / 2;
          if (w.streetName(mx, my) !== null) shopEdge = bestK;
        }
        // Old Town shopfronts without a named POI get a generic label (Potraviny, Bar, ...)
        if (shopEdge >= 0 && facade === 'oldtown' && hash01(b.seed, 12) < 0.5) {
          const mx = (ring[shopEdge] + ring[shopEdge + 2]) / 2, my = (ring[shopEdge + 1] + ring[shopEdge + 3]) / 2;
          const nearPoi = w.data.pois.some((p) => p.k === 'shop' && Math.hypot(p.x - mx, p.y - my) < 15);
          if (!nearPoi) {
            const elen = Math.hypot(ring[shopEdge + 2] - ring[shopEdge], ring[shopEdge + 3] - ring[shopEdge + 1]) || 1;
            const [name, bg, fg] = GENERIC_SIGNS[(hash01(b.seed, 13) * GENERIC_SIGNS.length) | 0];
            g.signs.push({
              ax: ring[shopEdge], ay: ring[shopEdge + 1],
              ux: (ring[shopEdge + 2] - ring[shopEdge]) / elen, uy: (ring[shopEdge + 3] - ring[shopEdge + 1]) / elen,
              u0: elen / 2, name, colors: [bg, fg],
            });
          }
        }
      }
      for (const ring of b.rings) {
        addPoly(g.path, ring, true);
        const sign = signedArea(ring) >= 0 ? 1 : -1;
        g.rings.push({ pts: ring, sign, shopEdge: ring === b.rings[0] ? shopEdge : -1, edges: edgeData(ring, sign) });
      }
      addPoly(g.outline, b.rings[0], true);

      // roof ridge (pitched) or rooftop details (large flat roofs)
      if (b.kind !== 4 && b.rings.length === 1 && b.area > 40) {
        if (!flat) {
          const ring = b.rings[0];
          let best = 0, angle = 0;
          for (let k = 0; k < ring.length - 2; k += 2) {
            const l = Math.hypot(ring[k + 2] - ring[k], ring[k + 3] - ring[k + 1]);
            if (l > best) (best = l), (angle = Math.atan2(ring[k + 3] - ring[k + 1], ring[k + 2] - ring[k]));
          }
          const len = Math.min(best, Math.sqrt(b.area)) * 0.42;
          g.hasRidge = true;
          g.ridge.moveTo(b.cx - Math.cos(angle) * len, b.cy - Math.sin(angle) * len);
          g.ridge.lineTo(b.cx + Math.cos(angle) * len, b.cy + Math.sin(angle) * len);
          // chimney(s) near the ridge ends, offset off-centre so they read as boxes, not the ridge itself
          if (b.area > 70) {
            const nx = -Math.sin(angle), ny = Math.cos(angle);
            const cr = rng(b.seed * 331 + 5);
            const n = 1 + (cr() < 0.4 ? 1 : 0);
            for (let k = 0; k < n; k++) {
              const t = (cr() - 0.5) * len * 1.1;
              const s = 0.7 + cr() * 0.4;
              const px = b.cx + Math.cos(angle) * t + nx * len * 0.18, py = b.cy + Math.sin(angle) * t + ny * len * 0.18;
              g.chimneys.rect(px - s / 2, py - s / 2, s, s * 1.6);
              g.hasChimneys = true;
            }
          }
        } else if (b.area > 600) {
          const rr = rng(b.seed * 131 + 7);
          const n = 1 + ((rr() * 3) | 0);
          const bw = b.bbox.x1 - b.bbox.x0, bh = b.bbox.y1 - b.bbox.y0;
          for (let k = 0; k < n; k++) {
            const dw = Math.min(bw, bh) * (0.08 + rr() * 0.07);
            const dx = b.bbox.x0 + bw * (0.2 + rr() * 0.6), dy = b.bbox.y0 + bh * (0.2 + rr() * 0.6);
            if (!pointInRings(dx, dy, b.rings)) continue;
            g.roofDetail.rect(dx - dw / 2, dy - dw / 2, dw, dw);
            g.hasRoofDetail = true;
          }
        }
      }
    }
    for (const c of this.chunks) c.bgroups.sort((a, b) => a.h - b.h);

    // rooftop advertising on the biggest flat roofs (like GTA 2)
    const candidates = w.buildings
      .filter((b) => b.kind !== 1 && b.kind !== 2 && b.kind !== 4 && b.area > 900 && b.rings.length === 1)
      .sort((a, b) => b.area - a.area)
      .slice(0, 60);
    const rnd = rng(42);
    candidates.forEach((b, i) => {
      if (rnd() < 0.35) return;
      // orientation from the longest edge
      const ring = b.rings[0];
      let best = 0, angle = 0;
      for (let k = 0; k < ring.length - 2; k += 2) {
        const l = Math.hypot(ring[k + 2] - ring[k], ring[k + 3] - ring[k + 1]);
        if (l > best) (best = l), (angle = Math.atan2(ring[k + 3] - ring[k + 1], ring[k + 2] - ring[k]));
      }
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      const chunk = this.chunkAt(b.bbox, map);
      const len = Math.min(best * 0.7, Math.sqrt(b.area) * 1.1);
      this.ads.push({ b, ad: ROOF_ADS[i % ROOF_ADS.length], chunk, h: Math.min(14, Math.round(b.levels)) * 3.2, angle, w: len * 0.32, len });
    });

    // shop/fuel POI signs: projected onto the nearest building wall edge
    for (const p of w.data.pois) {
      if (p.k !== 'shop' && p.k !== 'fuel') continue;
      let bestD = 30 * 30, bestB: Building | null = null, bestK = -1;
      for (const b of w.buildings) {
        if (b.kind === 4 || p.x < b.bbox.x0 - 30 || p.x > b.bbox.x1 + 30 || p.y < b.bbox.y0 - 30 || p.y > b.bbox.y1 + 30) continue;
        const ring = b.rings[0];
        for (let k = 0; k < ring.length - 2; k += 2) {
          const ax = ring[k], ay = ring[k + 1], dx = ring[k + 2] - ax, dy = ring[k + 3] - ay;
          const l2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / l2));
          const d = (ax + dx * t - p.x) ** 2 + (ay + dy * t - p.y) ** 2;
          if (d < bestD) (bestD = d), (bestB = b), (bestK = k);
        }
      }
      if (!bestB || bestK < 0) continue;
      const g = buildingGroup.get(bestB);
      if (!g) continue;
      const ring = bestB.rings[0];
      const ax = ring[bestK], ay = ring[bestK + 1];
      const elen = Math.hypot(ring[bestK + 2] - ax, ring[bestK + 3] - ay) || 1;
      g.signs.push({
        ax, ay, ux: (ring[bestK + 2] - ax) / elen, uy: (ring[bestK + 3] - ay) / elen,
        u0: elen / 2, name: p.k === 'fuel' ? `⛽ ${p.n}` : p.n, colors: BRAND_COLORS[p.n],
      });
    }
  }

  roofOffset(x: number, y: number, h: number, v: View): [number, number] {
    const hh = Math.min(h, v.camH * 0.6);
    const k = hh / (v.camH - hh);
    return [(x - v.camX) * k, (y - v.camY) * k];
  }

  drawGround(ctx: CanvasRenderingContext2D, v: View, detail = true) {
    if (detail) animateWater(performance.now());
    const vis = this.chunks.filter((c) => bboxHit(c.bbox, v));
    const keys = this.sortedLayers;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const wantTex = detail && v.scale > 7.5; // patterns alias when scaled down further
    for (const [key, layer] of keys) {
      if (isBridgeLayer(key)) continue; // drawn in drawBridges, after entities below the deck
      if (!detail && (key.startsWith('m') || key.startsWith('t:wire') || key.startsWith('z:'))) continue;
      const op = layer.op;
      const col = wantTex && op.tex ? op.tex : op.color;
      if (op.kind === 'fill') ctx.fillStyle = col;
      else {
        ctx.strokeStyle = col;
        ctx.lineWidth = op.width;
        ctx.setLineDash(op.dash ?? []);
      }
      for (const c of vis) {
        const p = c.layers.get(key);
        if (!p) continue;
        if (op.kind === 'fill') ctx.fill(p, 'evenodd');
        else ctx.stroke(p);
      }
    }
    ctx.setLineDash([]);

    // wet roads: cheap translucent overlay reusing the same fill geometry
    const wet = this.atmos.wet;
    if (detail && wet > 0.02) {
      ctx.fillStyle = `rgba(8,12,24,${Math.min(0.4, wet * 0.35)})`;
      for (const [key] of keys) {
        if (!key.startsWith('f') || isBridgeLayer(key)) continue;
        for (const c of vis) {
          const p = c.layers.get(key);
          if (p) ctx.fill(p);
        }
      }
    }

    // manholes: small dark discs baked once per chunk, cheap enough to always draw close up
    if (wantTex) {
      ctx.fillStyle = 'rgba(35,33,30,0.55)';
      for (const c of vis) if (c.manholePath) ctx.fill(c.manholePath);
    }
    // puddles: baked shapes along roads, only shown once it's actually wet; reflect
    // the sky (lighter) by day, or a faint warm glint (from streetlights) by night
    if (detail && wet > 0.3) {
      const night = this.atmos.night;
      ctx.fillStyle = night > 0.3 ? `rgba(60,70,95,${Math.min(0.55, (wet - 0.3) * 0.8)})` : `rgba(200,215,225,${Math.min(0.4, (wet - 0.3) * 0.6)})`;
      for (const c of vis) if (c.puddlePath) ctx.fill(c.puddlePath);
      if (night > 0.3) {
        ctx.fillStyle = `rgba(255,210,150,${Math.min(0.3, (wet - 0.3) * (night - 0.3) * 1.2)})`;
        for (const c of vis) if (c.puddlePath) ctx.fill(c.puddlePath);
      }
    }

    if (detail) this.drawWaterFx(ctx, v, vis);
  }

  /** Shimmer, sun glints, shoreline foam and (at night) wobbly lamp reflections on water. */
  private drawWaterFx(ctx: CanvasRenderingContext2D, v: View, vis: Chunk[]) {
    const waterVis = vis.filter((c) => c.layers.has('a:water'));
    if (!waterVis.length) return;
    const night = this.atmos.night;
    const t = performance.now() / 1000;

    // second ripple layer, drifting at its own speed/angle for a shimmering surface
    if (v.scale > 4) {
      ctx.fillStyle = texture('waterShimmer', 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.55;
      for (const c of waterVis) ctx.fill(c.layers.get('a:water')!, 'evenodd');
      ctx.globalAlpha = 1;
    }

    // shoreline foam: an animated dashed line lapping along the water's edge
    if (v.scale > 4) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 0.3;
      ctx.setLineDash([1, 1.6]);
      ctx.lineDashOffset = -(t * 0.6) % 2.6;
      for (const c of waterVis) {
        const e = c.layers.get('a:water:edge');
        if (e) ctx.stroke(e);
      }
      ctx.restore();
    }

    if (night < 0.35) {
      // sun glints: small bright sparkles aligned with the sun direction, twinkling
      const sunDir = this.atmos.sunDir;
      const angle = Math.atan2(sunDir.y, sunDir.x);
      ctx.fillStyle = 'rgba(255,252,225,0.9)';
      for (const c of waterVis) {
        const p = c.layers.get('a:water')!;
        ctx.save();
        ctx.clip(p, 'evenodd');
        for (let i = 0; i < 6; i++) {
          const hx = hash01((c.cx * 13 + i * 977) | 0, (c.cy * 7) | 0), hy = hash01((c.cy * 11 + i * 613) | 0, (c.cx * 5) | 0);
          const gx = c.bbox.x0 + hx * (c.bbox.x1 - c.bbox.x0), gy = c.bbox.y0 + hy * (c.bbox.y1 - c.bbox.y0);
          const twinkle = 0.5 + 0.5 * Math.sin(t * 3.2 + i * 11 + hx * 40);
          if (twinkle < 0.35) continue;
          ctx.globalAlpha = (twinkle - 0.35) * 1.1 * (1 - night * 2.5);
          const s = 0.25 + hx * 0.35;
          ctx.beginPath();
          ctx.ellipse(gx, gy, s, s * 0.35, angle, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    } else {
      // night: wobbly vertical reflections of nearby streetlamps/city lights on the water.
      // lamps and water polygons don't share chunks often, so search a margin around
      // each water chunk rather than just its own lamp list.
      const margin = 30;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const wc of waterVis) {
        const x0 = wc.bbox.x0 - margin, y0 = wc.bbox.y0 - margin, x1 = wc.bbox.x1 + margin, y1 = wc.bbox.y1 + margin;
        for (const c of vis) {
          if (!c.lamps || c.bbox.x1 < x0 || c.bbox.x0 > x1 || c.bbox.y1 < y0 || c.bbox.y0 > y1) continue;
          for (let i = 0; i < c.lamps.length; i += 2) {
            const lx = c.lamps[i], ly = c.lamps[i + 1];
            if (lx < x0 || lx > x1 || ly < y0 || ly > y1) continue;
            const wob = Math.sin(t * 1.4 + lx * 0.4) * 0.5;
            const grad = ctx.createLinearGradient(lx, ly, lx + wob, ly + 8);
            grad.addColorStop(0, `rgba(255,214,150,${0.4 * night})`);
            grad.addColorStop(1, 'rgba(255,214,150,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(lx - 0.35, ly, 0.7, 8);
          }
        }
      }
      ctx.restore();
    }
  }

  /** Fake-3D buildings: walls are extruded from the footprint towards the shifted roof. */
  drawBuildings(ctx: CanvasRenderingContext2D, v: View) {
    const vis = this.chunks.filter((c) => bboxHit(c.bbox, { x0: v.x0 - 60, y0: v.y0 - 60, x1: v.x1 + 60, y1: v.y1 + 60 }));
    // `vis` is padded generously so tall roofs leaning in from off-screen chunks are
    // kept; everything below is additionally culled against the true canvas rect,
    // which skips the (many) groups/edges of those chunks that still land off-screen
    const sr = screenRect(ctx);

    // trees are registered by their trunk point: canopies reach ~5m past it, and the
    // shadow is shifted by up to 6 * |sun| (~17m at low sun) on top of that
    this.drawTrees(ctx, v, vis.filter((c) => c.trees && onRect(sr, c.bbox.x0, c.bbox.y0, c.bbox.x1, c.bbox.y1, 24)));

    // lamp posts (cheap, always drawn - dark by day, glow comes from emitLights at night)
    ctx.fillStyle = '#2c2c2e';
    for (const c of vis) if (c.lampPath && onRect(sr, c.bbox.x0, c.bbox.y0, c.bbox.x1, c.bbox.y1, 1)) ctx.fill(c.lampPath);

    // draw far chunks first so nearer tall roofs overlap them
    vis.sort((a, b) => Math.hypot(b.cx - v.camX, b.cy - v.camY) - Math.hypot(a.cx - v.camX, a.cy - v.camY));
    ctx.lineJoin = 'miter';
    const sunDir = this.atmos.sunDir;
    // cheap storey-lines/lit-dash fallback while zoomed out (e.g. driving) - lowered
    // so moderate-speed driving still reads as a lit-up city, not flat slabs
    const wantWindows = v.scale > 3;
    const night = this.atmos.night;
    // any wall on screen gets real facade patterns (windows/doors/shopfronts) once
    // zoomed in enough to read them - no distance-from-camera cap, so a big building
    // like Eurovea gets windows on the part of it that's actually on screen, not just
    // near-camera chunks. Eligibility instead requires the chunk to actually intersect
    // the true viewport `v` (not `vis`'s 60m-padded rect) - otherwise buildings just
    // outside the frame would compete for the pixel budget below and starve the ones
    // actually visible, since `vis` is sorted far-to-near and budget is spent in that
    // order. Cost is further bounded per-edge (tiny projected edges stay flat).
    const facadeReady = this.facades && v.scale > 6;
    this.facadeBudget = 200000; // px of on-screen wall-edge width, this frame
    // one save/restore around the whole pass (state leaks out of it exactly as before);
    // per group, the roof/chimney offsets are set as absolute transforms from `base`
    // rather than a save/translate/restore per group (a full canvas-state clone each)
    ctx.save();
    const base = ctx.getTransform();
    const A = base.a, B = base.b, C = base.c, D = base.d, E = base.e, F = base.f;
    const at = (x: number, y: number) => ctx.setTransform(A, B, C, D, A * x + C * y + E, B * x + D * y + F);
    for (const c of vis) {
      const chunkOnScreen = bboxHit(c.bbox, v);
      for (const g of c.bgroups) {
        const [ox, oy] = this.roofOffset(c.cx, c.cy, g.h, v);
        // everything this group draws lies between its footprints and their roof-shifted copy
        const bb = g.bbox;
        if (!onRect(sr, Math.min(bb.x0, bb.x0 + ox), Math.min(bb.y0, bb.y0 + oy), Math.max(bb.x1, bb.x1 + ox), Math.max(bb.y1, bb.y1 + oy), GROUP_CULL_PAD)) continue;
        const px = Math.hypot(ox, oy) * v.scale;
        const useFacade = facadeReady && g.facade && px > 10 && chunkOnScreen && this.facadeBudget > 0;
        if (px > 0.6) {
          // wall-quad geometry only needs rebuilding when the (quantised) roof
          // offset actually changes - camera pans/zooms shift it every frame in
          // theory, but the quantisation lets a mostly-still camera reuse it
          const qkey = `${Math.round(ox * 20)}|${Math.round(oy * 20)}`;
          let buckets: Path2D[], used: boolean[];
          if (g.bucketCache && g.bucketCache.key === qkey) ({ buckets, used } = g.bucketCache);
          else {
            // extruded walls: one quad per footprint edge, wound consistently so
            // a single nonzero fill covers them; edges are bucketed into 4 Lambert tones
            buckets = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
            used = [false, false, false, false];
            for (const rr of g.rings) {
              const pts = rr.pts;
              for (let i = 0; i < pts.length - 2; i += 2) {
                const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
                const ex = bx - ax, ey = by - ay;
                const elen = Math.hypot(ex, ey) || 1;
                let nx = ey / elen, ny = -ex / elen;
                if (rr.sign < 0) (nx = -nx), (ny = -ny);
                const lambert = Math.max(0, nx * sunDir.x + ny * sunDir.y);
                const tone = Math.min(3, (lambert * 3.4) | 0);
                const p = buckets[tone];
                used[tone] = true;
                if (ex * oy - ey * ox >= 0) {
                  p.moveTo(ax, ay);
                  p.lineTo(bx, by);
                  p.lineTo(bx + ox, by + oy);
                  p.lineTo(ax + ox, ay + oy);
                } else {
                  p.moveTo(ax, ay);
                  p.lineTo(ax + ox, ay + oy);
                  p.lineTo(bx + ox, by + oy);
                  p.lineTo(bx, by);
                }
                p.closePath();
              }
            }
            g.bucketCache = { key: qkey, buckets, used };
          }
          for (let k = 0; k < 4; k++) {
            if (!used[k]) continue;
            ctx.fillStyle = g.wallShades[k];
            ctx.fill(buckets[k]);
          }
          if (useFacade) {
            this.drawFacade(ctx, g, ox, oy, night, v.scale, sr);
          } else if (wantWindows && px > 10 && g.levels >= 2) {
            // storey lines (and lit windows at night): the cached footprint outline
            // translated part-way up the wall; the roof drawn next hides the parts
            // that fall on the far side of the building
            const rows = Math.min(g.levels, 5);
            ctx.save();
            ctx.strokeStyle = 'rgba(30,26,22,0.16)';
            ctx.lineWidth = 0.12;
            let px0 = 0, py0 = 0;
            for (let k = 1; k < rows; k++) {
              const t = k / rows;
              ctx.translate(ox * t - px0, oy * t - py0);
              (px0 = ox * t), (py0 = oy * t);
              ctx.stroke(g.outline);
            }
            ctx.restore();
            if (night > 0.3 && hash01((c.cx * 7 + g.h) | 0, (c.cy * 3) | 0) < 0.6) {
              ctx.save();
              ctx.lineCap = 'butt';
              ctx.strokeStyle = `rgba(255,214,140,${Math.min(0.85, (night - 0.3) * 1.5)})`;
              ctx.lineWidth = Math.min(0.55, Math.hypot(ox, oy) / rows * 0.35);
              ctx.setLineDash([0.9, 2.6]);
              ctx.lineDashOffset = hash01(c.cx | 0, c.cy | 0) * 3;
              px0 = 0; py0 = 0;
              for (let k = 0; k < rows; k++) {
                const t = (k + 0.5) / rows;
                ctx.translate(ox * t - px0, oy * t - py0);
                (px0 = ox * t), (py0 = oy * t);
                ctx.lineDashOffset += 1.3;
                ctx.stroke(g.outline);
              }
              ctx.restore();
            }
          }
          if (v.scale > 6 && g.signs.length) this.drawGroupSigns(ctx, g, ox, oy, v);
        }
        at(ox, oy);
        ctx.fillStyle = v.scale > 7.5 && g.roofTex ? g.roofTex : g.roof;
        ctx.fill(g.path, 'evenodd');
        if (v.scale > 5) {
          if (g.pitched) {
            if (g.hasRidge) {
              ctx.strokeStyle = 'rgba(255,235,215,0.22)';
              ctx.lineWidth = 0.22;
              ctx.stroke(g.ridge);
            }
            if (g.hasChimneys) {
              // chimney pots: shadow then brick-coloured box with a dark cap
              ctx.fillStyle = 'rgba(0,0,0,0.22)';
              at(ox + 0.15, oy + 0.2);
              ctx.fill(g.chimneys);
              at(ox, oy);
              ctx.fillStyle = '#6b5850';
              ctx.fill(g.chimneys);
            }
          } else {
            ctx.strokeStyle = 'rgba(255,255,255,0.22)';
            ctx.lineWidth = 0.4;
            ctx.stroke(g.outline);
            ctx.strokeStyle = 'rgba(0,0,0,0.12)';
            ctx.lineWidth = 0.16;
            ctx.stroke(g.outline);
            if (g.hasRoofDetail) {
              ctx.fillStyle = 'rgba(0,0,0,0.18)';
              at(ox + 0.25, oy + 0.3);
              ctx.fill(g.roofDetail);
              at(ox, oy);
              ctx.fillStyle = '#7d8084';
              ctx.fill(g.roofDetail);
            }
          }
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.28)';
        ctx.lineWidth = 0.35;
        ctx.stroke(g.outline);
        ctx.setTransform(base);
      }
    }
    ctx.restore();
    this.drawAds(ctx, v);
  }

  /** Small brand/shop sign boards, one wall-edge's worth of ground-floor band. Drawn
   *  inline in the building pass (between that group's walls and its roof) so nearer
   *  buildings drawn later still correctly overlap a farther one's sign, and so the
   *  sign sits on the wall face rather than floating over the roof. Only the storey
   *  a shop actually occupies (t in [0.5,0.85] of one level, up from the footprint
   *  edge) is used, and only when that edge is the one actually facing the camera. */
  private drawGroupSigns(ctx: CanvasRenderingContext2D, g: BGroup, ox: number, oy: number, v: View) {
    const invLevels = 1 / g.levels;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fs = 0.62;
    ctx.font = `800 ${fs}px system-ui, sans-serif`;
    for (const s of g.signs) {
      if (s.ax < v.x0 - 20 || s.ax > v.x1 + 20 || s.ay < v.y0 - 20 || s.ay > v.y1 + 20) continue;
      const ex = s.ux * s.u0 * 2, ey = s.uy * s.u0 * 2;
      // visibility uses a roof offset computed at the edge's own position, not the
      // group's chunk-centre one (ox,oy) - that coarser approximation can point the
      // "wrong" way for an edge far from the chunk centre and hide every sign
      const [eox, eoy] = this.roofOffset(s.ax + s.ux * s.u0, s.ay + s.uy * s.u0, g.h, v);
      if (ex * eoy - ey * eox < 0) continue; // edge faces away from the camera: not visible, skip
      const t = 0.55 + hash01((s.ax * 53) | 0, (s.ay * 97) | 0) * 0.3; // 0.55-0.85 up the ground floor
      const px = s.ax + s.ux * s.u0 + ox * invLevels * t, py = s.ay + s.uy * s.u0 + oy * invLevels * t;
      let angle = Math.atan2(s.uy, s.ux);
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(angle);
      const [bg, fg] = s.colors ?? ['#37474f', '#fff'];
      const w = ctx.measureText(s.name).width + fs * 1.1;
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.fillRect(-w / 2, -fs * 0.7, w, fs * 1.15);
      ctx.fillStyle = bg;
      ctx.fillRect(-w / 2, -fs * 0.78, w, fs * 1.15);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 0.04;
      ctx.strokeRect(-w / 2, -fs * 0.78, w, fs * 1.15);
      ctx.fillStyle = fg;
      ctx.fillText(s.name, 0, -fs * 0.2);
      ctx.restore();
    }
  }

  /** Windows, doors and shopfronts for one building group's walls, close up. One
   *  fillRect per edge: ctx.transform maps (u, level) -> world metres so a facade
   *  tile always lands as one bay per storey regardless of the edge's own angle. */
  private drawFacade(ctx: CanvasRenderingContext2D, g: BGroup, ox: number, oy: number, night: number, scale: number, sr: BBox | null) {
    const style = g.facade!;
    const lit = night > 0.3;
    const sunDir = this.atmos.sunDir;
    const invLevels = 1 / g.levels;
    // bake this group's 3 variants once (day/night) instead of hitting the Facades
    // pattern cache (string keys + Map.get) on every edge, every frame
    if (!g.facadeCache || g.facadeCache.lit !== lit) {
      const upper: CanvasPattern[] = [], door: CanvasPattern[] = [], shop: CanvasPattern[] = [];
      for (let variant = 0; variant < 3; variant++) {
        upper.push(facadeTexture(style, g.wall, variant, lit));
        door.push(groundTexture(style, g.wall, variant, lit, false));
        shop.push(groundTexture(style, g.wall, variant, lit, true));
      }
      g.facadeCache = { lit, upper, door, shop };
      if (lit && !g.glowCache) {
        const gu: (CanvasPattern | null)[] = [], gd: (CanvasPattern | null)[] = [], gs: (CanvasPattern | null)[] = [];
        for (let variant = 0; variant < 3; variant++) {
          gu.push(facadeGlow(style, g.wall, variant));
          gd.push(groundGlow(style, g.wall, variant, false));
          gs.push(groundGlow(style, g.wall, variant, true));
        }
        g.glowCache = { upper: gu, door: gd, shop: gs };
      }
    }
    const { upper, door, shop: shopTex } = g.facadeCache;
    // one base transform captured up front; each edge overwrites the CTM directly
    // (base * translate(a) * [u | o/levels], expanded by hand - no DOMMatrix garbage)
    // instead of save/restore (cheaper - no full canvas-state clone per edge)
    const base = ctx.getTransform();
    const A = base.a, B = base.b, C = base.c, D = base.d, E = base.e, F = base.f;
    const vx = ox * invLevels, vy = oy * invLevels;
    const va = A * vx + C * vy, vb = B * vx + D * vy;
    const upperH = g.levels - 1;
    let dirty = false;
    for (const rr of g.rings) {
      const pts = rr.pts, ed = rr.edges;
      for (let i = 0, o = 0; i < pts.length - 2; i += 2, o += EDGE_STRIDE) {
        const elen = ed[o];
        const epx = elen * scale;
        if (elen < 1.4 || epx < 4) continue;
        const ax = pts[i], ay = pts[i + 1];
        const ux = ed[o + 1], uy = ed[o + 2];
        // back-facing edges (far side of the footprint from the camera) never read on screen
        if (ux * oy - uy * ox < 0) continue;
        const bx = pts[i + 2], by = pts[i + 3];
        if (!onRect(sr, Math.min(ax, bx, ax + ox, bx + ox), Math.min(ay, by, ay + oy, by + oy), Math.max(ax, bx, ax + ox, bx + ox), Math.max(ay, by, ay + oy, by + oy), 0.5)) continue;
        const variant = ed[o + 5];
        const shop = i === rr.shopEdge;
        if ((this.facadeBudget -= epx) < 0) break; // pixel-width budget, not edge count
        ctx.setTransform(A * ux + C * uy, B * ux + D * uy, va, vb, A * ax + C * ay + E, B * ax + D * ay + F);
        dirty = true;
        if (upperH > 0) {
          ctx.fillStyle = upper[variant];
          ctx.fillRect(0, 1, elen, upperH);
        }
        ctx.fillStyle = shop ? shopTex[variant] : door[variant];
        ctx.fillRect(0, 0, elen, 1);
        // Lambert shading on top so the baked tile still reads sun direction (skip
        // the extra fillRect where it would barely register)
        const lambert = Math.max(0, ed[o + 3] * sunDir.x + ed[o + 4] * sunDir.y);
        const shadeAlpha = (0.5 - lambert) * 0.5;
        if (Math.abs(shadeAlpha) > 0.04) {
          ctx.fillStyle = shadeAlpha >= 0 ? SHADE_DARK[Math.round(shadeAlpha * 255)] : SHADE_LIGHT[Math.round(-shadeAlpha * 0.6 * 255)];
          ctx.fillRect(0, 0, elen, g.levels);
        }
      }
    }
    if (dirty) ctx.setTransform(base);
  }

  /** Redraw lit windows/shopfronts additively, on top of the night light-map composite
   *  (call once, right after `LightLayer.composite`) so they glow instead of getting
   *  darkened along with the rest of the world by that multiply pass. Reuses the exact
   *  same per-edge geometry as `drawFacade`, so the glow lines up window-for-window. */
  drawNightWindows(ctx: CanvasRenderingContext2D, v: View) {
    const night = this.atmos.night;
    if (night < 0.28 || v.scale <= 6 || !this.facades) return;
    const vis = this.chunks.filter((c) => bboxHit(c.bbox, v));
    let budget = 40000;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(0.85, (night - 0.28) * 1.3);
    const base0 = ctx.getTransform();
    const A = base0.a, B = base0.b, C = base0.c, D = base0.d, E = base0.e, F = base0.f;
    const sr = screenRect(ctx);
    for (const c of vis) {
      for (const g of c.bgroups) {
        if (!g.facade || !g.glowCache) continue;
        const [ox, oy] = this.roofOffset(c.cx, c.cy, g.h, v);
        const px = Math.hypot(ox, oy) * v.scale;
        if (px < 10 || budget <= 0) continue;
        const { upper, door, shop: shopTex } = g.glowCache;
        const invLevels = 1 / g.levels;
        const vx = ox * invLevels, vy = oy * invLevels;
        const va = A * vx + C * vy, vb = B * vx + D * vy;
        for (const rr of g.rings) {
          const pts = rr.pts, ed = rr.edges;
          for (let i = 0, o = 0; i < pts.length - 2; i += 2, o += EDGE_STRIDE) {
            const elen = ed[o];
            const epx = elen * v.scale;
            const ux = ed[o + 1], uy = ed[o + 2];
            if (elen < 1.4 || epx < 4 || ux * oy - uy * ox < 0) continue;
            const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
            if (!onRect(sr, Math.min(ax, bx, ax + ox, bx + ox), Math.min(ay, by, ay + oy, by + oy), Math.max(ax, bx, ax + ox, bx + ox), Math.max(ay, by, ay + oy, by + oy), 0.5)) continue;
            const variant = ed[o + 5];
            const shop = i === rr.shopEdge;
            const up = g.levels > 1 ? upper[variant] : null;
            const ground = shop ? shopTex[variant] : door[variant];
            budget -= epx;
            // variants without any lit glass have no glow tile: nothing to add
            if (!up && !ground) {
              if (budget <= 0) break;
              continue;
            }
            ctx.setTransform(A * ux + C * uy, B * ux + D * uy, va, vb, A * ax + C * ay + E, B * ax + D * ay + F);
            if (up) {
              ctx.fillStyle = up;
              ctx.fillRect(0, 1, elen, g.levels - 1);
            }
            if (ground) {
              ctx.fillStyle = ground;
              ctx.fillRect(0, 0, elen, 1);
            }
            if (budget <= 0) break;
          }
        }
      }
    }
    ctx.setTransform(base0);
    ctx.restore();
  }

  private drawTrees(ctx: CanvasRenderingContext2D, v: View, vis: Chunk[]) {
    if (v.scale < 3) return;
    const sdx = this.atmos.sun.dx * 6, sdy = this.atmos.sun.dy * 6;
    const daylight = this.atmos.daylight;
    if (daylight > 0.03) {
      ctx.save();
      ctx.translate(sdx, sdy);
      ctx.fillStyle = `rgba(15,20,35,${0.22 * daylight})`;
      for (const c of vis) if (c.trees) ctx.fill(c.trees.shadow);
      ctx.restore();
    }
    const TONE_COLORS = ['#3f6b3a', '#4c7a42', '#588c4a', '#6a9c55'];
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = TONE_COLORS[i];
      for (const c of vis) if (c.trees) ctx.fill(c.trees.canopy[i]);
    }
    ctx.save();
    ctx.translate(-this.atmos.sunDir.x * 0.5, -this.atmos.sunDir.y * 0.5);
    ctx.fillStyle = 'rgba(210,230,150,0.35)';
    for (const c of vis) if (c.trees) ctx.fill(c.trees.highlight);
    ctx.restore();
  }

  private drawAds(ctx: CanvasRenderingContext2D, v: View) {
    for (const a of this.ads) {
      if (!bboxHit(a.b.bbox, v)) continue;
      const [ox, oy] = this.roofOffset(a.chunk.cx, a.chunk.cy, a.h, v);
      ctx.save();
      ctx.translate(a.b.cx + ox, a.b.cy + oy);
      ctx.rotate(a.angle);
      const w = a.len, h = a.w;
      ctx.fillStyle = a.ad.bg;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = a.ad.accent;
      ctx.lineWidth = h * 0.08;
      ctx.strokeRect(-w / 2 + h * 0.08, -h / 2 + h * 0.08, w - h * 0.16, h - h * 0.16);
      ctx.fillStyle = a.ad.fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `900 ${h * 0.42}px "Arial Black", Impact, sans-serif`;
      fitText(ctx, a.ad.title, 0, -h * 0.08, w * 0.9);
      ctx.font = `italic 700 ${h * 0.16}px Arial, sans-serif`;
      fitText(ctx, a.ad.slogan, 0, h * 0.28, w * 0.9);
      ctx.restore();
    }
  }

  /** Building ground shadows cast by the sun (drawn after the ground, before entities). */
  drawShadows(ctx: CanvasRenderingContext2D, v: View) {
    const alpha = 0.28 * this.atmos.daylight;
    if (alpha < 0.015) return;
    const vis = this.chunks.filter((c) => bboxHit(c.bbox, { x0: v.x0 - 55, y0: v.y0 - 55, x1: v.x1 + 55, y1: v.y1 + 55 }));
    const sdx = this.atmos.sun.dx, sdy = this.atmos.sun.dy;
    const sunKey = Math.round(sdx * 20) * 1000 + Math.round(sdy * 20);
    const sunMoved = sunKey !== this.sunKeyLast;
    if (sunMoved) this.sunKeyLast = sunKey;
    let budget = 60;
    let rebuilt = false;
    let visKey = '';
    for (const c of vis) {
      visKey += c.idx + ',';
      for (const g of c.bgroups) {
        if (!g.shadow || (sunMoved && g.shadowKey !== sunKey && budget > 0)) {
          g.shadow = this.buildShadow(g, sdx, sdy);
          g.shadowKey = sunKey;
          budget--;
          rebuilt = true;
        }
      }
    }
    // re-merging every group's shadow each frame cost a big Path2D build (and, since
    // it was a new path object, a fresh tessellation/mask on the canvas side) even
    // when nothing changed; reuse the same merged path until something does
    if (rebuilt || visKey !== this.shadowVisKey || !this.shadowMerged) {
      const merged = new Path2D();
      for (const c of vis) for (const g of c.bgroups) merged.addPath(g.shadow!);
      this.shadowMerged = merged;
      this.shadowVisKey = visKey;
    }
    ctx.fillStyle = `rgba(20,25,45,${alpha})`;
    ctx.fill(this.shadowMerged);
  }

  private buildShadow(g: BGroup, sdx: number, sdy: number): Path2D {
    const ox = sdx * g.h, oy = sdy * g.h;
    const p = new Path2D();
    for (const rr of g.rings) {
      const pts = rr.pts;
      for (let i = 0; i < pts.length - 2; i += 2) {
        const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
        const ex = bx - ax, ey = by - ay;
        if (ex * oy - ey * ox >= 0) {
          p.moveTo(ax, ay);
          p.lineTo(bx, by);
          p.lineTo(bx + ox, by + oy);
          p.lineTo(ax + ox, ay + oy);
        } else {
          p.moveTo(ax, ay);
          p.lineTo(ax + ox, ay + oy);
          p.lineTo(bx + ox, by + oy);
          p.lineTo(bx, by);
        }
        p.closePath();
      }
    }
    return p;
  }

  /** Bridge decks: a soft cast shadow onto whatever is below, the deck surface itself
   *  (casing/asphalt/lane markings/edge highlight, normally drawn in `drawGround`), then railings.
   *  Called between the level-0 and level-1 entity passes so traffic below stays under the deck. */
  drawBridges(ctx: CanvasRenderingContext2D, v: View) {
    const vis = this.chunks.filter((c) => bboxHit(c.bbox, v));
    const keys = this.sortedBridgeLayers;
    if (!keys.length) return;

    // cast shadow: the casing/deck outline offset by the sun direction, dark and translucent
    const daylight = this.atmos.daylight;
    if (daylight > 0.02) {
      const sdx = this.atmos.sun.dx * 3.2, sdy = this.atmos.sun.dy * 3.2;
      ctx.save();
      ctx.translate(sdx, sdy);
      ctx.globalAlpha = Math.min(0.4, 0.32 * daylight);
      ctx.fillStyle = ctx.strokeStyle = '#0a0c14';
      for (const [key, layer] of keys) {
        if (!key.startsWith('bc:')) continue;
        ctx.lineWidth = (layer.op as { width: number }).width + 1;
        for (const c of vis) {
          const p = c.layers.get(key);
          if (p) ctx.stroke(p);
        }
      }
      ctx.restore();
    }

    // deck surface
    const wantTex = v.scale > 7.5;
    for (const [key, layer] of keys) {
      const op = layer.op;
      const col = wantTex && op.tex ? op.tex : op.color;
      if (op.kind === 'fill') ctx.fillStyle = col;
      else {
        ctx.strokeStyle = col;
        ctx.lineWidth = op.width;
        ctx.setLineDash(op.dash ?? []);
      }
      for (const c of vis) {
        const p = c.layers.get(key);
        if (!p) continue;
        if (op.kind === 'fill') ctx.fill(p, 'evenodd');
        else ctx.stroke(p);
      }
    }
    ctx.setLineDash([]);
    this.drawRailings(ctx, v);
  }

  /** Thin light railings with posts along both edges of every visible bridge deck. */
  private drawRailings(ctx: CanvasRenderingContext2D, v: View) {
    if (v.scale < 2.5) return;
    ctx.save();
    ctx.lineWidth = 0.1;
    ctx.strokeStyle = 'rgba(225,225,220,0.8)';
    for (const br of this.bridges) {
      if (!bboxHit(br.bbox, v)) continue;
      for (const side of [1, -1]) {
        const off = offsetPolyline(br.p, br.hw * side + 0.25);
        ctx.beginPath();
        for (let i = 0; i < off.length; i += 2) (i === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, off[i], off[i + 1]);
        ctx.stroke();
        ctx.fillStyle = 'rgba(50,50,54,0.9)';
        walkPolyline(br.p, 5, 0, (x, y, nx, ny) => {
          const px = x + nx * (br.hw * side + 0.25), py = y + ny * (br.hw * side + 0.25);
          ctx.beginPath();
          ctx.arc(px, py, 0.09, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }
    ctx.restore();
  }

  /** Street lamps, lit windows and neon ads. */
  emitLights(L: LightLayer, v: View) {
    const night = this.atmos.night;
    if (night > 0.03) {
      const vis = this.chunks.filter((c) => bboxHit(c.bbox, v));
      for (const c of vis) {
        if (c.lamps) {
          for (let i = 0; i < c.lamps.length; i += 2) {
            const x = c.lamps[i], y = c.lamps[i + 1];
            if (!L.visible(x, y, 11)) continue;
            L.point(x, y, 11, '#ffc978', 0.85 * night);
            L.glow(x, y, 1.8, '#ffdca0', 0.5 * night);
          }
        }
        if (c.bgroups.length && L.visible(c.cx, c.cy, 45)) {
          L.point(c.cx, c.cy, 42, '#ffb26b', Math.min(0.3, c.bgroups.length * 0.018) * night);
        }
      }
    }
    if (night > 0.05) {
      for (const a of this.ads) {
        if (!bboxHit(a.b.bbox, v)) continue;
        L.point(a.b.cx, a.b.cy, Math.max(a.len, a.w) * 0.85, a.ad.accent, 0.55 * night);
      }
    }
  }

  /** Flat 2D rendering of all buildings, for the pause map. */
  drawBuildingsFlat(ctx: CanvasRenderingContext2D) {
    for (const c of this.chunks)
      for (const g of c.bgroups) {
        ctx.fillStyle = g.roof;
        ctx.fill(g.path, 'evenodd');
      }
  }
}

function darken(c: string) {
  if (!c.startsWith('#')) return c;
  const n = parseInt(c.slice(1), 16);
  const f = (v: number) => Math.round(v * 0.78);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function shade(color: string, factor: number): string {
  let r = 255, g = 255, b = 255, a = 1;
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1, 7), 16);
    (r = n >> 16), (g = (n >> 8) & 255), (b = n & 255);
  } else {
    const m = color.match(/[\d.]+/g);
    if (m) {
      (r = +m[0]), (g = +m[1]), (b = +m[2]);
      if (m[3] !== undefined) a = +m[3];
    }
  }
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
  return a < 1 ? `rgba(${f(r)},${f(g)},${f(b)},${a})` : `rgb(${f(r)},${f(g)},${f(b)})`;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number) {
  const m = ctx.measureText(text).width;
  if (m > maxW) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(maxW / m, 1);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  } else ctx.fillText(text, x, y);
}
