import type { World, Building } from './World';
import { bboxOf, bboxHit, rng, pointInRings, ringArea, type BBox } from '../util/math';
import { ROOF_ADS, BRAND_COLORS } from '../data/brands';
import { Atmosphere } from './Atmosphere';
import type { LightLayer } from './Lighting';
import { texture, animateWater, type TexKind } from './Textures';
import { facadeTexture, groundTexture, facadeGlow, groundGlow, type FacadeStyle } from './Facades';
import { STOREY, WP, hash01, heightBin, roofSlopes, wallPieces } from './BuildingGeometry';

const CHUNK = 128;

/** `tex` (a pattern baked over `color`) replaces `color` when zoomed in enough to see it */
type DrawOp =
  | { kind: 'fill'; color: string; tex?: CanvasPattern }
  | { kind: 'stroke'; color: string; width: number; dash?: number[]; tex?: CanvasPattern };

interface Layer {
  op: DrawOp;
  order: number;
}

/** 'rgba(...)' strings for translucent dark/light overlays (facade Lambert shading, roof
 *  slopes), by alpha in 1/255 steps, so per-edge loops reuse interned strings instead of
 *  formatting (and the canvas re-parsing) a fresh colour every time */
const SHADE_DARK: string[] = [];
const SHADE_LIGHT: string[] = [];
for (let i = 0; i <= 255; i++) {
  SHADE_DARK.push(`rgba(10,10,16,${i / 255})`);
  SHADE_LIGHT.push(`rgba(255,250,235,${i / 255})`);
}

/** One chunk's buildings of one height: they share a roof projection, so they are drawn as a
 *  unit. The building pass draws tiers lowest first (see `drawBuildings`). */
interface Tier {
  /** storeys (0.6 for canopies) and height in metres */
  bin: number;
  h: number;
  levels: number;
  /** footprint bbox of every member */
  bbox: BBox;
  walls: WallSet[];
  roofs: RoofSet[];
  /** every roof outline, for the eave stroke */
  outline: Path2D;
  /** flat roofs' outlines, for the parapet highlight */
  flatOutline: Path2D | null;
  /** fallback ridge line for pitched roofs without usable slopes */
  ridge: Path2D | null;
  /** hip and ridge lines between roof slopes */
  hips: Path2D | null;
  /** roof slopes by downslope compass direction (8 buckets, 45° apart), shaded per frame */
  slopes: (Path2D | null)[];
  chimneys: Path2D | null;
  roofDetail: Path2D | null;
  /** ground-level wall pieces as plain segments, for the zoomed-out storey lines */
  storeys: Path2D | null;
  /** footprints, for sun shadows */
  rings: Float32Array[];
  shadow?: Path2D;
  shadowKey?: number;
  ads: RoofAd[];
  /** deterministic per-tier value for the zoomed-out lit-window dashes */
  seed: number;
}

/** A tier's walls of one colour and facade style. */
interface WallSet {
  wall: string;
  /** 4 quantised Lambert wall tones, dark to bright */
  wallShades: string[];
  /** facade style for close-up window/door rendering; undefined = plain walls */
  facade?: FacadeStyle;
  /** exposed wall pieces, WP floats each (see BuildingGeometry.WP) */
  pieces: Float32Array;
  bbox: BBox;
  /** wall quads bucketed by tone, rebuilt when the tier's quantised projection or the sun moves */
  cache?: { qx: number; qy: number; qh: number; sk: number; buckets: Path2D[]; used: boolean[] };
  /** baked facade/ground CanvasPatterns for the 3 variants, keyed by day/night */
  facadeCache?: { lit: boolean; upper: CanvasPattern[]; door: CanvasPattern[]; shop: CanvasPattern[] };
  /** glow-only (transparent except lit windows) variants, redrawn after the light composite */
  glowCache?: { upper: (CanvasPattern | null)[]; door: (CanvasPattern | null)[]; shop: (CanvasPattern | null)[] };
  signs: SignInfo[];
  /** piece offsets that get facade textures this frame (see `facadePrepass`) */
  drawList: number[];
}

interface RoofSet {
  color: string;
  /** colour baked with a tile/concrete texture */
  tex?: CanvasPattern;
  path: Path2D;
}

interface RoofAd {
  b: Building;
  ad: (typeof ROOF_ADS)[number];
  angle: number;
  w: number;
  len: number;
}

/** Perspective for one height this frame. A point p at that height is drawn at
 *  c + (p - c)·s: the camera looks straight down, so everything at one height is the ground
 *  plan scaled about the camera. The camera (c) is quantised per height so cached wall
 *  geometry survives small camera moves, and walls/roofs/facades of a height always agree. */
interface Proj {
  k: number;
  s: number;
  cx: number;
  cy: number;
  qx: number;
  qy: number;
  qh: number;
  camH: number;
}

/** roof shift per metre of distance from the camera, for something `z` metres up */
function kAt(z: number, camH: number) {
  const hh = Math.min(z, camH * 0.6);
  return hh / (camH - hh);
}

/** largest roof misplacement allowed by the per-height camera quantisation (metres) */
const PROJ_EPS = 0.05;
/** light for roof slopes at night (from the north-west, the classic top-left map light) */
const MOON = { x: -0.5, y: -0.85 };

interface TreeSet {
  shadow: Path2D;
  canopy: Path2D[];
  highlight: Path2D;
}

/** A shop/brand sign board on the ground floor of a wall piece, centred at (x, y) on the footprint. */
interface SignInfo {
  x: number;
  y: number;
  ux: number;
  uy: number;
  nx: number;
  ny: number;
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
  /** buildings of this chunk by height, lowest first */
  tiers: Tier[];
  nBuildings: number;
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

/** true for a ground layer that belongs to a bridge deck (drawn in `drawBridges`, not `drawGround`) */
function isBridgeLayer(key: string): boolean {
  return key.startsWith('bc:') || key.startsWith('br:') || key.startsWith('f1:') || key.startsWith('m1') || key.startsWith('edge1') || key.startsWith('kerb1');
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

/** slack for tier/wall-set culling: strokes, chimney shadows, shop sign boards that can be wider
 *  than the wall they hang on, and camera shake (the projection centre is the unshaken camera) */
const GROUP_CULL_PAD = 6;
/** per-frame cap on facade wall width drawn (screen px), so a dense Old Town view can't blow the frame budget */
const FACADE_BUDGET_PX = 200000;

export class Renderer {
  private chunks: Chunk[] = [];
  private layers = new Map<string, Layer>();
  ads: RoofAd[] = [];
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
  /** wall sets that got facades in the last `drawBuildings`, with their tier and projection,
   *  replayed by `drawNightWindows` */
  private facadeSets: { set: WallSet; t: Tier; P: Proj }[] = [];

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
        tiers: [],
        nBuildings: 0,
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

    this.buildBuildings(map);
  }

  /** Buildings, grouped per chunk into height tiers, and within a tier into wall sets (by
   *  wall colour + facade style) and roof sets (by roof colour), so each draws in few calls. */
  private buildBuildings(map: Map<number, Chunk>) {
    const w = this.world;
    const addPoly = (p: Path2D, flat: ArrayLike<number>) => {
      p.moveTo(flat[0], flat[1]);
      for (let i = 2; i < flat.length; i += 2) p.lineTo(flat[i], flat[i + 1]);
      p.closePath();
    };
    const tierOf = new Map<Chunk, Map<number, Tier>>();
    const setOf = new Map<Tier, Map<string, { set: WallSet; pieces: number[] }>>();
    const roofOf = new Map<Tier, Map<string, RoofSet>>();
    const pieceOf = new Map<Building, { pieces: number[]; entry: { set: WallSet; pieces: number[] } }>();
    const oldTownAt = w.landmark('main');
    for (const b of w.buildings) {
      const c = this.chunkAt(b.bboxAll, map);
      c.nBuildings++;
      const r = rng(b.seed * 7919);
      const bin = heightBin(b);
      const h = bin * STOREY;
      let wall = OLD_WALLS[(r() * OLD_WALLS.length) | 0], roof = ROOFS[(r() * ROOFS.length) | 0], flat = false;
      if (b.kind === 3 || (b.area > 2500 && b.levels >= 4)) (wall = '#767b82'), (roof = FLAT_ROOFS[(r() * FLAT_ROOFS.length) | 0]), (flat = true);
      if (b.levels >= 8) (wall = '#6c7179'), (roof = FLAT_ROOFS[(r() * FLAT_ROOFS.length) | 0]), (flat = true);
      if (b.kind === 1) (wall = '#cfc6b4'), (roof = r() < 0.6 ? '#5c8a73' : '#8c4a36');
      if (b.kind === 2) (wall = '#e9e3d6'), (roof = '#b8553a');
      if (b.kind === 4) (wall = 'rgba(80,80,80,0.5)'), (roof = 'rgba(150,150,150,0.55)');
      if (b.color) (roof = b.color), (wall = b.wallColor ?? wall);
      const pitched = !flat && b.kind !== 4;

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

      // the chunk's tier for this height
      let tm = tierOf.get(c);
      if (!tm) tierOf.set(c, (tm = new Map()));
      let t = tm.get(bin);
      if (!t) {
        t = {
          bin, h, levels: Math.max(1, bin),
          bbox: { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
          walls: [], roofs: [], outline: new Path2D(), flatOutline: null, ridge: null, hips: null,
          slopes: [null, null, null, null, null, null, null, null],
          chimneys: null, roofDetail: null, storeys: null, rings: [], ads: [],
          seed: hash01((c.cx * 7 + h) | 0, (c.cy * 3) | 0),
        };
        tm.set(bin, t);
        c.tiers.push(t);
      }
      bboxOf(b.rings[0], 0, t.bbox);
      for (let i = 1; i < b.rings.length; i++) bboxOf(b.rings[i], 0, t.bbox);
      t.rings.push(...b.rings);

      // walls: only the exposed parts (party walls hidden, or starting at a lower neighbour's roof)
      const pieces = wallPieces(w, b, h);
      if (pieces.length) {
        let sm = setOf.get(t);
        if (!sm) setOf.set(t, (sm = new Map()));
        const key = `${wall}|${facade ?? ''}`;
        let entry = sm.get(key);
        if (!entry) {
          const set: WallSet = {
            wall, wallShades: WALL_SHADE_LEVELS.map((f) => shade(wall, f)), facade, pieces: new Float32Array(0),
            bbox: { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }, signs: [], drawList: [],
          };
          sm.set(key, (entry = { set, pieces: [] }));
          t.walls.push(set);
        }
        bboxOf(b.rings[0], 0, entry.set.bbox);
        for (let i = 1; i < b.rings.length; i++) bboxOf(b.rings[i], 0, entry.set.bbox);
        pieceOf.set(b, { pieces, entry });
        // shopfront: the edge with the most exposed ground-floor wall, if it faces a named street
        if (facade && b.rings.length === 1 && b.area > 30 && (b.kind === 3 || (facade === 'oldtown' && hash01(b.seed, 9) < 0.35))) {
          const byEdge = new Map<string, number>();
          let bestKey = '', best = 0, bestI = -1, bestLen = 0;
          for (let i = 0; i < pieces.length; i += WP) {
            if (pieces[i + 9] > 0) continue;
            const k = `${pieces[i]}|${pieces[i + 1]}`;
            const len = pieces[i + 8] - pieces[i + 7];
            const tot = (byEdge.get(k) ?? 0) + len;
            byEdge.set(k, tot);
            if (tot > best) (best = tot), (bestKey = k);
          }
          for (let i = 0; i < pieces.length; i += WP) {
            const len = pieces[i + 8] - pieces[i + 7];
            if (pieces[i + 9] === 0 && `${pieces[i]}|${pieces[i + 1]}` === bestKey && len > bestLen) (bestLen = len), (bestI = i);
          }
          if (bestI >= 0 && best >= 3) {
            const um = (pieces[bestI + 7] + pieces[bestI + 8]) / 2;
            const mx = pieces[bestI] + pieces[bestI + 2] * um, my = pieces[bestI + 1] + pieces[bestI + 3] * um;
            if (w.streetName(mx, my) !== null) {
              for (let i = 0; i < pieces.length; i += WP) if (pieces[i + 9] === 0 && `${pieces[i]}|${pieces[i + 1]}` === bestKey) pieces[i + 11] = 1;
              // Old Town shopfronts without a named POI get a generic label (Potraviny, Bar, ...)
              if (facade === 'oldtown' && hash01(b.seed, 12) < 0.5 && !w.data.pois.some((p) => p.k === 'shop' && Math.hypot(p.x - mx, p.y - my) < 15)) {
                const [name, bg, fg] = GENERIC_SIGNS[(hash01(b.seed, 13) * GENERIC_SIGNS.length) | 0];
                entry.set.signs.push({ x: mx, y: my, ux: pieces[bestI + 2], uy: pieces[bestI + 3], nx: pieces[bestI + 4], ny: pieces[bestI + 5], name, colors: [bg, fg] });
              }
            }
          }
        }
        for (const v of pieces) entry.pieces.push(v);
      }

      // roof fill, by colour (and flat/pitched texture)
      let rm = roofOf.get(t);
      if (!rm) roofOf.set(t, (rm = new Map()));
      const rkey = `${roof}|${flat ? 1 : 0}`;
      let rs = rm.get(rkey);
      if (!rs) {
        rs = { color: roof, tex: roof.startsWith('#') && b.kind !== 4 ? texture(flat ? 'concrete' : 'roofTile', roof) : undefined, path: new Path2D() };
        rm.set(rkey, rs);
        t.roofs.push(rs);
      }
      for (const ring of b.rings) addPoly(rs.path, ring);
      for (const ring of b.rings) addPoly(t.outline, ring);
      if (!pitched && b.kind !== 4) for (const ring of b.rings) addPoly((t.flatOutline ??= new Path2D()), ring);

      // pitched: hipped/gabled slopes (or a plain ridge line when the outline defeats them) and
      // chimneys; large flat roofs: HVAC boxes and skylights
      if (pitched && b.area > 30) {
        const bands = roofSlopes(w, b);
        if (bands) {
          for (const band of bands) {
            addPoly((t.slopes[band.dir] ??= new Path2D()), band.pts);
            const hp = (t.hips ??= new Path2D());
            for (let i = 0; i < band.lines.length; i += 4) {
              hp.moveTo(band.lines[i], band.lines[i + 1]);
              hp.lineTo(band.lines[i + 2], band.lines[i + 3]);
            }
          }
        }
        if (b.rings.length === 1 && b.area > 40) {
          const ring = b.rings[0];
          let best = 0, angle = 0;
          for (let k = 0; k < ring.length - 2; k += 2) {
            const l = Math.hypot(ring[k + 2] - ring[k], ring[k + 3] - ring[k + 1]);
            if (l > best) (best = l), (angle = Math.atan2(ring[k + 3] - ring[k + 1], ring[k + 2] - ring[k]));
          }
          const len = Math.min(best, Math.sqrt(b.area)) * 0.42;
          if (!bands) {
            const rp = (t.ridge ??= new Path2D());
            rp.moveTo(b.cx - Math.cos(angle) * len, b.cy - Math.sin(angle) * len);
            rp.lineTo(b.cx + Math.cos(angle) * len, b.cy + Math.sin(angle) * len);
          }
          // chimney(s) near the ridge, offset off-centre so they read as boxes, not the ridge itself
          if (b.area > 70) {
            const nx = -Math.sin(angle), ny = Math.cos(angle);
            const cr = rng(b.seed * 331 + 5);
            const n = 1 + (cr() < 0.4 ? 1 : 0);
            for (let k = 0; k < n; k++) {
              const tt = (cr() - 0.5) * len * 1.1;
              const sz = 0.7 + cr() * 0.4;
              const px = b.cx + Math.cos(angle) * tt + nx * len * 0.18, py = b.cy + Math.sin(angle) * tt + ny * len * 0.18;
              if (pointInRings(px, py, b.rings)) (t.chimneys ??= new Path2D()).rect(px - sz / 2, py - sz / 2, sz, sz * 1.6);
            }
          }
        }
      } else if (!pitched && b.kind !== 4 && b.rings.length === 1 && b.area > 600) {
        const rr = rng(b.seed * 131 + 7);
        const n = 1 + ((rr() * 3) | 0);
        const bw = b.bbox.x1 - b.bbox.x0, bh = b.bbox.y1 - b.bbox.y0;
        for (let k = 0; k < n; k++) {
          const dw = Math.min(bw, bh) * (0.08 + rr() * 0.07);
          const dx = b.bbox.x0 + bw * (0.2 + rr() * 0.6), dy = b.bbox.y0 + bh * (0.2 + rr() * 0.6);
          if (!pointInRings(dx, dy, b.rings)) continue;
          (t.roofDetail ??= new Path2D()).rect(dx - dw / 2, dy - dw / 2, dw, dw);
        }
      }
    }

    // shop/fuel POI signs: on the nearest exposed ground-floor wall piece
    for (const p of w.data.pois) {
      if (p.k !== 'shop' && p.k !== 'fuel') continue;
      let bestD = 30 * 30, bestP: number[] | null = null, bestI = -1, bestSet: WallSet | null = null;
      w.forBuildingsNear(p.x - 30, p.y - 30, p.x + 30, p.y + 30, (b) => {
        const e = pieceOf.get(b);
        if (!e) return;
        const pc = e.pieces;
        for (let i = 0; i < pc.length; i += WP) {
          if (pc[i + 9] > 0 || pc[i + 8] - pc[i + 7] < 1.5) continue;
          const ax = pc[i] + pc[i + 2] * pc[i + 7], ay = pc[i + 1] + pc[i + 3] * pc[i + 7];
          const dx = pc[i + 2] * (pc[i + 8] - pc[i + 7]), dy = pc[i + 3] * (pc[i + 8] - pc[i + 7]);
          const l2 = dx * dx + dy * dy || 1;
          const tt = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / l2));
          const d = (ax + dx * tt - p.x) ** 2 + (ay + dy * tt - p.y) ** 2;
          if (d < bestD) (bestD = d), (bestP = pc), (bestI = i), (bestSet = e.entry.set);
        }
      });
      if (!bestP || !bestSet) continue;
      const pc: number[] = bestP;
      const um = (pc[bestI + 7] + pc[bestI + 8]) / 2;
      (bestSet as WallSet).signs.push({
        x: pc[bestI] + pc[bestI + 2] * um, y: pc[bestI + 1] + pc[bestI + 3] * um,
        ux: pc[bestI + 2], uy: pc[bestI + 3], nx: pc[bestI + 4], ny: pc[bestI + 5],
        name: p.k === 'fuel' ? `⛽ ${p.n}` : p.n, colors: BRAND_COLORS[p.n],
      });
    }

    // pack wall pieces; storey-line segments for the zoomed-out fallback
    for (const [t, sm] of setOf) {
      for (const { set, pieces } of sm.values()) {
        set.pieces = Float32Array.from(pieces);
        for (let i = 0; i < pieces.length; i += WP) {
          if (pieces[i + 9] > 0) continue;
          const sp = (t.storeys ??= new Path2D());
          sp.moveTo(pieces[i] + pieces[i + 2] * pieces[i + 7], pieces[i + 1] + pieces[i + 3] * pieces[i + 7]);
          sp.lineTo(pieces[i] + pieces[i + 2] * pieces[i + 8], pieces[i + 1] + pieces[i + 3] * pieces[i + 8]);
        }
      }
    }
    for (const c of this.chunks) c.tiers.sort((a, b) => a.h - b.h);

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
      const tier = tierOf.get(this.chunkAt(b.bboxAll, map))?.get(heightBin(b));
      if (!tier) return;
      const len = Math.min(best * 0.7, Math.sqrt(b.area) * 1.1);
      const ad: RoofAd = { b, ad: ROOF_ADS[i % ROOF_ADS.length], angle, w: len * 0.32, len };
      tier.ads.push(ad);
      this.ads.push(ad);
    });
  }

  /** Screen-space shift of a point `h` metres up relative to its ground position (exact, not
   *  quantised; for one-off things like the UFO). */
  roofOffset(x: number, y: number, h: number, v: View): [number, number] {
    const k = kAt(h, v.camH);
    return [(x - v.camX) * k, (y - v.camY) * k];
  }

  /** This frame's projection for height `h` (see Proj). */
  private project(h: number, v: View): Proj {
    const qh = Math.round(Math.log(v.camH) * 100);
    const camH = Math.exp(qh / 100);
    const k = kAt(h, camH);
    const q = k > 1e-6 ? PROJ_EPS / k : 1;
    const qx = Math.round(v.camX / q), qy = Math.round(v.camY / q);
    return { k, s: 1 + k, cx: qx * q, cy: qy * q, qx, qy, qh, camH };
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

  /** Fake-3D buildings in true perspective (see Proj). The camera looks straight down, so depth is
   *  just height: tiers are drawn lowest first, and at each height every wall (with its facade and
   *  signs) goes down before any roof. A roof then covers every wall at or below its height and
   *  equal-height neighbours never paint over each other; party walls are already gone (see
   *  BuildingGeometry.wallPieces), and a taller neighbour's wall rises from the lower roof. */
  drawBuildings(ctx: CanvasRenderingContext2D, v: View) {
    const vis = this.chunks.filter((c) => bboxHit(c.bbox, { x0: v.x0 - 60, y0: v.y0 - 60, x1: v.x1 + 60, y1: v.y1 + 60 }));
    // `vis` is padded for trees (canopies and sun-shifted shadows reach past their trunk
    // point); everything below is additionally culled against the true canvas rect
    const sr = screenRect(ctx);

    // trees are registered by their trunk point: canopies reach ~5m past it, and the
    // shadow is shifted by up to 6 * |sun| (~17m at low sun) on top of that
    this.drawTrees(ctx, v, vis.filter((c) => c.trees && onRect(sr, c.bbox.x0, c.bbox.y0, c.bbox.x1, c.bbox.y1, 24)));

    // lamp posts (cheap, always drawn - dark by day, glow comes from emitLights at night)
    ctx.fillStyle = '#2c2c2e';
    for (const c of vis) if (c.lampPath && onRect(sr, c.bbox.x0, c.bbox.y0, c.bbox.x1, c.bbox.y1, 1)) ctx.fill(c.lampPath);

    // visible tiers. Projection pushes points away from the camera, so a tier whose footprints
    // are all off-screen is drawn entirely off-screen too
    const tiers: Tier[] = [];
    for (const c of vis) for (const t of c.tiers) if (onRect(sr, t.bbox.x0, t.bbox.y0, t.bbox.x1, t.bbox.y1, GROUP_CULL_PAD)) tiers.push(t);
    const far = (t: Tier) => Math.hypot((t.bbox.x0 + t.bbox.x1) / 2 - v.camX, (t.bbox.y0 + t.bbox.y1) / 2 - v.camY);
    tiers.sort((a, b) => a.h - b.h || far(b) - far(a));

    const night = this.atmos.night;
    const sunDir = this.atmos.sunDir;
    const sk = Math.round(sunDir.x * 20) * 64 + Math.round(sunDir.y * 20);
    // windows/doors/shopfronts once zoomed in enough to read them; the cheap storey-line
    // fallback while zoomed out (e.g. driving) so the city still reads as lit up at night
    const facadeReady = this.facades && v.scale > 6;
    const wantWindows = v.scale > 3;
    const projs = new Map<number, Proj>();
    const projFor = (h: number) => {
      let p = projs.get(h);
      if (!p) projs.set(h, (p = this.project(h, v)));
      return p;
    };
    this.facadeSets.length = 0;
    if (facadeReady) this.facadePrepass(tiers, projFor, v, sr);
    const slopeShade = this.slopeShades();

    ctx.save();
    ctx.lineJoin = 'miter';
    const base = ctx.getTransform();
    for (let i = 0; i < tiers.length; ) {
      let j = i;
      while (j < tiers.length && tiers[j].h === tiers[i].h) j++;
      const P = projFor(tiers[i].h);
      for (let k = i; k < j; k++) this.drawTierWalls(ctx, tiers[k], P, v, sr, sk, night, facadeReady, wantWindows, base);
      this.roofTransform(ctx, base, P.cx, P.cy, P.s);
      for (let k = i; k < j; k++) this.drawTierRoof(ctx, tiers[k], P, v, base, slopeShade);
      for (let k = i; k < j; k++) if (tiers[k].ads.length) this.drawAds(ctx, tiers[k], P, v, base);
      ctx.setTransform(base);
      i = j;
    }
    ctx.restore();
  }

  /** Set the transform that draws ground-plan coordinates at a height: scale `s` about (cx, cy),
   *  plus an optional on-screen nudge (ex, ey) in world metres (e.g. small drop shadows). */
  private roofTransform(ctx: CanvasRenderingContext2D, m: DOMMatrix, cx: number, cy: number, s: number, ex = 0, ey = 0) {
    const tx = cx * (1 - s) + ex, ty = cy * (1 - s) + ey;
    ctx.setTransform(m.a * s, m.b * s, m.c * s, m.d * s, m.a * tx + m.c * ty + m.e, m.b * tx + m.d * ty + m.f);
  }

  /** One tier's walls (tone-bucketed quads), then their facades or storey lines, then signs. */
  private drawTierWalls(
    ctx: CanvasRenderingContext2D, t: Tier, P: Proj, v: View, sr: BBox | null, sk: number,
    night: number, facadeReady: boolean, wantWindows: boolean, base: DOMMatrix,
  ) {
    for (const set of t.walls) {
      const bb = set.bbox;
      if (!onRect(sr, bb.x0, bb.y0, bb.x1, bb.y1, GROUP_CULL_PAD)) continue;
      const c = this.wallBuckets(set, t, P, sk);
      for (let k = 0; k < 4; k++) {
        if (!c.used[k]) continue;
        ctx.fillStyle = set.wallShades[k];
        ctx.fill(c.buckets[k]);
      }
      if (facadeReady && set.drawList.length) this.drawFacade(ctx, set, t, P, night, base);
      if (v.scale > 6 && set.signs.length) this.drawSigns(ctx, set, P, v);
    }
    if (!facadeReady && wantWindows && t.storeys && t.levels >= 2) this.drawStoreyLines(ctx, t, P, v, night, base);
  }

  /** A wall set's quads for this projection, bucketed into 4 Lambert tones. Only walls facing the
   *  camera are kept (the rest are under their own roof); each runs from its base (ground, or a
   *  lower neighbour's roof) up to the tier's height. Rebuilt only when the tier's quantised
   *  camera, zoom or the sun changes. */
  private wallBuckets(set: WallSet, t: Tier, P: Proj, sk: number) {
    const c = set.cache;
    if (c && c.qx === P.qx && c.qy === P.qy && c.qh === P.qh && c.sk === sk) return c;
    const buckets = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const used = [false, false, false, false];
    const pc = set.pieces, cx = P.cx, cy = P.cy, kh = P.k, sun = this.atmos.sunDir;
    for (let i = 0; i < pc.length; i += WP) {
      const ax = pc[i], ay = pc[i + 1], nx = pc[i + 4], ny = pc[i + 5];
      if ((ax - cx) * nx + (ay - cy) * ny >= 0) continue;
      const ux = pc[i + 2], uy = pc[i + 3], u0 = pc[i + 7], u1 = pc[i + 8];
      const x0 = ax + ux * u0, y0 = ay + uy * u0, x1 = ax + ux * u1, y1 = ay + uy * u1;
      const kb = pc[i + 9] > 0 ? kAt(pc[i + 9], P.camH) : 0;
      const tone = Math.min(3, (Math.max(0, nx * sun.x + ny * sun.y) * 3.4) | 0);
      const p = buckets[tone];
      used[tone] = true;
      // camera-facing quads all wind the same way, so one nonzero fill covers overlaps
      p.moveTo(x0 + (x0 - cx) * kb, y0 + (y0 - cy) * kb);
      p.lineTo(x1 + (x1 - cx) * kb, y1 + (y1 - cy) * kb);
      p.lineTo(x1 + (x1 - cx) * kh, y1 + (y1 - cy) * kh);
      p.lineTo(x0 + (x0 - cx) * kh, y0 + (y0 - cy) * kh);
      p.closePath();
    }
    return (set.cache = { qx: P.qx, qy: P.qy, qh: P.qh, sk, buckets, used });
  }

  /** Pick this frame's facade pieces nearest-first against a pixel-width budget, so a dense view
   *  can't blow the frame time and it's the far walls, not the tall ones, that go plain. Night
   *  windows replay exactly this list (`facadeSets`). */
  private facadePrepass(tiers: Tier[], projFor: (h: number) => Proj, v: View, sr: BBox | null) {
    const cands: { set: WallSet; t: Tier; P: Proj; d: number }[] = [];
    for (const t of tiers) {
      const P = projFor(t.h);
      for (const set of t.walls) {
        set.drawList.length = 0;
        const bb = set.bbox;
        if (!set.facade || !onRect(sr, bb.x0, bb.y0, bb.x1, bb.y1, GROUP_CULL_PAD)) continue;
        const dx = Math.max(bb.x0 - v.camX, 0, v.camX - bb.x1), dy = Math.max(bb.y0 - v.camY, 0, v.camY - bb.y1);
        cands.push({ set, t, P, d: dx * dx + dy * dy });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    let budget = FACADE_BUDGET_PX;
    for (const { set, t, P } of cands) {
      const pc = set.pieces;
      for (let i = 0; i < pc.length && budget > 0; i += WP) {
        const len = pc[i + 8] - pc[i + 7];
        const epx = len * v.scale;
        if (len < 1.4 || epx < 4) continue;
        const ax = pc[i], ay = pc[i + 1], nx = pc[i + 4], ny = pc[i + 5];
        if ((ax - P.cx) * nx + (ay - P.cy) * ny >= 0) continue;
        const ux = pc[i + 2], uy = pc[i + 3];
        const x0 = ax + ux * pc[i + 7], y0 = ay + uy * pc[i + 7], x1 = ax + ux * pc[i + 8], y1 = ay + uy * pc[i + 8];
        const ox = ((x0 + x1) / 2 - P.cx) * P.k, oy = ((y0 + y1) / 2 - P.cy) * P.k;
        // too short on screen to read windows
        if (Math.hypot(ox, oy) * v.scale < 10) continue;
        if (!onRect(sr, Math.min(x0, x1, x0 + ox, x1 + ox), Math.min(y0, y1, y0 + oy, y1 + oy), Math.max(x0, x1, x0 + ox, x1 + ox), Math.max(y0, y1, y0 + oy, y1 + oy), 1)) continue;
        budget -= epx;
        set.drawList.push(i);
      }
      if (set.drawList.length) this.facadeSets.push({ set, t, P });
      if (budget <= 0) break;
    }
  }

  /** Windows, doors and shopfronts on a wall set's chosen pieces. Per piece, the transform maps
   *  (u metres along its edge, storey) onto the wall, with the vertical axis taken at the edge's
   *  midpoint; the filled shape is the exact wall region in that space, which widens by
   *  (u - L/2)·k per storey (true perspective scales the roof about the camera). Pieces of one
   *  edge share its frame, so window columns line up across a party-wall break. */
  private drawFacade(ctx: CanvasRenderingContext2D, set: WallSet, t: Tier, P: Proj, night: number, base: DOMMatrix) {
    const style = set.facade!;
    const lit = night > 0.3;
    // bake this set's 3 variants once (day/night) instead of hitting the Facades pattern
    // cache (string keys + Map.get) on every piece, every frame
    if (!set.facadeCache || set.facadeCache.lit !== lit) {
      const upper: CanvasPattern[] = [], door: CanvasPattern[] = [], shop: CanvasPattern[] = [];
      for (let variant = 0; variant < 3; variant++) {
        upper.push(facadeTexture(style, set.wall, variant, lit));
        door.push(groundTexture(style, set.wall, variant, lit, false));
        shop.push(groundTexture(style, set.wall, variant, lit, true));
      }
      set.facadeCache = { lit, upper, door, shop };
      if (lit && !set.glowCache) {
        const gu: (CanvasPattern | null)[] = [], gd: (CanvasPattern | null)[] = [], gs: (CanvasPattern | null)[] = [];
        for (let variant = 0; variant < 3; variant++) {
          gu.push(facadeGlow(style, set.wall, variant));
          gd.push(groundGlow(style, set.wall, variant, false));
          gs.push(groundGlow(style, set.wall, variant, true));
        }
        set.glowCache = { upper: gu, door: gd, shop: gs };
      }
    }
    const { upper, door, shop: shopTex } = set.facadeCache;
    const sun = this.atmos.sunDir;
    const pc = set.pieces, levels = t.levels;
    for (const i of set.drawList) {
      const low = this.facadePiece(ctx, base, pc, i, P, levels);
      const variant = pc[i + 10];
      if (levels > Math.max(1, low)) {
        ctx.fillStyle = upper[variant];
        this.facadeQuad(ctx, pc, i, P, levels, Math.max(1, low), levels);
        ctx.fill();
      }
      if (low === 0) {
        ctx.fillStyle = pc[i + 11] ? shopTex[variant] : door[variant];
        this.facadeQuad(ctx, pc, i, P, levels, 0, Math.min(1, levels));
        ctx.fill();
      }
      // Lambert shading on top so the baked tile still reads sun direction (skip the extra
      // fill where it would barely register)
      const lambert = Math.max(0, pc[i + 4] * sun.x + pc[i + 5] * sun.y);
      const shadeAlpha = (0.5 - lambert) * 0.5;
      if (Math.abs(shadeAlpha) > 0.04) {
        ctx.fillStyle = shadeAlpha >= 0 ? SHADE_DARK[Math.round(shadeAlpha * 255)] : SHADE_LIGHT[Math.round(-shadeAlpha * 0.6 * 255)];
        this.facadeQuad(ctx, pc, i, P, levels, low, levels);
        ctx.fill();
      }
    }
    ctx.setTransform(base);
  }

  /** Set the (u, storey) -> world transform for piece `i` (see drawFacade); returns the storey its
   *  visible wall starts at (0 unless it rises from a lower neighbour's roof). */
  private facadePiece(ctx: CanvasRenderingContext2D, m: DOMMatrix, pc: Float32Array, i: number, P: Proj, levels: number) {
    const ax = pc[i], ay = pc[i + 1], ux = pc[i + 2], uy = pc[i + 3], half = pc[i + 6] / 2;
    const f = P.k / levels;
    const vx = (ax + ux * half - P.cx) * f, vy = (ay + uy * half - P.cy) * f;
    ctx.setTransform(m.a * ux + m.c * uy, m.b * ux + m.d * uy, m.a * vx + m.c * vy, m.b * vx + m.d * vy, m.a * ax + m.c * ay + m.e, m.b * ax + m.d * ay + m.f);
    return pc[i + 9] / STOREY;
  }

  /** Path of piece `i`'s wall between storeys lv0 and lv1, in the facadePiece space. */
  private facadeQuad(ctx: CanvasRenderingContext2D, pc: Float32Array, i: number, P: Proj, levels: number, lv0: number, lv1: number) {
    const u0 = pc[i + 7], u1 = pc[i + 8], half = pc[i + 6] / 2;
    const f0 = (P.k * lv0) / levels, f1 = (P.k * lv1) / levels;
    ctx.beginPath();
    ctx.moveTo(u0 + (u0 - half) * f0, lv0);
    ctx.lineTo(u1 + (u1 - half) * f0, lv0);
    ctx.lineTo(u1 + (u1 - half) * f1, lv1);
    ctx.lineTo(u0 + (u0 - half) * f1, lv1);
    ctx.closePath();
  }

  /** Zoomed-out stand-in for facades: storey lines (and lit-window dashes at night) along each
   *  tier's ground-level wall pieces, lifted to each storey's height. The roofs drawn next hide
   *  the parts on the far side of each building. */
  private drawStoreyLines(ctx: CanvasRenderingContext2D, t: Tier, P: Proj, v: View, night: number, base: DOMMatrix) {
    const d = Math.hypot((t.bbox.x0 + t.bbox.x1) / 2 - v.camX, (t.bbox.y0 + t.bbox.y1) / 2 - v.camY);
    const wallPx = d * P.k * v.scale;
    if (wallPx < 10) return;
    const rows = Math.min(t.levels, 5);
    ctx.strokeStyle = 'rgba(30,26,22,0.16)';
    for (let k = 1; k < rows; k++) {
      const s = 1 + kAt((t.h * k) / rows, P.camH);
      this.roofTransform(ctx, base, P.cx, P.cy, s);
      ctx.lineWidth = 0.12 / s;
      ctx.stroke(t.storeys!);
    }
    if (night > 0.3 && t.seed < 0.6) {
      ctx.lineCap = 'butt';
      ctx.strokeStyle = `rgba(255,214,140,${Math.min(0.85, (night - 0.3) * 1.5)})`;
      ctx.setLineDash([0.9, 2.6]);
      for (let k = 0; k < rows; k++) {
        const s = 1 + kAt((t.h * (k + 0.5)) / rows, P.camH);
        this.roofTransform(ctx, base, P.cx, P.cy, s);
        ctx.lineWidth = Math.min(0.55, (d * P.k) / rows * 0.35) / s;
        ctx.lineDashOffset = t.seed * 3 + k * 1.3;
        ctx.stroke(t.storeys!);
      }
      ctx.setLineDash([]);
      ctx.lineCap = 'round';
    }
    ctx.setTransform(base);
  }

  /** Small brand/shop sign boards on the ground floor of a wall, drawn with the walls (so taller
   *  buildings drawn later still cover them), only on walls facing the camera. */
  private drawSigns(ctx: CanvasRenderingContext2D, set: WallSet, P: Proj, v: View) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fs = 0.62;
    ctx.font = `800 ${fs}px system-ui, sans-serif`;
    for (const s of set.signs) {
      if (s.x < v.x0 - 20 || s.x > v.x1 + 20 || s.y < v.y0 - 20 || s.y > v.y1 + 20) continue;
      if ((s.x - P.cx) * s.nx + (s.y - P.cy) * s.ny >= 0) continue; // faces away from the camera
      const t = 0.55 + hash01((s.x * 53) | 0, (s.y * 97) | 0) * 0.3; // 0.55-0.85 up the ground floor
      const k = kAt(t * STOREY, P.camH);
      const px = s.x + (s.x - P.cx) * k, py = s.y + (s.y - P.cy) * k;
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

  /** Overlay colour per roof-slope direction bucket (see Tier.slopes): slopes facing the light
   *  brighten, slopes facing away darken. By day the light is the sun; at night a fixed moonlight
   *  from the north-west keeps roofs readable. */
  private slopeShades(): (string | null)[] {
    const day = this.atmos.daylight, sun = this.atmos.sunDir;
    let lx = sun.x * day + MOON.x * (1 - day), ly = sun.y * day + MOON.y * (1 - day);
    const l = Math.hypot(lx, ly) || 1;
    (lx /= l), (ly /= l);
    const out: (string | null)[] = [];
    for (let d = 0; d < 8; d++) {
      const a = (d * Math.PI) / 4;
      const dot = Math.cos(a) * lx + Math.sin(a) * ly;
      out.push(dot < -0.05 ? SHADE_DARK[Math.round(-dot * 0.3 * 255)] : dot > 0.05 ? SHADE_LIGHT[Math.round(dot * 0.14 * 255)] : null);
    }
    return out;
  }

  /** One tier's roofs, drawn in its roof transform (already set): fills, slope shading, hip lines,
   *  chimneys, flat-roof parapets and details, then the eave outline. */
  private drawTierRoof(ctx: CanvasRenderingContext2D, t: Tier, P: Proj, v: View, base: DOMMatrix, slopeShade: (string | null)[]) {
    const tex = v.scale > 7.5;
    for (const r of t.roofs) {
      ctx.fillStyle = tex && r.tex ? r.tex : r.color;
      ctx.fill(r.path, 'evenodd');
    }
    const inv = 1 / P.s;
    if (v.scale > 2.5) {
      for (let d = 0; d < 8; d++) {
        const p = t.slopes[d], sh = slopeShade[d];
        if (!p || !sh) continue;
        ctx.fillStyle = sh;
        ctx.fill(p);
      }
    }
    if (v.scale > 5) {
      if (t.hips) {
        ctx.strokeStyle = 'rgba(255,240,220,0.14)';
        ctx.lineWidth = 0.12 * inv;
        ctx.stroke(t.hips);
      }
      if (t.ridge) {
        ctx.strokeStyle = 'rgba(255,235,215,0.22)';
        ctx.lineWidth = 0.22 * inv;
        ctx.stroke(t.ridge);
      }
      if (t.chimneys) {
        // chimney pots: shadow then brick-coloured box
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        this.roofTransform(ctx, base, P.cx, P.cy, P.s, 0.15, 0.2);
        ctx.fill(t.chimneys);
        this.roofTransform(ctx, base, P.cx, P.cy, P.s);
        ctx.fillStyle = '#6b5850';
        ctx.fill(t.chimneys);
      }
      if (t.flatOutline) {
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 0.4 * inv;
        ctx.stroke(t.flatOutline);
        ctx.strokeStyle = 'rgba(0,0,0,0.12)';
        ctx.lineWidth = 0.16 * inv;
        ctx.stroke(t.flatOutline);
      }
      if (t.roofDetail) {
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        this.roofTransform(ctx, base, P.cx, P.cy, P.s, 0.25, 0.3);
        ctx.fill(t.roofDetail);
        this.roofTransform(ctx, base, P.cx, P.cy, P.s);
        ctx.fillStyle = '#7d8084';
        ctx.fill(t.roofDetail);
      }
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 0.35 * inv;
    ctx.stroke(t.outline);
  }

  /** Redraw lit windows/shopfronts additively, on top of the night light-map composite
   *  (call once, right after `LightLayer.composite`) so they glow instead of getting
   *  darkened along with the rest of the world by that multiply pass. Replays exactly the
   *  facade pieces `drawBuildings` drew this frame, so the glow lines up window-for-window. */
  drawNightWindows(ctx: CanvasRenderingContext2D, v: View) {
    const night = this.atmos.night;
    if (night < 0.28 || v.scale <= 6 || !this.facades || !this.facadeSets.length) return;
    let budget = 40000;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(0.85, (night - 0.28) * 1.3);
    const base = ctx.getTransform();
    for (const { set, t, P } of this.facadeSets) {
      if (!set.glowCache) continue;
      const { upper, door, shop: shopTex } = set.glowCache;
      const pc = set.pieces, levels = t.levels;
      for (const i of set.drawList) {
        const variant = pc[i + 10];
        const low = pc[i + 9] / STOREY;
        const up = levels > Math.max(1, low) ? upper[variant] : null;
        const ground = low === 0 ? (pc[i + 11] ? shopTex[variant] : door[variant]) : null;
        budget -= (pc[i + 8] - pc[i + 7]) * v.scale;
        // variants without any lit glass have no glow tile: nothing to add
        if (up || ground) {
          this.facadePiece(ctx, base, pc, i, P, levels);
          if (up) {
            ctx.fillStyle = up;
            this.facadeQuad(ctx, pc, i, P, levels, Math.max(1, low), levels);
            ctx.fill();
          }
          if (ground) {
            ctx.fillStyle = ground;
            this.facadeQuad(ctx, pc, i, P, levels, 0, Math.min(1, levels));
            ctx.fill();
          }
        }
        if (budget <= 0) break;
      }
      if (budget <= 0) break;
    }
    ctx.setTransform(base);
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

  /** Rooftop ads of one tier, in its roof transform (already set). */
  private drawAds(ctx: CanvasRenderingContext2D, t: Tier, P: Proj, v: View, base: DOMMatrix) {
    for (const a of t.ads) {
      if (!bboxHit(a.b.bbox, v)) continue;
      ctx.save();
      ctx.translate(a.b.cx, a.b.cy);
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
      for (const t of c.tiers) {
        if (!t.shadow || (sunMoved && t.shadowKey !== sunKey && budget > 0)) {
          t.shadow = this.buildShadow(t, sdx, sdy);
          t.shadowKey = sunKey;
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
      for (const c of vis) for (const t of c.tiers) merged.addPath(t.shadow!);
      this.shadowMerged = merged;
      this.shadowVisKey = visKey;
    }
    ctx.fillStyle = `rgba(20,25,45,${alpha})`;
    ctx.fill(this.shadowMerged);
  }

  private buildShadow(t: Tier, sdx: number, sdy: number): Path2D {
    const ox = sdx * t.h, oy = sdy * t.h;
    const p = new Path2D();
    for (const pts of t.rings) {
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
        if (c.nBuildings && L.visible(c.cx, c.cy, 45)) {
          L.point(c.cx, c.cy, 42, '#ffb26b', Math.min(0.3, c.nBuildings * 0.018) * night);
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
      for (const t of c.tiers)
        for (const r of t.roofs) {
          ctx.fillStyle = r.color;
          ctx.fill(r.path, 'evenodd');
        }
  }
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
