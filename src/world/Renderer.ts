import { BARRIERS, POSTS, deckLevel, type World, type Building } from '../shared/world/World';
import { bboxOf, bboxHit, rng, pointInRings, type BBox } from '../shared/util/math';
import { ROOF_ADS, BRAND_COLORS } from '../data/brands';
import { Atmosphere } from './Atmosphere';
import type { LightLayer } from './Lighting';
import { texture, animateWater, type TexKind } from './Textures';
import { facadeTexture, groundTexture, facadeGlow, groundGlow, type FacadeStyle } from './Facades';
import { STOREY, WP, hash01, heightBin, roofSlopes, wallPieces } from './BuildingGeometry';
import { StreetDetail } from './StreetDetail';

const CHUNK = 128;

/** `tex` (a pattern baked over `color`) replaces `color` when zoomed in enough to see it */
type DrawOp =
  | { kind: 'fill'; color: string; tex?: CanvasPattern }
  | { kind: 'stroke'; color: string; width: number; dash?: number[]; tex?: CanvasPattern; cap?: CanvasLineCap };

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
  /** spires, pyramids, domes and onions on top of this tier's walls */
  special?: SpecialRoof[];
  /** the tallest of them (m), for culling */
  spireH?: number;
}

/** A raised roof on a building's walls: 4 pyramid, 5 dome, 6 onion, 9 cone (spire), `rh` metres tall. */
interface SpecialRoof {
  b: Building;
  shape: number;
  rh: number;
  color: string;
}

/** How tall a raised roof is when the map doesn't say: from the size of the footprint. */
function defaultRoofH(b: Building, shape: number) {
  const r = Math.sqrt(b.area / Math.PI);
  return shape === 9 ? Math.min(30, r * 2.4) : shape === 4 ? Math.min(14, r * 0.9) : shape === 6 ? Math.min(12, r * 1.6) : Math.min(16, r * 0.85);
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
  /** walls, fences and hedges by barrier kind (see World.BARRIERS) */
  barriers?: (Path2D | undefined)[];
  /** bollards, blocks, planters, statues and columns: flat x, y, radius, kind (see World.POSTS) */
  posts?: number[];
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
  pier: '#8a7f70',
};
const AREA_ORDER = ['plaza', 'parking', 'rail', 'pitch', 'sand', 'green', 'wood', 'water', 'pier'];
const AREA_TEX: Partial<Record<string, TexKind>> = { plaza: 'cobble', green: 'grass', pitch: 'grass', wood: 'wood', sand: 'sand', parking: 'asphalt', water: 'water' };

const ROAD_FILL = ['#3f4045', '#414247', '#45464b', '#47484d', '#4a4b50', '#4d4e52', '#555558', '#58595c', '#d6ccb4', '#c8bca1', '#a69a7f'];
const ROAD_CASING = ['#77746d', '#77746d', '#807d76', '#807d76', '#84817a', '#87847d', '#948f87', '#948f87', '#bcb096', '', ''];

const ROOFS = ['#b0583a', '#a04d33', '#b86b4b', '#8b8580', '#7b7772', '#6a6d72', '#94613f', '#b2a28e'];
const FLAT_ROOFS = ['#9fa2a5', '#b3b4b3', '#8e9196', '#a7a39b'];
/** warm pastel Central-European facade palette, replacing the old single brown wall */
const OLD_WALLS = ['#d9c9a8', '#e3d3b4', '#cdb89a', '#e6dcc8', '#c9b79c', '#d8c3a5', '#bfb2a0'];

/** traffic light lamps: green, amber, red */
const SIGNAL_LAMP = ['#39e36b', '#ffb300', '#ff3d2e'];

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

/** Facade signs for the map's places, by kind: [label, board colour, text colour] (museums,
 *  theatres and libraries show their own name when it fits) */
const PLACE_SIGNS: Record<string, [string, string, string]> = {
  food: ['Reštaurácia', '#6d2c1f', '#ffe0b2'],
  cafe: ['Kaviareň', '#4e342e', '#ffcc80'],
  bar: ['Bar', '#263238', '#ffca28'],
  pharmacy: ['✚ Lekáreň', '#00897b', '#ffffff'],
  museum: ['Múzeum', '#37474f', '#eceff1'],
  theatre: ['Divadlo', '#4a148c', '#ffffff'],
  hotel: ['Hotel', '#1a237e', '#ffd54f'],
  grocery: ['Potraviny', '#2e7d32', '#ffffff'],
  bakery: ['Pekáreň', '#f9a825', '#3e2723'],
  bank: ['Banka', '#0d47a1', '#ffffff'],
  post: ['Pošta', '#ef8a1e', '#1b3f8b'],
  library: ['Knižnica', '#5d4037', '#ffffff'],
};

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

/** the deck level (1 or 2) of a layer that belongs to a bridge deck (drawn in `drawBridges`, not
 *  `drawGround`), or 0 for a ground layer */
function isBridgeLayer(key: string): 0 | 1 | 2 {
  const m = /^(?:bc|br|f|m|edge|kerb|rl)([12])/.exec(key);
  return m ? (+m[1] as 1 | 2) : 0;
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
  /** bridge deck polylines and their levels, for the railings drawn by `drawBridges` */
  private bridges: { p: Float32Array; hw: number; bbox: BBox; level: 1 | 2 }[] = [];
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
  /** big in-world text: facade signs (shopfront/museum/theatre/library names), rooftop ad
   *  billboards, and (via StreetDetail) tram-stop-name plates. Real names are place-identifying;
   *  even a generic ad billboard can fill most of a close-up frame. Off for the "Kde to je?" photo
   *  mode (src/game/features/PhotoMode.ts); on (unaffected by `facades`) for ordinary play. */
  labels = true;
  /** signs, gates and street furniture, drawn each frame */
  street: StreetDetail;

  constructor(private world: World) {
    this.street = new StreetDetail(world);
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
      for (const rings of w.data.areas[kind as keyof typeof w.data.areas] ?? []) {
        const c = this.chunkAt(bboxOf(rings[0]), map);
        const col = AREA_COLORS[kind];
        const p = this.path(c, 'a:' + kind, { kind: 'fill', color: col, tex: tex && texture(tex, col) }, i);
        for (const r of rings) addPoly(p, r, true);
        if (kind === 'water') {
          const edge = this.path(c, 'a:water:edge', { kind: 'stroke', color: 'rgba(220,240,255,0.35)', width: 0.5 }, i + 0.6);
          for (const r of rings) addPoly(edge, r, true);
        }
        if (kind === 'pier') {
          // deck boards and the dark rim of a pontoon or pier
          const planks = this.path(c, 'a:pier:planks', { kind: 'stroke', color: 'rgba(60,48,36,0.25)', width: 0.08 }, i + 0.3);
          const bb = bboxOf(rings[0]);
          for (let y = Math.floor(bb.y0) + 0.5; y < bb.y1; y += 0.9) {
            planks.moveTo(bb.x0, y);
            planks.lineTo(bb.x1, y);
          }
          const edge = this.path(c, 'a:pier:edge', { kind: 'stroke', color: '#4d4338', width: 0.35 }, i + 0.6);
          for (const r of rings) addPoly(edge, r, true);
        }
      }
    });

    // roads: casing, asphalt/cobble fill + grain overlay
    for (const r of w.data.roads) {
      // 0 on the ground, else the deck's level: upper decks draw over the lower ones
      const bridge = r.b ? deckLevel(r) : 0;
      const wq = Math.round(r.w * 2) / 2;
      const base = 100 + bridge * 100;
      const c = this.chunkAt(bboxOf(r.p, r.w), map);
      if (bridge) {
        addPoly(this.path(c, `bc${bridge}:${wq}`, { kind: 'stroke', color: '#2b2b2e', width: wq + 3 }, base + 1), r.p, false);
        addPoly(this.path(c, `br${bridge}:${wq}`, { kind: 'stroke', color: '#8f8b84', width: wq + 1.6 }, base + 2), r.p, false);
        this.bridges.push({ p: Float32Array.from(r.p), hw: r.w / 2, bbox: bboxOf(r.p, r.w / 2 + 1), level: bridge });
      } else if (ROAD_CASING[r.c]) {
        addPoly(this.path(c, `c:${r.c}:${wq}`, { kind: 'stroke', color: ROAD_CASING[r.c], width: wq + 1.6 }, base + 10 - r.c * 0.1), r.p, false);
      }
      // car streets paved with granite setts (the Old Town) or concrete pavers look it
      const paving = r.c <= 7 ? r.s ?? 0 : 0;
      const fill = paving === 1 ? '#6f6a63' : paving === 2 ? '#7c7872' : ROAD_FILL[r.c];
      const tex = texture(r.c >= 8 || paving === 1 ? 'cobble' : paving === 2 ? 'pavers' : 'asphalt', fill);
      addPoly(this.path(c, `f${bridge}:${r.c}:${wq}:${paving}`, { kind: 'stroke', color: fill, width: wq, tex }, base + 30 - r.c * 0.1 + paving * 0.01), r.p, false);
      const lanes = r.c <= 7 ? r.l ?? 0 : 0;
      if (lanes >= 2 && r.w / lanes >= 2.4) this.laneMarkings(c, r.p, r.w, lanes, r.o ?? 0, r.lf, bridge, base);
      else if (r.c <= 5 && r.w >= 7) {
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

    // raised traffic islands: grass or paving inside a light kerb, with a dark lip where it drops
    // to the road
    w.islands.rings.forEach((ring, i) => {
      const c = this.chunkAt(bboxOf(ring, 1), map);
      const grass = w.islands.grass[i];
      const col = grass ? '#7fa35a' : '#b9b2a3';
      addPoly(this.path(c, grass ? 'isl:grass' : 'isl:paved', { kind: 'fill', color: col, tex: texture(grass ? 'grass' : 'pavers', col) }, 157), ring, true);
      addPoly(this.path(c, 'isl:lip', { kind: 'stroke', color: 'rgba(25,24,22,0.45)', width: 0.42 }, 157.5), ring, true);
      addPoly(this.path(c, 'isl:kerb', { kind: 'stroke', color: '#dcd6c8', width: 0.24 }, 158), ring, true);
    });
    // bridge piers standing on the river bank and in the water (the decks are drawn over them)
    for (const ring of w.data.supports ?? []) {
      const c = this.chunkAt(bboxOf(ring, 1), map);
      addPoly(this.path(c, 'sup:fill', { kind: 'fill', color: '#8f8b83', tex: texture('concrete', '#8f8b83') }, 156), ring, true);
      addPoly(this.path(c, 'sup:edge', { kind: 'stroke', color: 'rgba(30,30,30,0.5)', width: 0.2 }, 156.5), ring, true);
    }
    // speed bumps (black and yellow), raised tables (a paler hump with white triangles on its
    // ramps), speed cushions (red pads in each lane) and rumble strips
    {
      const d = w.bumps.data;
      for (let i = 0; i < w.bumps.n; i++) {
        const x = d[i * 6], y = d[i * 6 + 1], ux = d[i * 6 + 2], uy = d[i * 6 + 3], hw = d[i * 6 + 4] - 0.25, kind = d[i * 6 + 5];
        const nx = -uy, ny = ux;
        const c = this.chunkAt({ x0: x - hw - 4, y0: y - hw - 4, x1: x + hw + 4, y1: y + hw + 4 }, map);
        const across = (path: Path2D, along: number) => {
          path.moveTo(x + ux * along - nx * hw, y + uy * along - ny * hw);
          path.lineTo(x + ux * along + nx * hw, y + uy * along + ny * hw);
        };
        if (kind === 0) {
          across(this.path(c, 'bump:base', { kind: 'stroke', color: '#2b2a28', width: 0.6, cap: 'butt' }, 255), 0);
          across(this.path(c, 'bump:stripe', { kind: 'stroke', color: '#f0c02e', width: 0.6, dash: [0.5, 0.5], cap: 'butt' }, 255.1), 0);
        } else if (kind === 1) {
          const t = this.path(c, 'table:fill', { kind: 'fill', color: 'rgba(214,204,188,0.5)' }, 254);
          t.moveTo(x - ux * 3 - nx * hw, y - uy * 3 - ny * hw);
          t.lineTo(x + ux * 3 - nx * hw, y + uy * 3 - ny * hw);
          t.lineTo(x + ux * 3 + nx * hw, y + uy * 3 + ny * hw);
          t.lineTo(x - ux * 3 + nx * hw, y - uy * 3 + ny * hw);
          t.closePath();
          // white triangles on both ramps, pointing up the ramp
          const tri = this.path(c, 'table:tri', { kind: 'fill', color: 'rgba(245,244,238,0.85)' }, 254.1);
          for (const s of [-1, 1])
            for (let o = -hw + 0.6; o <= hw - 0.6; o += 1.4) {
              const bx = x + ux * s * 3 + nx * o, by = y + uy * s * 3 + ny * o;
              tri.moveTo(bx - nx * 0.4, by - ny * 0.4);
              tri.lineTo(bx + nx * 0.4, by + ny * 0.4);
              tri.lineTo(bx - ux * s * 0.9, by - uy * s * 0.9);
              tri.closePath();
            }
        } else if (kind === 2) {
          const pad = this.path(c, 'cushion', { kind: 'fill', color: '#9c4a36' }, 254);
          for (const o of [-hw / 2, hw / 2]) {
            const bx = x + nx * o, by = y + ny * o;
            pad.moveTo(bx - ux * 1.5 - nx * 0.85, by - uy * 1.5 - ny * 0.85);
            pad.lineTo(bx + ux * 1.5 - nx * 0.85, by + uy * 1.5 - ny * 0.85);
            pad.lineTo(bx + ux * 1.5 + nx * 0.85, by + uy * 1.5 + ny * 0.85);
            pad.lineTo(bx - ux * 1.5 + nx * 0.85, by - uy * 1.5 + ny * 0.85);
            pad.closePath();
          }
        } else {
          const r = this.path(c, 'rumble', { kind: 'stroke', color: 'rgba(240,238,230,0.75)', width: 0.12, cap: 'butt' }, 255);
          for (let a = -1.2; a <= 1.2; a += 0.6) across(r, a);
        }
      }
    }
    // stop lines with STOP, and give-way "shark's teeth", across the approach half of the street
    for (const m of w.marks.signs) {
      const nx = -m.uy, ny = m.ux, hw = Math.max(1.5, m.hw - 0.2);
      const c = this.chunkAt({ x0: m.x - hw - 3, y0: m.y - hw - 3, x1: m.x + hw + 3, y1: m.y + hw + 3 }, map);
      if (m.kind === 0) {
        const l = this.path(c, 'stop:line', { kind: 'stroke', color: 'rgba(245,244,238,0.9)', width: 0.5, cap: 'butt' }, 259);
        l.moveTo(m.x + nx * 0.15, m.y + ny * 0.15);
        l.lineTo(m.x + nx * hw, m.y + ny * hw);
      } else {
        const tri = this.path(c, 'yield:tri', { kind: 'fill', color: 'rgba(245,244,238,0.9)' }, 259);
        for (let o = 0.5; o <= hw - 0.3; o += 0.9) {
          const bx = m.x + nx * o, by = m.y + ny * o;
          // the base on the line, the point toward the oncoming driver
          tri.moveTo(bx - nx * 0.28, by - ny * 0.28);
          tri.lineTo(bx + nx * 0.28, by + ny * 0.28);
          tri.lineTo(bx - m.ux * 0.7, by - m.uy * 0.7);
          tri.closePath();
        }
      }
    }

    // zebra crossings: the real marked crossings where the map has them (else where >= 3 car
    // roads meet): bars across the street, 0.5 m apart and 3 m deep, like the painted ones
    if (w.data.crossings) {
      const cr = w.data.crossings;
      for (let i = 0; i < cr.length; i += 4) {
        const x = cr[i], y = cr[i + 1], a = cr[i + 2], hw = Math.min(cr[i + 3] / 2, 9);
        const nx = -Math.sin(a), ny = Math.cos(a);
        const c = this.chunkAt({ x0: x - hw, y0: y - hw, x1: x + hw, y1: y + hw }, map);
        const zebra = this.path(c, 'z:zebra', { kind: 'stroke', color: 'rgba(236,233,222,0.88)', width: 3, dash: [0.5, 0.5], cap: 'butt' }, 260);
        zebra.moveTo(x - nx * hw * 0.9, y - ny * hw * 0.9);
        zebra.lineTo(x + nx * hw * 0.9, y + ny * hw * 0.9);
      }
    } else {
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

    // railway tracks: ballast, sleepers and two rails at 1.435 m gauge (bridges with the decks)
    for (const rl of w.data.rails ?? []) {
      const b = rl.b ? 1 : 0;
      const c = this.chunkAt(bboxOf(rl.p, 3), map);
      if (b) {
        addPoly(this.path(c, 'bc1:rail', { kind: 'stroke', color: '#2b2b2e', width: 5.4 }, 201), rl.p, false);
        addPoly(this.path(c, 'br1:rail', { kind: 'stroke', color: '#7d776d', width: 4.6 }, 202), rl.p, false);
        this.bridges.push({ p: Float32Array.from(rl.p), hw: 2.3, bbox: bboxOf(rl.p, 3.5), level: 1 });
      } else addPoly(this.path(c, 'rl0:bed', { kind: 'stroke', color: '#8a8276', width: 3 }, 255), rl.p, false);
      addPoly(this.path(c, `rl${b}:sleepers`, { kind: 'stroke', color: '#5b4a3b', width: 2.3, dash: [0.24, 0.36], cap: 'butt' }, 256 + b * 100), rl.p, false);
      addPoly(this.path(c, `rl${b}:railL`, { kind: 'stroke', color: '#2a2a2d', width: 0.12 }, 257 + b * 100), offsetPolyline(rl.p, 0.72), false);
      addPoly(this.path(c, `rl${b}:railR`, { kind: 'stroke', color: '#2a2a2d', width: 0.12 }, 257 + b * 100), offsetPolyline(rl.p, -0.72), false);
    }

    // street lamps: the real ones, then every ~28 m along car roads (class <= 6), one side of the
    // road, wherever the map has none within ~22 m
    const LG = 32;
    const lampGrid = new Map<number, number[]>();
    const addLamp = (lx: number, ly: number) => {
      const c = this.chunkAt({ x0: lx, y0: ly, x1: lx, y1: ly }, map);
      (c.lamps ??= []).push(lx, ly);
      const lp = (c.lampPath ??= new Path2D());
      lp.moveTo(lx + 0.45, ly);
      lp.arc(lx, ly, 0.45, 0, Math.PI * 2);
      lp.moveTo(lx + 0.12, ly);
      lp.arc(lx, ly, 0.12, 0, Math.PI * 2);
    };
    const realLamps = w.data.lamps;
    if (realLamps)
      for (let i = 0; i < realLamps.length; i += 2) {
        const lx = realLamps[i], ly = realLamps[i + 1];
        addLamp(lx, ly);
        const k = Math.floor(lx / LG) * 4096 + Math.floor(ly / LG);
        let g = lampGrid.get(k);
        if (!g) lampGrid.set(k, (g = []));
        g.push(lx, ly);
      }
    const lampNear = (x: number, y: number, r: number) => {
      for (let gx = Math.floor((x - r) / LG); gx <= Math.floor((x + r) / LG); gx++)
        for (let gy = Math.floor((y - r) / LG); gy <= Math.floor((y + r) / LG); gy++) {
          const g = lampGrid.get(gx * 4096 + gy);
          if (g) for (let i = 0; i < g.length; i += 2) if ((g[i] - x) ** 2 + (g[i + 1] - y) ** 2 < r * r) return true;
        }
      return false;
    };
    for (const r of w.data.roads) {
      if (r.c > 6) continue;
      walkPolyline(r.p, 28, hash01(r.p[0] | 0, r.p[1] | 0) * 20, (x, y, nx, ny) => {
        const off = r.w / 2 + 0.8;
        const lx = x + nx * off, ly = y + ny * off;
        if (realLamps && lampNear(lx, ly, 22)) return;
        addLamp(lx, ly);
      });
    }

    // trees (World.trees: the real ones, then woods and parks filled in)
    const tr = w.trees;
    for (let i = 0; i < tr.length; i += 4) {
      const x = tr[i], y = tr[i + 1], rad = tr[i + 2];
      const c = this.chunkAt({ x0: x, y0: y, x1: x, y1: y }, map);
      const t = (c.trees ??= { shadow: new Path2D(), canopy: [new Path2D(), new Path2D(), new Path2D(), new Path2D()], highlight: new Path2D() });
      const tone = (rng(tr[i + 3])() * 4) | 0;
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
    }

    // walls, fences and hedges (drawn with their shadows in `drawBarriers`)
    for (const bar of w.data.barriers ?? []) {
      const c = this.chunkAt(bboxOf(bar.p, 1), map);
      const list = (c.barriers ??= []);
      addPoly((list[bar.k] ??= new Path2D()), bar.p, false);
    }
    // bollards, blocks, planters and monuments (`drawPosts`, `drawPostTops`)
    const posts = w.data.posts ?? [];
    for (let i = 0; i < posts.length; i += 4) {
      const x = posts[i], y = posts[i + 1];
      (this.chunkAt({ x0: x, y0: y, x1: x, y1: y }, map).posts ??= []).push(x, y, posts[i + 2], posts[i + 3]);
    }

    this.buildBuildings(map);
  }

  /** The marked lanes of a street: dashed lines between lanes that go the same way, and a solid
   *  line (a double one on the big roads) between the two directions. Forward lanes are on the
   *  right of the way's direction. */
  private laneMarkings(c: Chunk, p: ArrayLike<number>, width: number, lanes: number, oneway: number, split: [number, number] | undefined, deck: number, base: number) {
    const lw = width / lanes, hw = width / 2;
    let fwd = oneway === 1 ? lanes : oneway === -1 ? 0 : split?.[0] || (split?.[1] ? lanes - split[1] : (lanes + 1) >> 1);
    fwd = Math.max(0, Math.min(lanes, fwd));
    const back = lanes - fwd;
    const dashed = this.path(c, `m${deck}:lane`, { kind: 'stroke', color: 'rgba(255,255,255,0.55)', width: 0.15, dash: [3, 5] }, base + 50);
    const solid = this.path(c, `m${deck}:solid`, { kind: 'stroke', color: 'rgba(250,250,245,0.8)', width: 0.14 }, base + 50.2);
    const line = (path: Path2D, off: number) => {
      const q = offsetPolyline(p, off);
      path.moveTo(q[0], q[1]);
      for (let i = 2; i < q.length; i += 2) path.lineTo(q[i], q[i + 1]);
    };
    for (let i = 1; i < lanes; i++) {
      const off = -hw + i * lw;
      if (i === back && back > 0 && fwd > 0) {
        // between the directions
        if (lanes >= 4) (line(solid, off - 0.12), line(solid, off + 0.12));
        else line(solid, off);
      } else line(dashed, off);
    }
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
      // the Most SNP pylon and its UFO are drawn by the game as one structure (Game.drawLandmarks);
      // a building mapped in 3D is drawn as its parts instead of its outline
      if (b.kind === 5 || b.hidden) continue;
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
      // the map's own colours and roof shape win over the guesses
      if (b.color) roof = b.color;
      if (b.wallColor) wall = b.wallColor;
      const shape = b.roofShape;
      if (b.kind === 6) (wall = b.wallColor ?? '#e9e6df'), (roof = b.color ?? '#dcd8cf'), (flat = true);
      if (shape === 1 || shape === 7 || shape === 8 || shape === 10) flat = true;
      else if (shape === 2 || shape === 3) flat = false;
      // a spire, pyramid, dome or onion sits on top of the walls (drawn in `drawSpecialRoofs`)
      const special = shape === 4 || shape === 5 || shape === 6 || shape === 9;
      const pitched = !flat && !special && b.kind !== 4;

      // facade style: churches/castles are always baroque-ish; otherwise by height,
      // then Old Town proximity, then a coin flip between panel and office/industrial
      let facade: FacadeStyle | undefined;
      if (b.kind !== 4 && b.kind !== 6) {
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
      // ground shadow from the footprint up (a raised structure's own small shadow is left out,
      // but a building part standing on the rest of its building casts one)
      if (!b.minH || b.part) t.rings.push(...b.rings);
      if (special) {
        const rh = b.roofH > 0 ? b.roofH : defaultRoofH(b, shape);
        (t.special ??= []).push({ b, shape, rh, color: roof });
        if (rh > 0) t.spireH = Math.max(t.spireH ?? 0, rh);
      }

      // walls: only the exposed parts (party walls hidden, or starting at a lower neighbour's roof);
      // an inverted pyramid's walls are all under its own overhang, out of sight from above
      const pieces = shape === 10 ? [] : wallPieces(w, b, h);
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
              // maps without real places: Old Town shopfronts get a generic label (Potraviny, Bar, ...)
              if (!w.data.places && facade === 'oldtown' && hash01(b.seed, 12) < 0.5 && !w.data.pois.some((p) => p.k === 'shop' && Math.hypot(p.x - mx, p.y - my) < 15)) {
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
      if (pitched && b.area > 30 && !(b.part && b.kind === 1)) {
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
          // (not on churches and castles)
          if (b.area > 70 && b.kind !== 1 && b.kind !== 2) {
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
      } else if (!pitched && !special && b.kind !== 4 && b.rings.length === 1 && b.area > 600) {
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

    // shop/fuel POI signs, and the real cafés, restaurants, bars, pharmacies, hotels, museums and
    // theatres: on the nearest exposed ground-floor wall piece
    const signed: { k: string; x: number; y: number; n: string }[] = [];
    for (const p of w.data.pois) if (p.k === 'shop' || p.k === 'fuel') signed.push({ k: p.k, x: p.x, y: p.y, n: p.k === 'fuel' ? `⛽ ${p.n}` : p.n });
    for (const p of w.data.places ?? []) {
      const sign = PLACE_SIGNS[p.k];
      if (!sign) continue;
      const own = p.n !== undefined && (p.k === 'museum' || p.k === 'theatre' || p.k === 'library') ? w.names[p.n] : '';
      signed.push({ k: p.k, x: p.x, y: p.y, n: own && own.length <= 28 ? own : sign[0] });
    }
    for (const p of signed) {
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
      // the sign goes where the place is along that wall (not always the middle of it)
      const L = pc[bestI + 8] - pc[bestI + 7];
      const along = (p.x - pc[bestI]) * pc[bestI + 2] + (p.y - pc[bestI + 1]) * pc[bestI + 3];
      const um = Math.max(pc[bestI + 7] + Math.min(1.5, L / 2), Math.min(pc[bestI + 8] - Math.min(1.5, L / 2), along));
      const sx = pc[bestI] + pc[bestI + 2] * um, sy = pc[bestI + 1] + pc[bestI + 3] * um;
      const set = bestSet as WallSet;
      // two places side by side share a wall: one board each, not on top of each other
      if (set.signs.some((o) => Math.hypot(o.x - sx, o.y - sy) < 3.2)) continue;
      set.signs.push({
        x: sx, y: sy, ux: pc[bestI + 2], uy: pc[bestI + 3], nx: pc[bestI + 4], ny: pc[bestI + 5],
        name: p.n, colors: BRAND_COLORS[p.n] ?? PLACE_SIGNS[p.k]?.slice(1) as [string, string] | undefined,
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
      .filter((b) => b.kind !== 1 && b.kind !== 2 && b.kind !== 4 && b.kind !== 5 && !b.hidden && !b.part && b.roofShape <= 1 && b.area > 900 && b.rings.length === 1)
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
        ctx.lineCap = op.cap ?? 'round';
      }
      for (const c of vis) {
        const p = c.layers.get(key);
        if (!p) continue;
        // pier planks run across the whole bbox: keep them on the deck
        if (key === 'a:pier:planks') {
          const deck = c.layers.get('a:pier');
          if (!deck) continue;
          ctx.save();
          ctx.clip(deck, 'evenodd');
          ctx.stroke(p);
          ctx.restore();
        } else if (op.kind === 'fill') ctx.fill(p, 'evenodd');
        else ctx.stroke(p);
      }
    }
    ctx.setLineDash([]);
    ctx.lineCap = 'round';

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
    this.drawPostTops(ctx, v);
    this.street.drawHigh(ctx, v, (x, y, h) => this.roofOffset(x, y, h, v), performance.now() / 1000);

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
      for (let k = i; k < j; k++) if (this.labels && tiers[k].ads.length) this.drawAds(ctx, tiers[k], P, v, base);
      ctx.setTransform(base);
      for (let k = i; k < j; k++) if (tiers[k].special) this.drawSpecialRoofs(ctx, tiers[k], P, v, sr);
      i = j;
    }
    ctx.restore();
  }

  /** Spires, pyramids, domes and onions on top of a tier's walls, in true perspective: every point
   *  is drawn where its own height puts it, so a spire leans away from the camera like a tower. */
  private drawSpecialRoofs(ctx: CanvasRenderingContext2D, t: Tier, P: Proj, v: View, sr: BBox | null) {
    const sun = this.atmos.sunDir, day = this.atmos.daylight;
    let lx = sun.x * day + MOON.x * (1 - day), ly = sun.y * day + MOON.y * (1 - day);
    const ll = Math.hypot(lx, ly) || 1;
    (lx /= ll), (ly /= ll);
    const cx = P.cx, cy = P.cy;
    for (const sp of t.special!) {
      const b = sp.b, bb = b.bbox;
      // a spire leans out far past its footprint: cull generously
      const lean = sp.rh * 2 + t.h * 0.5;
      if (!onRect(sr, bb.x0, bb.y0, bb.x1, bb.y1, lean)) continue;
      const ring = b.rings[0];
      const n = ring.length / 2 - 1;
      if (n < 3) continue;
      let ax = 0, ay = 0;
      for (let i = 0; i < n; i++) (ax += ring[i * 2]), (ay += ring[i * 2 + 1]);
      (ax /= n), (ay /= n);
      const k0 = P.k, k1 = kAt(t.h + sp.rh, P.camH);
      if (sp.shape === 4 || sp.shape === 9) {
        // faces from each eave edge up to the apex, far ones first
        const apx = ax + (ax - cx) * k1, apy = ay + (ay - cy) * k1;
        const faces: { i: number; d: number; lit: number }[] = [];
        for (let i = 0; i < n; i++) {
          const x0 = ring[i * 2], y0 = ring[i * 2 + 1], x1 = ring[i * 2 + 2], y1 = ring[i * 2 + 3];
          const L = Math.hypot(x1 - x0, y1 - y0) || 1;
          // outward normal (rings are wound so that (by - ay, ax - bx) points out)
          const nx = (y1 - y0) / L, ny = (x0 - x1) / L;
          faces.push({ i, d: Math.hypot((x0 + x1) / 2 - v.camX, (y0 + y1) / 2 - v.camY), lit: nx * lx + ny * ly });
        }
        faces.sort((p, q) => q.d - p.d);
        ctx.lineJoin = 'round';
        for (const f of faces) {
          const x0 = ring[f.i * 2], y0 = ring[f.i * 2 + 1], x1 = ring[f.i * 2 + 2], y1 = ring[f.i * 2 + 3];
          ctx.beginPath();
          ctx.moveTo(x0 + (x0 - cx) * k0, y0 + (y0 - cy) * k0);
          ctx.lineTo(x1 + (x1 - cx) * k0, y1 + (y1 - cy) * k0);
          ctx.lineTo(apx, apy);
          ctx.closePath();
          ctx.fillStyle = shade(sp.color, 0.78 + 0.34 * f.lit);
          ctx.fill();
          ctx.strokeStyle = 'rgba(20,20,24,0.35)';
          ctx.lineWidth = 0.08;
          ctx.stroke();
        }
        // a church spire ends in a gilded ball and cross
        if (b.kind === 1 && sp.rh > 6) {
          ctx.fillStyle = '#d9b44a';
          ctx.beginPath();
          ctx.arc(apx, apy, 0.45, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        // a dome (or an onion, which bulges and ends in a point): its outline shrunk toward the
        // centre ring by ring as it rises, shaded from the eaves up, lit toward the light
        const onion = sp.shape === 6;
        const N = 7;
        for (let j = 0; j < N; j++) {
          const th = (j / N) * (Math.PI / 2);
          const sc = onion ? Math.cos(th) * (1 + 0.45 * Math.sin(th * 2)) : Math.cos(th);
          const z = t.h + sp.rh * (onion ? 0.75 : 1) * Math.sin(th);
          const k = kAt(z, P.camH);
          // shift each ring a little toward the light for a highlight
          const hx = lx * sp.rh * 0.06 * (j / N), hy = ly * sp.rh * 0.06 * (j / N);
          ctx.beginPath();
          for (let i = 0; i <= n; i++) {
            const px = ax + (ring[i * 2] - ax) * sc + hx, py = ay + (ring[i * 2 + 1] - ay) * sc + hy;
            const qx = px + (px - cx) * k, qy = py + (py - cy) * k;
            if (i) ctx.lineTo(qx, qy);
            else ctx.moveTo(qx, qy);
          }
          ctx.closePath();
          ctx.fillStyle = shade(sp.color, 0.72 + (j / N) * 0.45);
          ctx.fill();
        }
        if (onion) {
          const apx = ax + (ax - cx) * k1, apy = ay + (ay - cy) * k1;
          const kb = kAt(t.h + sp.rh * 0.8, P.camH);
          ctx.fillStyle = shade(sp.color, 1.1);
          ctx.beginPath();
          ctx.moveTo(apx, apy);
          const r0 = Math.sqrt(b.area) * 0.08;
          ctx.lineTo(ax - r0 + (ax - r0 - cx) * kb, ay + (ay - cy) * kb);
          ctx.lineTo(ax + r0 + (ax + r0 - cx) * kb, ay + (ay - cy) * kb);
          ctx.closePath();
          ctx.fill();
        }
        // the lantern on top of a church dome
        if (b.kind === 1) {
          const k = kAt(t.h + sp.rh, P.camH);
          ctx.fillStyle = '#d9b44a';
          ctx.beginPath();
          ctx.arc(ax + (ax - cx) * k, ay + (ay - cy) * k, 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
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
      if (this.labels && v.scale > 6 && set.signs.length) this.drawSigns(ctx, set, P, v);
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
        // a gateway or passage through the building: a dark opening in the ground floor
        if (pc[i + 12] >= 0) {
          ctx.fillStyle = 'rgba(16,14,12,0.9)';
          this.facadeQuad(ctx, pc, i, P, levels, 0, Math.min(0.82, levels), pc[i + 12], pc[i + 13]);
          ctx.fill();
        }
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

  /** Path of piece `i`'s wall between storeys lv0 and lv1 (and, if given, between u0 and u1
   *  metres along its edge), in the facadePiece space. */
  private facadeQuad(ctx: CanvasRenderingContext2D, pc: Float32Array, i: number, P: Proj, levels: number, lv0: number, lv1: number, u0 = pc[i + 7], u1 = pc[i + 8]) {
    const half = pc[i + 6] / 2;
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
  /** The bridge decks of one level (1, then 2 over it once whatever is on level 1 is drawn): cast
   *  shadow, deck surface and railings. */
  drawBridges(ctx: CanvasRenderingContext2D, v: View, level: 1 | 2 = 1) {
    const vis = this.chunks.filter((c) => bboxHit(c.bbox, v));
    const keys = this.sortedBridgeLayers.filter(([k]) => isBridgeLayer(k) === level);
    if (!keys.length) return;

    // cast shadow: the casing/deck outline offset by the sun direction, dark and translucent (an
    // upper deck stands higher, so its shadow falls further)
    const daylight = this.atmos.daylight;
    if (daylight > 0.02) {
      const h = level === 2 ? 6.5 : 3.2;
      const sdx = this.atmos.sun.dx * h, sdy = this.atmos.sun.dy * h;
      ctx.save();
      ctx.translate(sdx, sdy);
      ctx.globalAlpha = Math.min(0.4, 0.32 * daylight);
      ctx.fillStyle = ctx.strokeStyle = '#0a0c14';
      for (const [key, layer] of keys) {
        if (!key.startsWith('bc')) continue;
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
    this.drawRailings(ctx, v, level);
  }

  /** Thin light railings with posts along both edges of every visible bridge deck of a level. */
  private drawRailings(ctx: CanvasRenderingContext2D, v: View, level: 1 | 2) {
    if (v.scale < 2.5) return;
    ctx.save();
    ctx.lineWidth = 0.1;
    ctx.strokeStyle = 'rgba(225,225,220,0.8)';
    for (const br of this.bridges) {
      if (br.level !== level || !bboxHit(br.bbox, v)) continue;
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

  /** Walls, fortifications, fences and hedges: a sun shadow for their height, then the body
   *  (a lighter top on masonry, posts on fences). Drawn over the ground, under everything else. */
  drawBarriers(ctx: CanvasRenderingContext2D, v: View) {
    const vis = this.chunks.filter((c) => c.barriers && bboxHit(c.bbox, { x0: v.x0 - 8, y0: v.y0 - 8, x1: v.x1 + 8, y1: v.y1 + 8 }));
    if (!vis.length) return;
    const day = this.atmos.daylight, sun = this.atmos.sun;
    ctx.save();
    ctx.lineJoin = 'round';
    for (let k = 0; k < BARRIERS.length; k++) {
      const B = BARRIERS[k];
      const paths: Path2D[] = [];
      for (const c of vis) {
        const p = c.barriers![k];
        if (p) paths.push(p);
      }
      if (!paths.length) continue;
      const w = Math.max(0.12, B.ht * 2);
      ctx.lineCap = k === 4 ? 'round' : 'butt';
      if (day > 0.05 && v.scale > 2) {
        // the shadow band: the line swept away from the sun up to its height
        const h = Math.min(B.h, 5);
        ctx.strokeStyle = `rgba(20,25,45,${(k === 3 ? 0.1 : 0.2) * day})`;
        ctx.lineWidth = w;
        for (const f of [0.35, 0.7, 1]) {
          ctx.translate(sun.dx * h * f, sun.dy * h * f);
          for (const p of paths) ctx.stroke(p);
          ctx.translate(-sun.dx * h * f, -sun.dy * h * f);
        }
      }
      if (k === 3) {
        // fence: wire plus posts every 2.5 m
        ctx.strokeStyle = B.color;
        ctx.lineWidth = 0.07;
        for (const p of paths) ctx.stroke(p);
        if (v.scale > 4) {
          ctx.lineWidth = 0.2;
          ctx.setLineDash([0.2, 2.3]);
          for (const p of paths) ctx.stroke(p);
          ctx.setLineDash([]);
        }
        continue;
      }
      // masonry and hedges: a darker outline, the body, then a light top edge
      ctx.strokeStyle = k === 4 ? '#35572a' : shade(B.color, 0.62);
      ctx.lineWidth = w + 0.12;
      for (const p of paths) ctx.stroke(p);
      ctx.strokeStyle = B.color;
      ctx.lineWidth = w;
      for (const p of paths) ctx.stroke(p);
      if (v.scale > 3 && k !== 4) {
        ctx.strokeStyle = 'rgba(255,250,235,0.35)';
        ctx.lineWidth = Math.max(0.05, w * 0.3);
        for (const p of paths) ctx.stroke(p);
        if (k === 1) {
          // battlements along the top of the city and castle walls
          ctx.strokeStyle = shade(B.color, 0.8);
          ctx.lineWidth = w * 0.5;
          ctx.setLineDash([0.8, 0.8]);
          for (const p of paths) ctx.stroke(p);
          ctx.setLineDash([]);
        }
      }
    }
    ctx.restore();
  }

  /** Street furniture and the bases of monuments, at street level: every post's shadow, bollards
   *  (dark posts with a light cap), concrete blocks, planters with their greenery, and the stone
   *  plinths statues and columns stand on (`drawPostTops` raises them above the street). */
  drawPosts(ctx: CanvasRenderingContext2D, v: View) {
    if (v.scale < 1.5) return;
    const pad = { x0: v.x0 - 20, y0: v.y0 - 20, x1: v.x1 + 20, y1: v.y1 + 20 };
    const day = this.atmos.daylight, sun = this.atmos.sun;
    ctx.save();
    for (const c of this.chunks) {
      const P = c.posts;
      if (!P || !bboxHit(c.bbox, pad)) continue;
      for (let i = 0; i < P.length; i += 4) {
        const x = P[i], y = P[i + 1], r = P[i + 2], k = P[i + 3];
        if (x < v.x0 - 16 || x > v.x1 + 16 || y < v.y0 - 16 || y > v.y1 + 16) continue;
        const B = POSTS[k] ?? POSTS[0];
        if (day > 0.05) {
          // shadow: the post swept away from the sun up to its height
          const h = Math.min(B.h, 8);
          ctx.strokeStyle = `rgba(20,25,45,${0.22 * day})`;
          ctx.lineWidth = r * 2;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + sun.dx * h, y + sun.dy * h);
          ctx.stroke();
        }
        if (k === 0) {
          ctx.fillStyle = B.color;
          ctx.beginPath();
          ctx.arc(x, y, r + 0.03, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(235,235,230,0.85)';
          ctx.beginPath();
          ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.45, 0, Math.PI * 2);
          ctx.fill();
        } else if (k === 1 || k === 2) {
          ctx.fillStyle = shade(B.color, 0.7);
          ctx.fillRect(x - r - 0.05, y - r - 0.05, r * 2 + 0.1, r * 2 + 0.1);
          ctx.fillStyle = B.color;
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
          if (k === 2) {
            ctx.fillStyle = '#5b8c3e';
            ctx.beginPath();
            ctx.arc(x, y, r * 0.7, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          // a stone plinth (square for statues and memorials, round for columns)
          ctx.fillStyle = shade('#d7d0c2', 0.75);
          ctx.beginPath();
          if (k === 4) ctx.arc(x, y, r + 0.1, 0, Math.PI * 2);
          else ctx.rect(x - r - 0.1, y - r - 0.1, r * 2 + 0.2, r * 2 + 0.2);
          ctx.fill();
          ctx.fillStyle = '#d7d0c2';
          ctx.beginPath();
          if (k === 4) ctx.arc(x, y, r * 0.85, 0, Math.PI * 2);
          else ctx.rect(x - r, y - r, r * 2, r * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  /** Statues, columns and memorial stones, raised above the street like the buildings: the shaft
   *  or figure leans away from the camera up to its height. Drawn with the trees. */
  private drawPostTops(ctx: CanvasRenderingContext2D, v: View) {
    if (v.scale < 1.5) return;
    ctx.save();
    ctx.lineCap = 'round';
    for (const c of this.chunks) {
      const P = c.posts;
      if (!P || !bboxHit(c.bbox, v)) continue;
      for (let i = 0; i < P.length; i += 4) {
        const k = P[i + 3];
        if (k < 3) continue;
        const x = P[i], y = P[i + 1], r = P[i + 2];
        if (x < v.x0 - 10 || x > v.x1 + 10 || y < v.y0 - 10 || y > v.y1 + 10) continue;
        const B = POSTS[k] ?? POSTS[3];
        const [ox, oy] = this.roofOffset(x, y, B.h, v);
        const w = k === 4 ? r * 0.55 : k === 5 ? r * 1.4 : r * 0.9;
        ctx.strokeStyle = shade(B.color, 0.75);
        ctx.lineWidth = w + 0.1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + ox, y + oy);
        ctx.stroke();
        ctx.strokeStyle = B.color;
        ctx.lineWidth = w;
        ctx.stroke();
        // the figure on top (a statue's head and shoulders, the column's crowning statue)
        if (k !== 5) {
          ctx.fillStyle = k === 4 ? '#c9a94a' : shade(B.color, 1.25);
          ctx.beginPath();
          ctx.arc(x + ox, y + oy, k === 4 ? r * 0.45 : r * 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  /** Tunnel portals: where a road or the tram line dives underground, a dark mouth sloping away
   *  into the tunnel between two concrete retaining walls. */
  drawPortals(ctx: CanvasRenderingContext2D, v: View) {
    const DEPTH = 9;
    for (const t of this.world.tunnels) {
      if (!bboxHit(t.bbox, { x0: v.x0 - 20, y0: v.y0 - 20, x1: v.x1 + 20, y1: v.y1 + 20 })) continue;
      const p = t.p, n = p.length;
      for (const fromEnd of [false, true]) {
        if (!t.open[fromEnd ? 1 : 0]) continue;
        const x = fromEnd ? p[n - 2] : p[0], y = fromEnd ? p[n - 1] : p[1];
        const ix = fromEnd ? p[n - 4] : p[2], iy = fromEnd ? p[n - 3] : p[3];
        const d = Math.hypot(ix - x, iy - y) || 1;
        const ux = (ix - x) / d, uy = (iy - y) / d, nx = -uy, ny = ux;
        const hw = t.hw + 0.3, L = Math.min(DEPTH, d);
        const g = ctx.createLinearGradient(x, y, x + ux * L, y + uy * L);
        g.addColorStop(0, 'rgba(24,24,28,0.35)');
        g.addColorStop(0.35, 'rgba(12,12,15,0.8)');
        g.addColorStop(1, 'rgba(5,5,7,0.97)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x + nx * hw, y + ny * hw);
        ctx.lineTo(x + nx * hw + ux * L, y + ny * hw + uy * L);
        ctx.lineTo(x - nx * hw + ux * L, y - ny * hw + uy * L);
        ctx.lineTo(x - nx * hw, y - ny * hw);
        ctx.closePath();
        ctx.fill();
        // retaining walls along the ramp and the portal's concrete lintel
        ctx.strokeStyle = '#9b968c';
        ctx.lineWidth = 0.5;
        ctx.lineCap = 'butt';
        ctx.beginPath();
        for (const s of [1, -1]) {
          ctx.moveTo(x + nx * hw * s - ux * 6, y + ny * hw * s - uy * 6);
          ctx.lineTo(x + nx * hw * s + ux * L, y + ny * hw * s + uy * L);
        }
        ctx.stroke();
        ctx.strokeStyle = '#b4afa4';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(x + nx * (hw + 0.4) + ux * 1.2, y + ny * (hw + 0.4) + uy * 1.2);
        ctx.lineTo(x - nx * (hw + 0.4) + ux * 1.2, y - ny * (hw + 0.4) + uy * 1.2);
        ctx.stroke();
        ctx.lineCap = 'round';
      }
    }
  }

  /** The inside of the tunnels, for the see-through view while the player is underground:
   *  tube walls, the roadway or track, and a row of lamps. */
  drawTunnelInterior(ctx: CanvasRenderingContext2D, v: View) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    for (const t of this.world.tunnels) {
      if (!bboxHit(t.bbox, v)) continue;
      const path = new Path2D();
      path.moveTo(t.p[0], t.p[1]);
      for (let i = 2; i < t.p.length; i += 2) path.lineTo(t.p[i], t.p[i + 1]);
      ctx.strokeStyle = '#1c1d21';
      ctx.lineWidth = t.hw * 2 + 1.2;
      ctx.stroke(path);
      ctx.strokeStyle = t.tram ? '#4a4741' : '#3b3c41';
      ctx.lineWidth = t.hw * 2;
      ctx.stroke(path);
      if (t.tram) {
        ctx.strokeStyle = '#27272a';
        ctx.lineWidth = 0.14;
        for (const s of [0.72, -0.72]) {
          const o = offsetPolyline(t.p, s);
          ctx.beginPath();
          for (let i = 0; i < o.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, o[i], o[i + 1]);
          ctx.stroke();
        }
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 0.15;
        ctx.setLineDash([3, 5]);
        ctx.stroke(path);
        ctx.setLineDash([]);
      }
      // sodium lamps on the tube wall
      ctx.fillStyle = '#ffcc70';
      walkPolyline(t.p, 12, 4, (x, y, nx, ny) => {
        ctx.beginPath();
        ctx.arc(x + nx * (t.hw + 0.2), y + ny * (t.hw + 0.2), 0.25, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    ctx.restore();
  }

  /** Traffic lights (World.lights) at world clock time `t` (seconds of the game day): painted stop lines and a signal
   *  head at the right-hand kerb of each approach, lit in that approach's colour. */
  drawTrafficLights(ctx: CanvasRenderingContext2D, v: View, t: number) {
    const lights = this.world.lights;
    if (v.scale < 3 || !lights.lines.length) return;
    ctx.save();
    ctx.lineCap = 'butt';
    for (const l of lights.lines) {
      if (l.x < v.x0 - 12 || l.x > v.x1 + 12 || l.y < v.y0 - 12 || l.y > v.y1 + 12) continue;
      const rx = -l.uy, ry = l.ux;
      if (l.hw >= 2.5) {
        ctx.strokeStyle = 'rgba(240,238,230,0.85)';
        ctx.lineWidth = 0.4;
        ctx.beginPath();
        ctx.moveTo(l.x + rx * 0.3, l.y + ry * 0.3);
        ctx.lineTo(l.x + rx * (l.hw - 0.3), l.y + ry * (l.hw - 0.3));
        ctx.stroke();
      }
      ctx.save();
      ctx.translate(l.x + rx * (l.hw + 0.6), l.y + ry * (l.hw + 0.6));
      ctx.rotate(Math.atan2(l.uy, l.ux));
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(-0.15, -0.35, 0.7, 1.2);
      ctx.fillStyle = '#1e2124';
      ctx.fillRect(-0.3, -0.5, 0.6, 1.2);
      const st = lights.state(l, t);
      for (let k = 0; k < 3; k++) {
        ctx.fillStyle = k === st ? SIGNAL_LAMP[k] : 'rgba(80,80,80,0.9)';
        ctx.beginPath();
        ctx.arc(0, 0.35 - k * 0.35, 0.13, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  /** Night glow of the lit traffic-light lamps. */
  emitTrafficLights(L: LightLayer, t: number, night: number) {
    if (night < 0.05) return;
    const lights = this.world.lights;
    for (const l of lights.lines) {
      const hx = l.x - l.uy * (l.hw + 0.6), hy = l.y + l.ux * (l.hw + 0.6);
      if (!L.visible(hx, hy, 4)) continue;
      const c = SIGNAL_LAMP[lights.state(l, t)];
      L.glow(hx, hy, 0.7, c, 0.9 * night);
      L.point(hx, hy, 3, c, 0.35 * night);
    }
  }

  /** Flat 2D rendering of the buildings (all of them, or those in view), for the city map. */
  drawBuildingsFlat(ctx: CanvasRenderingContext2D, v?: View) {
    for (const c of this.chunks) {
      if (v && !bboxHit(c.bbox, v)) continue;
      for (const t of c.tiers)
        for (const r of t.roofs) {
          ctx.fillStyle = r.color;
          ctx.fill(r.path, 'evenodd');
        }
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
