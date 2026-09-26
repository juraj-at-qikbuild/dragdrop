import type { BuildingJSON, MapJSON, RoadJSON } from '../types';
import { Graph, linkPoints, type Edge } from './Graph';
import { TrafficLights, StreetMarks } from './TrafficLights';
import { Bumps, FURNITURE, F_COLUMN, Gates, Islands } from './Street';
import { bboxOf, pointInRings, ringArea, rng, segDist2, segIntersect, type BBox } from '../util/math';

/** Where an entity is vertically: -1 in a tunnel, 0 on the ground (or under a bridge deck), 1 on
 *  a bridge deck, 2 on an upper deck that crosses over others (Most SNP's road deck above its
 *  footways, the motorway flyover over its ramps: OSM layer 2 and up). */
export type Level = -1 | 0 | 1 | 2;

/** what a car drives on (see `World.surfaceAt`): `kerb` is up on a traffic island */
export type Surface = 'asphalt' | 'cobble' | 'offroad' | 'bridge' | 'steps' | 'kerb';

/** the deck level (1 or 2) of a bridge road */
export const deckLevel = (r: RoadJSON): 1 | 2 => ((r.y ?? 0) >= 2 ? 2 : 1);

export interface Building {
  /** outer rings wound with positive signed area, courtyard holes negative, so for every edge
   *  (ax,ay)->(bx,by) the normal (by-ay, ax-bx) points away from the building's material */
  rings: Float32Array[];
  /** bbox of rings[0] */
  bbox: BBox;
  /** bbox of every ring (multipolygon buildings can have several outer rings) */
  bboxAll: BBox;
  cx: number;
  cy: number;
  /** storeys drawn (see `drawnLevels`: untagged buildings get a deterministic variation) */
  levels: number;
  kind: number;
  seed: number;
  name: number;
  color?: string;
  wallColor?: string;
  area: number;
  solid: boolean;
  /** metres above the ground the building starts at: > 0 for raised structures with nothing solid
   *  below them (the UFO, skywalks, a floor bridging a street), which are not obstacles */
  minH: number;
  /** a building part (tower, spire, wing): drawn only, its building's outline is the obstacle */
  part: boolean;
  /** an outline drawn as its parts instead (still solid) */
  hidden: boolean;
  /** roof shape from the map (see BuildingJSON.rs; 0 = the renderer decides) */
  roofShape: number;
  /** height (m) of a pyramid, dome, onion or cone roof above the walls */
  roofH: number;
}

export interface Landmark {
  id: string;
  name: string;
  x: number;
  y: number;
}

/** Per barrier kind (the map's `barriers[].k`): collision half-thickness (m), drawn height (m),
 *  whether it blocks sight and bullets, and its colour. */
export const BARRIERS: { ht: number; h: number; sight: boolean; color: string; name: string }[] = [
  { name: 'wall', ht: 0.25, h: 2.2, sight: true, color: '#b7ae9f' },
  { name: 'fortification', ht: 0.9, h: 7, sight: true, color: '#d2c7ae' },
  { name: 'retaining wall', ht: 0.3, h: 1.8, sight: false, color: '#a59d90' },
  { name: 'fence', ht: 0.06, h: 1.7, sight: false, color: '#3b3d40' },
  { name: 'hedge', ht: 0.45, h: 1.6, sight: true, color: '#4d7a3a' },
  { name: 'concrete barrier', ht: 0.3, h: 0.9, sight: false, color: '#cdc9c0' },
  { name: 'noise barrier', ht: 0.15, h: 3.5, sight: true, color: '#7f8c90' },
  { name: 'flood wall', ht: 0.25, h: 1.0, sight: false, color: '#b3aea5' },
  { name: 'fountain rim', ht: 0.3, h: 0.55, sight: false, color: '#d6cfbf' },
];

/** Per post kind (the map's `posts[].kind`): solid street furniture and monuments, each a disc of
 *  its own radius. Drawn height (m), whether it blocks sight and bullets, and its colour. */
export const POSTS: { name: string; h: number; sight: boolean; color: string }[] = [
  { name: 'bollard', h: 0.9, sight: false, color: '#3b3f45' },
  { name: 'block', h: 0.8, sight: false, color: '#bdb8ae' },
  { name: 'planter', h: 0.8, sight: false, color: '#8d6e55' },
  { name: 'statue', h: 3.2, sight: true, color: '#5f6a5c' },
  { name: 'column', h: 14, sight: true, color: '#d9d1c0' },
  { name: 'memorial stone', h: 1.4, sight: true, color: '#9a968e' },
];

const CELL = 16;
/** building lookup grid cell size */
const BCELL = 32;
/** floats per `roadSegs` entry: ax, ay, bx, by, halfWidth, nameIdx, deck (0 not a bridge, else
 *  its level), openA, openB */
const SEG = 9;
/** floats per deck-end / tunnel-portal record: x, y, inward ux, uy, halfWidth, level it leads to */
const END = 6;
/** floats per wall: ax, ay, bx, by, half-thickness, flags (see W_SIGHT, W_LOW) */
const WALL = 6;
/** wall flag: blocks sight lines and bullets (buildings, masonry walls, hedges; not fences) */
const W_SIGHT = 1;
/** wall flag: low ground-level obstacle (barriers, tree trunks) that is no obstacle on a bridge deck */
const W_LOW = 2;
/** wall flag: only blocks sight lines and bullets, nothing collides with it (the cross-hairs that
 *  let round monuments stop shots, which rays can't hit as points) */
const W_NOHIT = 4;
/** wall flag: a post (bollard, block, planter, statue, column), a disc of radius `ht` */
export const W_POST = 8;
/** a car's collision half-width plus a little room, for fitting lanes to the street */
const LANE_R = 1.0;
/** a pedestrian's radius plus a little room, for fitting walking lines */
const WALK_R = 0.45;
/** a walking line still this deep in a wall, fence or post at its best (m) isn't used: people walk
 *  the other side of the way, or nobody walks it */
const WALK_BLOCKED = 0.2;
/** cell size of the water raster (m) */
const WCELL = 8;
/** sampling step along lanes and walking lines when fitting them (m; the map builder bakes the
 *  fits, so this is paid once, not on every page load) */
const FIT_STEP = 0.5;
/** dead-end depth of the car-graph nodes past the edge of the playable area: never entered */
export const OFF_MAP = 1 << 20;
/** bump whenever the lane and walking-line fitting changes: maps baked with an older version
 *  (MapJSON.fit) are fitted again at startup */
export const FIT_VERSION = 2;
/** floats per tunnel tube segment: ax, ay, bx, by, halfWidth, openA, openB */
const TUBE = 7;
/** floats per `surfSegs` entry: ax, ay, bx, by, halfWidth, road class, paving (RoadJSON.s) */
const SURF = 7;
/** an entity only goes up onto a deck (or down into a tube) it fits in with at least this much room either side */
const DECK_FIT = 0.5;
/** tree trunk collision radius */
const TRUNK = 0.3;
/** cap on trees (real + filled in) */
const MAX_TREES = 6000;

/** where a circle is relative to the nearest bridge deck it fits on (reused, see `deckFit`) */
interface DeckFit {
  /** on a deck (within its railings) or past one of its open ends */
  on: boolean;
  /** distance outside the nearest deck's railings (0 when `on`) */
  depth: number;
  /** unit push back toward that deck */
  nx: number;
  ny: number;
  /** that deck segment's direction */
  ux: number;
  uy: number;
  /** that deck's level */
  level: 1 | 2;
}

/** where a circle is relative to the nearest tunnel tube it fits in (reused, see `tubeFit`) */
interface TubeFit {
  /** inside a tube */
  on: boolean;
  /** past one of its portals, i.e. back out at the surface */
  out: boolean;
  /** distance outside the nearest tube's walls (0 when `on`) */
  depth: number;
  nx: number;
  ny: number;
}

/** Static city data plus spatial queries (collision, water, street names). */
export class World {
  data: MapJSON;
  bounds: BBox;
  names: string[];
  buildings: Building[];
  car: Graph;
  ped: Graph;
  tram: Graph;
  landmarks = new Map<string, Landmark>();
  /** every tree drawn: real ones from the map first, then parks and woods filled in; x, y, canopy radius, seed */
  trees: Float32Array;
  /** tunnel tubes (for drawing their portals) */
  tunnels: { p: Float32Array; hw: number; tram: boolean; open: [boolean, boolean]; bbox: BBox }[] = [];
  /** the real traffic lights, as stop lines on the car graph with their cycles */
  lights: TrafficLights;
  /** stop and give-way signs and speed bumps, placed on the car graph for traffic */
  marks: StreetMarks;
  /** tram stops on the tracks, flat x, y */
  tramStops: Float32Array;
  /** name of each tram stop ('' when the map has none) */
  tramStopNames: string[];
  /** raised traffic islands */
  islands: Islands;
  /** speed bumps and raised tables */
  bumps: Bumps;
  /** lift gates: their booms, and which are snapped (state: each simulation keeps its own) */
  gates: Gates;
  /** street furniture, flat x, y, angle, kind (see FURNITURE) */
  furniture: Float32Array;
  private furnGrid = new Map<number, number[]>();
  /** the city's boroughs, quarters and squares */
  private districts: { name: string; rings: Float32Array[]; bbox: BBox }[] = [];
  private quarters: { name: string; x: number; y: number }[] = [];
  private squares: { name: string; rings: Float32Array[]; bbox: BBox }[] = [];

  /** wall segments, WALL floats each (see WALL) */
  private walls: Float32Array;
  private wallGrid = new Map<number, number[]>();
  /** named and bridge road segments, SEG floats each (see SEG); openA/openB flag a bridge
   *  segment end that is a real deck end, where entities may drive or walk off the deck */
  private roadSegs: Float32Array;
  private roadGrid = new Map<number, number[]>();
  /** road-grid cells that contain at least one bridge segment (fast "not on a bridge" answers) */
  private bridgeCells = new Set<number>();
  /** all road segments for surface queries [ax, ay, bx, by, halfWidth, class, paving] (see SURF) */
  private surfSegs: Float32Array;
  private surfGrid = new Map<number, number[]>();
  private water: { rings: Float32Array[]; bbox: BBox }[] = [];
  /** the water on a WCELL grid over the map: 0 dry, 1 all under water, 2 a shore runs through it
   *  (look closer), so most `inWater` calls are one lookup instead of a test against the river */
  private waterCells = new Uint8Array(0);
  private waterCols = 0;
  /** piers and pontoons: walkable decks over the water */
  private piers: { rings: Float32Array[]; bbox: BBox }[] = [];
  /** deck ends (where a ramp or street meets a bridge deck), END floats each (see END) */
  private bridgeEnds: Float32Array = new Float32Array(0);
  private fit: DeckFit = { on: false, depth: 0, nx: 0, ny: 0, ux: 1, uy: 0, level: 1 };
  /** passage corridors through buildings: centre lines and half-widths, with a segment grid */
  private passages: { p: Float32Array; hw: number }[] = [];
  private passageGrid = new Map<number, number[]>();
  /** tunnel tube segments, TUBE floats each (see TUBE) */
  private tubeSegs: Float32Array = new Float32Array(0);
  private tubeGrid = new Map<number, number[]>();
  /** tunnel portals, END floats each (see END): the inward direction points into the tunnel */
  private portals: Float32Array = new Float32Array(0);
  private tfit: TubeFit = { on: false, out: false, depth: 0, nx: 0, ny: 0 };
  /** building indices by BCELL cell (over each building's `bboxAll`) */
  private buildingGrid = new Map<number, number[]>();
  /** per-building query stamp, so `forBuildingsNear` visits each building once */
  private buildingStamp: Uint32Array;
  private stamp = 0;

  constructor(data: MapJSON) {
    this.data = data;
    const [x0, y0, x1, y1] = data.bounds;
    this.bounds = { x0, y0, x1, y1 };
    this.names = data.names;
    for (const l of data.landmarks) this.landmarks.set(l.id, { id: l.id, name: l.n, x: l.x, y: l.y });

    // ordinary buildings with no height in OSM (older baked maps don't flag them: those came out
    // as exactly 3 storeys); churches, landmarks and commercial blocks keep their height
    const untagged = (b: BuildingJSON) => b.k === 0 && (data.flagsUntagged ? b.u === 1 : b.l === 3);
    this.buildings = data.buildings.map((b) => {
      const rings = orientRings(b.r.map((r) => Float32Array.from(r)));
      const bbox = bboxOf(rings[0]);
      const bboxAll = { ...bbox };
      for (let i = 1; i < rings.length; i++) bboxOf(rings[i], 0, bboxAll);
      const area = ringArea(rings[0]);
      const cx = (bbox.x0 + bbox.x1) / 2, cy = (bbox.y0 + bbox.y1) / 2;
      const minH = b.m ?? 0;
      return {
        rings,
        bbox,
        bboxAll,
        cx,
        cy,
        levels: untagged(b) ? drawnLevels(area, cx, cy, b.s) : b.l,
        kind: b.k,
        seed: b.s,
        name: b.n ?? -1,
        color: b.c,
        wallColor: b.w,
        area,
        solid: b.k !== 4 && area > 6 && minH <= 0 && !b.p,
        minH,
        part: b.p === 1,
        hidden: b.x === 1,
        roofShape: b.rs ?? 0,
        roofH: b.rh ?? 0,
      };
    });

    this.buildings.forEach((b, i) => {
      const g0x = Math.floor(b.bboxAll.x0 / BCELL), g1x = Math.floor(b.bboxAll.x1 / BCELL);
      const g0y = Math.floor(b.bboxAll.y0 / BCELL), g1y = Math.floor(b.bboxAll.y1 / BCELL);
      for (let gx = g0x; gx <= g1x; gx++)
        for (let gy = g0y; gy <= g1y; gy++) {
          const k = this.key(gx, gy);
          let c = this.buildingGrid.get(k);
          if (!c) this.buildingGrid.set(k, (c = []));
          c.push(i);
        }
    });
    this.buildingStamp = new Uint32Array(this.buildings.length);

    // passages through buildings (gateways, courtyard passages, covered streets)
    for (const p of data.passages ?? []) {
      const i = this.passages.length;
      this.passages.push({ p: Float32Array.from(p.p), hw: p.w / 2 });
      for (let k = 0; k < p.p.length - 2; k += 2) this.addBoxToGrid(this.passageGrid, i * 65536 + k, p.p[k], p.p[k + 1], p.p[k + 2], p.p[k + 3], p.w / 2);
    }

    // surface lookup: every road (not just named/bridged ones), tagged with its class and paving
    const surf: number[] = [];
    for (const r of data.roads)
      for (let i = 0; i < r.p.length - 2; i += 2) surf.push(r.p[i], r.p[i + 1], r.p[i + 2], r.p[i + 3], r.w / 2, r.c, r.s ?? 0);
    this.surfSegs = Float32Array.from(surf);
    for (let i = 0; i < this.surfSegs.length; i += SURF) this.addToGrid(this.surfGrid, i, this.surfSegs, 6);

    // road segments for street names and bridges
    const segs: number[] = [];
    /** index (in `segs`) of each bridge road's first and last segment */
    const bridgeSegs: [RoadJSON, number, number][] = [];
    for (const r of data.roads) {
      if (r.n === undefined && !r.b) continue;
      const first = segs.length;
      for (let i = 0; i < r.p.length - 2; i += 2)
        segs.push(r.p[i], r.p[i + 1], r.p[i + 2], r.p[i + 3], r.w / 2, r.n ?? -1, r.b ? deckLevel(r) : 0, 0, 0);
      if (r.b && segs.length > first) bridgeSegs.push([r, first, segs.length - SEG]);
    }
    this.roadSegs = Float32Array.from(segs);
    for (let i = 0; i < this.roadSegs.length; i += SEG) this.addToGrid(this.roadGrid, i, this.roadSegs, 12);
    for (const [k, list] of this.roadGrid) if (list.some((i) => this.roadSegs[i + 6])) this.bridgeCells.add(k);

    // deck ends: first/last vertex of every bridge polyline where the deck meets a ramp or street.
    // OSM splits long bridges into several ways, so an end only counts if the road continues off
    // the bridge there: an ordinary road shares that vertex, or a probe a few metres further out
    // is no longer on any deck. Rails stay open at deck ends so entities can leave the bridge. An
    // end where a deck carries on at the other level (a ramp rising onto a flyover) is open too,
    // but only for traffic already up on the decks.
    const groundVerts = new Set<string>();
    for (const r of data.roads) if (!r.b) for (let i = 0; i < r.p.length; i += 2) groundVerts.add(`${r.p[i]}|${r.p[i + 1]}`);
    const ends: number[] = [];
    const deckEnd = (p: number[], fromEnd: boolean, hw: number, level: 1 | 2) => {
      const n = p.length;
      const x = fromEnd ? p[n - 2] : p[0], y = fromEnd ? p[n - 1] : p[1];
      const [ux, uy] = inward(p, fromEnd);
      const px = x - ux * 6, py = y - uy * 6;
      const toGround = groundVerts.has(`${x}|${y}`) || !this.onBridge(px, py);
      if (toGround) ends.push(x, y, ux, uy, hw, level);
      return toGround || !this.onBridge(px, py, level) ? 1 : 0;
    };
    for (const [r, first, last] of bridgeSegs) {
      this.roadSegs[first + 7] = deckEnd(r.p, false, r.w / 2, deckLevel(r));
      this.roadSegs[last + 8] = deckEnd(r.p, true, r.w / 2, deckLevel(r));
    }
    this.bridgeEnds = Float32Array.from(ends);

    // tunnel tubes and their portals
    const tubes: number[] = [], portals: number[] = [];
    for (const t of data.tunnels ?? []) {
      const p = Float32Array.from(t.p), hw = t.w / 2, n = t.p.length;
      this.tunnels.push({ p, hw, tram: t.k === 1, open: [!!t.o[0], !!t.o[1]], bbox: bboxOf(t.p, hw + 1) });
      for (let i = 0; i < n - 2; i += 2) tubes.push(t.p[i], t.p[i + 1], t.p[i + 2], t.p[i + 3], hw, i === 0 ? t.o[0] : 0, i === n - 4 ? t.o[1] : 0);
      for (const fromEnd of [false, true]) {
        if (!t.o[fromEnd ? 1 : 0]) continue;
        const [ux, uy] = inward(t.p, fromEnd);
        portals.push(fromEnd ? t.p[n - 2] : t.p[0], fromEnd ? t.p[n - 1] : t.p[1], ux, uy, hw, -1);
      }
    }
    this.tubeSegs = Float32Array.from(tubes);
    for (let i = 0; i < this.tubeSegs.length; i += TUBE) this.addToGrid(this.tubeGrid, i, this.tubeSegs, 8);
    this.portals = Float32Array.from(portals);

    // collision walls: building outlines (with passages cut through them), passage side walls,
    // walls/fences/hedges, tree trunks
    const walls: number[] = [];
    const wall = (ax: number, ay: number, bx: number, by: number, ht: number, flags: number) => walls.push(ax, ay, bx, by, ht, flags);
    for (const b of this.buildings) {
      if (!b.solid) continue;
      for (const r of b.rings)
        for (let i = 0; i < r.length - 2; i += 2) {
          const ax = r[i], ay = r[i + 1], bx = r[i + 2], by = r[i + 3];
          let u = 0;
          for (const [u0, u1] of this.passageSpans(ax, ay, bx, by)) {
            if (u0 > u) wall(ax + (bx - ax) * u, ay + (by - ay) * u, ax + (bx - ax) * u0, ay + (by - ay) * u0, 0, W_SIGHT);
            u = Math.max(u, u1);
          }
          if (u < 1) wall(ax + (bx - ax) * u, ay + (by - ay) * u, bx, by, 0, W_SIGHT);
        }
    }
    this.passageWalls(wall);
    for (const bar of data.barriers ?? []) {
      const k = BARRIERS[bar.k] ?? BARRIERS[0];
      for (let i = 0; i < bar.p.length - 2; i += 2) wall(bar.p[i], bar.p[i + 1], bar.p[i + 2], bar.p[i + 3], k.ht, W_LOW | (k.sight ? W_SIGHT : 0));
    }
    // bollards, blocks, planters, statues and columns: solid discs; the big ones also stop shots
    // (a ray can't hit a point, so they get a sight-only cross)
    const posts = data.posts ?? [];
    for (let i = 0; i < posts.length; i += 4) {
      const x = posts[i], y = posts[i + 1], r = posts[i + 2], k = POSTS[posts[i + 3]] ?? POSTS[0];
      wall(x, y, x, y, r, W_LOW | W_POST);
      if (k.sight && r >= 0.3) {
        const d = r * 0.8;
        wall(x - d, y - d, x + d, y + d, 0, W_SIGHT | W_LOW | W_NOHIT);
        wall(x - d, y + d, x + d, y - d, 0, W_SIGHT | W_LOW | W_NOHIT);
      }
    }
    // bridge piers: solid at street level (like a wall, nothing up on the decks meets them)
    for (const r of data.supports ?? []) for (let i = 0; i < r.length - 2; i += 2) wall(r[i], r[i + 1], r[i + 2], r[i + 3], 0.05, W_LOW | W_SIGHT);
    // street furniture: advertising columns stand as solid as a monument; the rest is knocked over
    this.furniture = Float32Array.from(data.furniture ?? []);
    const fu = this.furniture;
    for (let i = 0; i < fu.length; i += 4) {
      const x = fu[i], y = fu[i + 1], k = fu[i + 3];
      const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL), key = this.key(gx, gy);
      const c = this.furnGrid.get(key);
      if (c) c.push(i);
      else this.furnGrid.set(key, [i]);
      if (k === F_COLUMN) {
        const r = FURNITURE[k].r;
        wall(x, y, x, y, r, W_LOW | W_POST);
        wall(x - r * 0.8, y - r * 0.8, x + r * 0.8, y + r * 0.8, 0, W_SIGHT | W_LOW | W_NOHIT);
        wall(x - r * 0.8, y + r * 0.8, x + r * 0.8, y - r * 0.8, 0, W_SIGHT | W_LOW | W_NOHIT);
      }
    }
    this.islands = new Islands(data.islands);
    this.bumps = new Bumps(data.calming);
    this.gates = new Gates(data.gates);
    this.trees = this.placeTrees();
    for (let i = 0; i < this.trees.length; i += 4) {
      const x = this.trees[i], y = this.trees[i + 1];
      // trees in a street or on a path are only drawn (the map has them where the traffic goes)
      if (this.nearRoad(x, y, TRUNK + 0.4)) continue;
      wall(x, y, x, y, TRUNK, W_LOW);
    }
    this.walls = Float32Array.from(walls);
    for (let i = 0; i < this.walls.length; i += WALL) this.addToGrid(this.wallGrid, i, this.walls, this.walls[i + 4]);

    for (const w of data.areas.water) {
      const rings = w.map((r) => Float32Array.from(r));
      if (ringArea(rings[0]) < 4000) continue; // fountains are decoration only
      this.water.push({ rings, bbox: bboxOf(rings[0]) });
    }
    this.rasterWater();
    for (const w of data.areas.pier ?? []) {
      const rings = w.map((r) => Float32Array.from(r));
      this.piers.push({ rings, bbox: bboxOf(rings[0]) });
    }

    this.car = new Graph(data.graph.car, true);
    this.ped = new Graph(data.graph.ped, false);
    this.tram = new Graph(data.graph.tram, false);
    if (data.fit === FIT_VERSION) this.bakedFits();
    else {
      this.fitLanes();
      this.fitWalks();
    }
    this.car.depth = this.deadEnds();
    this.lights = new TrafficLights(this);
    this.marks = new StreetMarks(this);
    this.tramStops = Float32Array.from(data.tramStops ?? []);
    this.tramStopNames = (data.tramStops ?? []).filter((_, i) => i % 2 === 0).map((_, i) => data.names[data.tramStopNames?.[i] ?? -1] ?? '');
    for (const d of data.districts ?? []) {
      const rings = d.r.map((r) => Float32Array.from(r));
      const bbox = bboxOf(rings[0]);
      for (let i = 1; i < rings.length; i++) bboxOf(rings[i], 0, bbox);
      this.districts.push({ name: data.names[d.n], rings, bbox });
    }
    for (const q of data.quarters ?? []) this.quarters.push({ name: data.names[q.n], x: q.x, y: q.y });
    for (const q of data.squares ?? []) {
      const rings = q.r.map((r) => Float32Array.from(r));
      this.squares.push({ name: data.names[q.n], rings, bbox: bboxOf(rings[0]) });
    }
  }

  /** Deepest overlap (m) of a circle with anything solid at `level`, 0 when it's clear: walls,
   *  fences, trunks and posts (only what stands on a deck, for level 1), tube walls underground. */
  private overlap(x: number, y: number, r: number, level: Level): number {
    if (level === -1) {
      const f = this.tubeFit(x, y, r);
      return f && !f.on && !f.out ? f.depth : 0;
    }
    let worst = 0;
    this.forWalls(x, y, r, (ax, ay, bx, by, ht, flags) => {
      if (flags & W_NOHIT || (level >= 1 && flags & W_LOW)) return;
      const rr = r + ht;
      if ((ax < bx ? ax : bx) - rr > x || (ax > bx ? ax : bx) + rr < x || (ay < by ? ay : by) - rr > y || (ay > by ? ay : by) + rr < y) return;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const pen = r + ht - Math.hypot(x - ax - dx * t, y - ay - dy * t);
      if (pen > worst) worst = pen;
    });
    return worst;
  }

  /** How badly a line `off` metres right of polyline `p` (a -> b) is obstructed for a body of
   *  radius `r`: the deepest overlap along it, sampled every FIT_STEP m, `skip` m short of either
   *  end (junction corners, which turning traffic cuts anyway). `car` picks the level like traffic
   *  (on a deck it drives along, in a tunnel); otherwise like people, for whom water is solid too. */
  private lineBlock(p0: Float32Array, off: number, r: number, skip: number, car: boolean): number {
    // exactly the line the AI follows (Graph.linkPoints: each vertex offset along the average of
    // its neighbouring segments' normals)
    const p = linkPoints({ edge: { p: p0 } as Edge, fwd: true, to: 0 }, off);
    let total = 0;
    for (let i = 0; i < p.length - 2; i += 2) total += Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
    let worst = 0, s = 0;
    for (let i = 0; i < p.length - 2; i += 2) {
      const ax = p[i], ay = p[i + 1], dx = p[i + 2] - ax, dy = p[i + 3] - ay;
      const L = Math.hypot(dx, dy);
      if (L < 1e-6) continue;
      const a = Math.atan2(dy, dx);
      for (let d = s < skip ? skip - s : FIT_STEP / 2; d < L; d += FIT_STEP) {
        if (s + d > total - skip) break;
        const x = ax + (dx * d) / L, y = ay + (dy * d) / L;
        let level: Level;
        if (car) {
          const td = this.tunnelDepth(x, y);
          if (td >= 0 && td < 8) continue; // at a portal the level is ambiguous
          level = this.spawnLevel(x, y, r, a);
          // traffic keeps off the traffic islands' kerbs
          if (level === 0) worst = Math.max(worst, this.islands.overlap(x, y, r));
        } else {
          if (this.tunnelDepth(x, y) >= 0) continue;
          const f = this.onBridge(x, y) ? this.deckFit(x, y, r) : null;
          level = f && f.on ? f.level : 0;
          if (this.inWater(x, y, level)) {
            worst = Math.max(worst, r);
            continue;
          }
        }
        worst = Math.max(worst, this.overlap(x, y, r, level));
      }
      s += L;
    }
    return worst;
  }

  /** how badly the offset `bestOffset` last returned is still obstructed (0 when clear) */
  private lastBlock = 0;

  /** The first offset in `cands` (most wanted first) whose line is clear, else the least blocked. */
  private bestOffset(p: Float32Array, cands: number[], r: number, skip: number, car: boolean): number {
    let best = cands[0], bestBlock = Infinity;
    for (const off of cands) {
      const b = this.lineBlock(p, off, r, skip, car);
      if (b <= 0.05) {
        this.lastBlock = 0;
        return off;
      }
      if (b < bestBlock - 0.05) (bestBlock = b), (best = off);
    }
    this.lastBlock = bestBlock;
    return best;
  }

  /** the lane a car-graph edge would have on a wide open street, and the walking line of a
   *  pedestrian-graph edge (the first of `fitWalks`' candidates) */
  private static laneWant = (e: { oneway: number; width: number }) => (e.oneway ? 0 : Math.min(e.width / 4, 1.9));
  private static walkWant = (e: { cls: number; width: number }) => (e.cls <= 7 ? e.width / 2 + 1.4 : Math.min(0.6, e.width / 3));

  /** Take the lanes and walking lines the map builder baked in (only the ones that differ from
   *  the defaults are stored). */
  private bakedFits() {
    const cj = this.data.graph.car.edges, pj = this.data.graph.ped.edges;
    for (const e of this.car.edges) {
      const j = cj[e.id], want = World.laneWant(e);
      e.laneF = j.lf ?? (e.oneway === -1 ? -want : want);
      e.laneR = j.lr ?? (e.oneway === 1 ? -want : want);
      if (j.bf) e.blockedF = true;
      if (j.br) e.blockedR = true;
    }
    for (const e of this.ped.edges) {
      const j = pj[e.id], want = World.walkWant(e);
      e.walkR = j.wr ?? want;
      e.walkL = j.wl ?? want;
      if (j.nw) e.noWalk = true;
    }
  }

  /** Write this world's fitted lanes and walking lines into its map's graphs, where they differ
   *  from the defaults (for the map builder, which bakes them in with `fit: FIT_VERSION`). */
  bakeFits(map: MapJSON) {
    const r2 = (v: number) => Math.round(v * 100) / 100;
    for (const e of this.car.edges) {
      const j = map.graph.car.edges[e.id], want = World.laneWant(e);
      if (e.laneF !== undefined && Math.abs(e.laneF - (e.oneway === -1 ? -want : want)) > 1e-3) j.lf = r2(e.laneF);
      if (e.laneR !== undefined && Math.abs(e.laneR - (e.oneway === 1 ? -want : want)) > 1e-3) j.lr = r2(e.laneR);
      if (e.blockedF) j.bf = 1;
      if (e.blockedR) j.br = 1;
    }
    for (const e of this.ped.edges) {
      const j = map.graph.ped.edges[e.id], want = World.walkWant(e);
      if (e.walkR !== undefined && Math.abs(e.walkR - want) > 1e-3) j.wr = r2(e.walkR);
      if (e.walkL !== undefined && Math.abs(e.walkL - want) > 1e-3) j.wl = r2(e.walkL);
      if (e.noWalk) j.nw = 1;
    }
    map.fit = FIT_VERSION;
  }

  /** Traffic keeps right, but only as far as the street allows: on a narrow two-way street or
   *  where the mapped road runs close to a facade, the lane moves towards the middle instead of
   *  scraping along the wall. One-way streets shift a little to either side if their middle is
   *  blocked. */
  private fitLanes() {
    // a lane still this deep in a wall at its best runs into a building: nobody drives it
    const BLOCKED = 0.3;
    for (const e of this.car.edges) {
      if (e.oneway) {
        const off = this.bestOffset(e.p, [0, 0.5, -0.5, 1, -1], LANE_R, 3, true);
        e.laneF = e.laneR = e.oneway === 1 ? off : -off;
        e.blockedF = e.blockedR = this.lastBlock > BLOCKED || undefined;
        continue;
      }
      const want = Math.min(e.width / 4, 1.9);
      const cands = [want, want * 0.66, want * 0.33, 0];
      e.laneF = this.bestOffset(e.p, cands, LANE_R, 3, true);
      e.blockedF = this.lastBlock > BLOCKED || undefined;
      e.laneR = -this.bestOffset(e.p, cands.map((c) => -c), LANE_R, 3, true);
      e.blockedR = this.lastBlock > BLOCKED || undefined;
    }
  }

  /** People walk on the pavement beside a street and just off the middle of a path, but where
   *  the pavement would run into a building, a fence or the river (the Old Town's narrow lanes
   *  have none), they walk along the edge of the carriageway, or down the middle. */
  private fitWalks() {
    const B = this.bounds, g = this.ped;
    const offMap = (i: number) => g.nx(i) < B.x0 + 2 || g.nx(i) > B.x1 - 2 || g.ny(i) < B.y0 + 2 || g.ny(i) > B.y1 - 2;
    for (const e of g.edges) {
      const hw = e.width / 2;
      const cands = e.cls <= 7 ? [hw + 1.4, hw + 1, hw + 0.6, hw + 0.25, Math.max(0.6, hw - 0.4), Math.max(0.5, hw - 1.2), 0] : [Math.min(0.6, e.width / 3), 0.3, 0];
      e.walkR = this.bestOffset(e.p, cands, WALK_R, 2, false);
      const blockR = this.lastBlock;
      e.walkL = -this.bestOffset(e.p, cands.map((c) => -c), WALK_R, 2, false);
      const blockL = this.lastBlock;
      if (offMap(e.a) || offMap(e.b) || Math.min(blockR, blockL) > WALK_BLOCKED) e.noWalk = true;
      // one side has no room at all (a wall, a basin the path clips): everyone walks the other side
      else if (blockR > WALK_BLOCKED) e.walkR = -e.walkL;
      else if (blockL > WALK_BLOCKED) e.walkL = -e.walkR;
    }
  }

  /** Dead-end depth of every car-graph node: 0 on the city's through network (its largest
   *  2-edge-connected part), 1 + the number of cut edges ("bridges") crossed to reach it from there
   *  otherwise: cul-de-sacs, courtyards, parking lots, and roads that only lead off the map. Nodes
   *  past the edge of the playable area are OFF_MAP. Through traffic never goes deeper. */
  private deadEnds(): Int32Array {
    const g = this.car, n = g.nodes.length / 2, B = this.bounds;
    const depth = new Int32Array(n);
    const off = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (g.nx(i) < B.x0 + 3 || g.nx(i) > B.x1 - 3 || g.ny(i) < B.y0 + 3 || g.ny(i) > B.y1 - 3) (off[i] = 1), (depth[i] = OFF_MAP);
    // undirected multigraph without the off-map nodes: [neighbour, edge id] pairs
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const e of g.edges) if (e.a !== e.b && !off[e.a] && !off[e.b]) adj[e.a].push(e.b, e.id), adj[e.b].push(e.a, e.id);
    // bridges (Tarjan, iterative)
    const disc = new Int32Array(n).fill(-1), low = new Int32Array(n), isBridge = new Uint8Array(g.edges.length);
    let time = 0;
    const stackV: number[] = [], stackE: number[] = [], stackI: number[] = [];
    for (let s = 0; s < n; s++) {
      if (off[s] || disc[s] >= 0) continue;
      disc[s] = low[s] = time++;
      stackV.push(s), stackE.push(-1), stackI.push(0);
      while (stackV.length) {
        const top = stackV.length - 1, v = stackV[top];
        if (stackI[top] < adj[v].length) {
          const w = adj[v][stackI[top]], eid = adj[v][stackI[top] + 1];
          stackI[top] += 2;
          if (eid === stackE[top]) continue;
          if (disc[w] < 0) {
            disc[w] = low[w] = time++;
            stackV.push(w), stackE.push(eid), stackI.push(0);
          } else low[v] = Math.min(low[v], disc[w]);
        } else {
          const pe = stackE[top];
          stackV.pop(), stackE.pop(), stackI.pop();
          if (stackV.length) {
            const p = stackV[stackV.length - 1];
            low[p] = Math.min(low[p], low[v]);
            if (low[v] > disc[p]) isBridge[pe] = 1;
          }
        }
      }
    }
    // 2-edge-connected components, the largest one (by street length) is the through network
    const comp = Int32Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => (comp[i] === i ? i : (comp[i] = find(comp[i])));
    for (const e of g.edges) if (!isBridge[e.id] && e.a !== e.b && !off[e.a] && !off[e.b]) comp[find(e.a)] = find(e.b);
    const size = new Map<number, number>();
    for (const e of g.edges) if (!isBridge[e.id] && !off[e.a] && !off[e.b]) size.set(find(e.a), (size.get(find(e.a)) ?? 0) + e.len);
    let main = -1, mainSize = -1;
    for (const [c, s] of size) if (s > mainSize) (mainSize = s), (main = c);
    // breadth-first out from the through network, across the bridges
    const members = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      if (off[i]) continue;
      depth[i] = find(i) === main ? 0 : -1;
      let m = members.get(find(i));
      if (!m) members.set(find(i), (m = []));
      m.push(i);
    }
    let frontier: number[] = [];
    for (let i = 0; i < n; i++) if (depth[i] === 0) frontier.push(i);
    for (let d = 1; frontier.length; d++) {
      const next: number[] = [];
      for (const v of frontier)
        for (let k = 0; k < adj[v].length; k += 2) {
          const w = adj[v][k];
          if (depth[w] !== -1) continue;
          // the whole component behind the bridge gets the same depth
          for (const j of members.get(find(w))!) (depth[j] = d), next.push(j);
        }
      frontier = next;
    }
    // networks not connected to the city at all: wander freely
    for (let i = 0; i < n; i++) if (depth[i] === -1) depth[i] = 1;
    return depth;
  }

  private addToGrid(grid: Map<number, number[]>, idx: number, arr: Float32Array, pad: number) {
    this.addBoxToGrid(grid, idx, arr[idx], arr[idx + 1], arr[idx + 2], arr[idx + 3], pad);
  }
  private addBoxToGrid(grid: Map<number, number[]>, idx: number, ax: number, ay: number, bx: number, by: number, pad: number) {
    const gx0 = Math.floor((Math.min(ax, bx) - pad) / CELL), gx1 = Math.floor((Math.max(ax, bx) + pad) / CELL);
    const gy0 = Math.floor((Math.min(ay, by) - pad) / CELL), gy1 = Math.floor((Math.max(ay, by) + pad) / CELL);
    for (let gx = gx0; gx <= gx1; gx++)
      for (let gy = gy0; gy <= gy1; gy++) {
        const k = this.key(gx, gy);
        let c = grid.get(k);
        if (!c) grid.set(k, (c = []));
        c.push(idx);
      }
  }
  private key(gx: number, gy: number) {
    return (gx + 2000) * 8192 + gy + 2000;
  }

  /** Parts of the wall A->B (as [u0, u1] fractions along it, sorted and merged) that lie inside a
   *  passage corridor, i.e. where the wall is open. `shrink` narrows every corridor (m). */
  passageSpans(ax: number, ay: number, bx: number, by: number, shrink = 0): [number, number][] {
    if (!this.passages.length) return NO_SPANS;
    const spans: [number, number][] = [];
    const gx0 = Math.floor(Math.min(ax, bx) / CELL), gx1 = Math.floor(Math.max(ax, bx) / CELL);
    const gy0 = Math.floor(Math.min(ay, by) / CELL), gy1 = Math.floor(Math.max(ay, by) / CELL);
    const seen = new Set<number>();
    for (let gx = gx0; gx <= gx1; gx++)
      for (let gy = gy0; gy <= gy1; gy++) {
        for (const id of this.passageGrid.get(this.key(gx, gy)) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          const ps = this.passages[id >> 16], k = id & 65535, p = ps.p;
          const s = capsuleSpan(ax, ay, bx, by, p[k], p[k + 1], p[k + 2], p[k + 3], ps.hw - shrink);
          if (s) spans.push(s);
        }
      }
    if (spans.length < 2) return spans;
    spans.sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [spans[0]];
    for (let i = 1; i < spans.length; i++) {
      const last = out[out.length - 1];
      if (spans[i][0] <= last[1]) last[1] = Math.max(last[1], spans[i][1]);
      else out.push(spans[i]);
    }
    return out;
  }

  /** Side walls of every passage: its corridor edges, kept only where they run inside a solid
   *  building and outside every (other) corridor, so crossing passages stay open. */
  private passageWalls(wall: (ax: number, ay: number, bx: number, by: number, ht: number, flags: number) => void) {
    for (const ps of this.passages) {
      const p = ps.p, hw = ps.hw;
      const pb = bboxOf(p, hw + 1);
      const near: Building[] = [];
      this.forBuildingsNear(pb.x0, pb.y0, pb.x1, pb.y1, (b) => b.solid && near.push(b));
      if (!near.length) continue;
      for (const side of [1, -1]) {
        // corridor edge: each segment offset sideways, consecutive offsets joined at the bends
        const edge: number[] = [];
        for (let k = 0; k < p.length - 2; k += 2) {
          const dx = p[k + 2] - p[k], dy = p[k + 3] - p[k + 1];
          const l = Math.hypot(dx, dy) || 1;
          const ox = (-dy / l) * hw * side, oy = (dx / l) * hw * side;
          if (edge.length) edge.push(edge[edge.length - 2], edge[edge.length - 1], p[k] + ox, p[k + 1] + oy);
          edge.push(p[k] + ox, p[k + 1] + oy, p[k + 2] + ox, p[k + 3] + oy);
        }
        for (let k = 0; k < edge.length; k += 4) {
          const ax = edge[k], ay = edge[k + 1], bx = edge[k + 2], by = edge[k + 3];
          if (Math.hypot(bx - ax, by - ay) < 1e-3) continue;
          // split where it crosses a nearby building outline, keep the pieces inside a building
          const cuts = [0, 1];
          for (const b of near)
            for (const r of b.rings)
              for (let i = 0; i < r.length - 2; i += 2) {
                const t = segIntersect(ax, ay, bx, by, r[i], r[i + 1], r[i + 2], r[i + 3]);
                if (t > 0 && t < 1) cuts.push(t);
              }
          cuts.sort((a, b) => a - b);
          for (let c = 0; c < cuts.length - 1; c++) {
            const t0 = cuts[c], t1 = cuts[c + 1];
            if (t1 - t0 < 1e-4) continue;
            const mx = ax + (bx - ax) * ((t0 + t1) / 2), my = ay + (by - ay) * ((t0 + t1) / 2);
            if (!near.some((b) => pointInRings(mx, my, b.rings))) continue;
            const sx = ax + (bx - ax) * t0, sy = ay + (by - ay) * t0, ex = ax + (bx - ax) * t1, ey = ay + (by - ay) * t1;
            // ...minus where it runs through a corridor (the other passages, and this one's own bends)
            let u = 0;
            for (const [u0, u1] of this.passageSpans(sx, sy, ex, ey, 0.05)) {
              if (u0 > u) wall(sx + (ex - sx) * u, sy + (ey - sy) * u, sx + (ex - sx) * u0, sy + (ey - sy) * u0, 0, W_SIGHT);
              u = Math.max(u, u1);
            }
            if (u < 1) wall(sx + (ex - sx) * u, sy + (ey - sy) * u, ex, ey, 0, W_SIGHT);
          }
        }
      }
    }
  }

  /** True when (x, y) is within `pad` of any street's or path's roadway. */
  private nearRoad(x: number, y: number, pad: number) {
    const c = this.surfGrid.get(this.key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!c) return false;
    const s = this.surfSegs;
    for (const i of c) {
      const r = s[i + 4] + pad;
      if (segDist2(x, y, s[i], s[i + 1], s[i + 2], s[i + 3]) < r * r) return true;
    }
    return false;
  }

  /** Trees: the map's real ones (single trees, tree rows), then woods and parks filled in where
   *  nobody mapped individual trees. Deterministic; x, y, canopy radius, seed per tree. */
  private placeTrees(): Float32Array {
    const out: number[] = [];
    const grid = new Map<number, number[]>();
    const G = 8;
    const crowded = (x: number, y: number, r: number) => {
      for (let gx = Math.floor((x - r) / G); gx <= Math.floor((x + r) / G); gx++)
        for (let gy = Math.floor((y - r) / G); gy <= Math.floor((y + r) / G); gy++)
          for (const i of grid.get(gx * 4096 + gy) ?? []) if ((out[i] - x) ** 2 + (out[i + 1] - y) ** 2 < r * r) return true;
      return false;
    };
    const add = (x: number, y: number, seed: number) => {
      if (out.length / 4 >= MAX_TREES) return;
      const r = rng(seed);
      const k = Math.floor(x / G) * 4096 + Math.floor(y / G);
      let c = grid.get(k);
      if (!c) grid.set(k, (c = []));
      c.push(out.length);
      out.push(x, y, 2 + r() * 2.5, seed);
    };
    const real = this.data.trees;
    if (real) for (let i = 0; i < real.length; i += 2) add(real[i], real[i + 1], (real[i] * 7349 + real[i + 1] * 613) | 0);
    // woods and parks: scattered, clear of buildings, bridge decks and the real trees
    const scatter = (kind: 'wood' | 'green', perM2: number, maxPer: number) => {
      for (const rings of this.data.areas[kind]) {
        const bb = bboxOf(rings[0]);
        const area = ringArea(rings[0]);
        const n = Math.min(maxPer, Math.round(area / perM2));
        const r = rng(((bb.x0 * 131) ^ (bb.y0 * 977) ^ (n * 17)) | 0);
        let placed = 0, tries = 0;
        while (placed < n && tries < n * 6 && out.length / 4 < MAX_TREES) {
          tries++;
          const x = bb.x0 + r() * (bb.x1 - bb.x0);
          const y = bb.y0 + r() * (bb.y1 - bb.y0);
          if (!pointInRings(x, y, rings)) continue;
          placed++;
          if (this.insideBuilding(x, y) || this.onBridge(x, y) || crowded(x, y, 3.5)) continue;
          add(x, y, (x * 7349 + y * 613 + tries * 97) | 0);
        }
      }
    };
    scatter('wood', 85, 500);
    scatter('green', 260, 220);
    // maps without real trees: rows along the major streets, as before
    if (!real)
      for (const rd of this.data.roads) {
        if (rd.c > 4 || rd.b) continue;
        const side = rng((rd.p[0] * 31) ^ (rd.p[1] * 17))() < 0.5 ? 1 : -1;
        for (let i = 0; i < rd.p.length - 2; i += 2) {
          const ax = rd.p[i], ay = rd.p[i + 1], bx = rd.p[i + 2], by = rd.p[i + 3];
          const l = Math.hypot(bx - ax, by - ay);
          const off = rd.w / 2 + 1.5;
          for (let d = 7; d < l; d += 15) {
            const x = ax + ((bx - ax) * d) / l + ((ay - by) / l) * off * side, y = ay + ((by - ay) * d) / l + ((bx - ax) / l) * off * side;
            if (!this.insideBuilding(x, y)) add(x, y, (x * 331 + y * 971) | 0);
          }
        }
      }
    return Float32Array.from(out);
  }

  /** Visit wall segments near a circle. */
  forWalls(x: number, y: number, r: number, fn: (ax: number, ay: number, bx: number, by: number, ht: number, flags: number) => void) {
    const gx0 = Math.floor((x - r) / CELL), gx1 = Math.floor((x + r) / CELL);
    const gy0 = Math.floor((y - r) / CELL), gy1 = Math.floor((y + r) / CELL);
    const seen = gx0 === gx1 && gy0 === gy1 ? null : new Set<number>();
    const w = this.walls;
    for (let gx = gx0; gx <= gx1; gx++)
      for (let gy = gy0; gy <= gy1; gy++) {
        const c = this.wallGrid.get(this.key(gx, gy));
        if (!c) continue;
        for (const i of c) {
          if (seen) {
            if (seen.has(i)) continue;
            seen.add(i);
          }
          fn(w[i], w[i + 1], w[i + 2], w[i + 3], w[i + 4], w[i + 5]);
        }
      }
  }

  /** Push a circle out of walls, and (with level 1 and `rails`) off a bridge deck's railings, or
   *  (with level -1) back inside its tunnel. On a deck the low ground obstacles below it (fences,
   *  trunks) don't count. Returns the collision normal and depth (or null). */
  collideCircle(x: number, y: number, r: number, level?: Level, rails = true): { nx: number; ny: number; depth: number } | null {
    let px = x, py = y, hit = false;
    if (level === -1) {
      // underground: only the tube walls matter
      const f = this.tubeFit(px, py, r);
      if (f && !f.on && !f.out) {
        px += f.nx * f.depth;
        py += f.ny * f.depth;
        hit = true;
      }
    } else {
      const deck = level === 1 || level === 2;
      for (let iter = 0; iter < 3; iter++) {
        let moved = false;
        this.forWalls(px, py, r, (ax, ay, bx, by, ht, flags) => {
          if (flags & W_NOHIT || (deck && flags & W_LOW)) return;
          const rr = r + ht;
          if ((ax < bx ? ax : bx) - rr > px || (ax > bx ? ax : bx) + rr < px || (ay < by ? ay : by) - rr > py || (ay > by ? ay : by) + rr < py) return;
          const dx = bx - ax, dy = by - ay;
          const l2 = dx * dx + dy * dy;
          let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const cx = ax + dx * t, cy = ay + dy * t;
          const ex = px - cx, ey = py - cy;
          const d2 = ex * ex + ey * ey;
          if (d2 < rr * rr) {
            const d = Math.sqrt(d2) || 1e-4;
            const push = rr - d;
            px += (ex / d) * push;
            py += (ey / d) * push;
            hit = moved = true;
          }
        });
        if (!moved) break;
      }
      if (deck && rails) {
        const rp = this.railPush(px, py, r, level!);
        if (rp) {
          px += rp.nx * rp.depth;
          py += rp.ny * rp.depth;
          hit = true;
        }
      }
    }
    // world edge
    const b = this.bounds;
    if (px < b.x0 + r) (px = b.x0 + r), (hit = true);
    if (px > b.x1 - r) (px = b.x1 - r), (hit = true);
    if (py < b.y0 + r) (py = b.y0 + r), (hit = true);
    if (py > b.y1 - r) (py = b.y1 - r), (hit = true);
    if (!hit) return null;
    const nx = px - x, ny = py - y;
    const depth = Math.hypot(nx, ny);
    if (depth < 1e-6) return null;
    return { nx: nx / depth, ny: ny / depth, depth };
  }

  /** First wall that blocks sight (buildings, masonry walls, hedges; not fences) along a ray;
   *  returns fraction t in [0, 1] or 1. Underground (level -1) nothing on the surface is in the way. */
  raycast(ax: number, ay: number, bx: number, by: number, level?: Level): number {
    if (level === -1) return 1;
    let best = 1;
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len / CELL));
    const seen = new Set<number>();
    for (let s = 0; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps;
      const c = this.wallGrid.get(this.key(Math.floor(x / CELL), Math.floor(y / CELL)));
      if (c) {
        const w = this.walls;
        for (const i of c) {
          if (seen.has(i)) continue;
          seen.add(i);
          if (!(w[i + 5] & W_SIGHT)) continue;
          const t = segIntersect(ax, ay, bx, by, w[i], w[i + 1], w[i + 2], w[i + 3]);
          if (t >= 0 && t < best) best = t;
        }
      }
      if (best < 1 && (s + 1) / steps > best + CELL / len) break;
    }
    return best;
  }

  /** Where a circle of radius `r` is relative to the nearest bridge deck it fits on (decks too
   *  narrow for it, e.g. footbridges for a bus, are ignored). It is `on` a deck while within any
   *  deck segment's railings or past one of its open ends. Null when no such deck is nearby.
   *  Returns a shared scratch object: read it before the next call. */
  private deckFit(x: number, y: number, r: number, level = 0): DeckFit | null {
    const c = this.roadGrid.get(this.key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!c) return null;
    const s = this.roadSegs, f = this.fit;
    let any = false;
    f.depth = Infinity;
    for (const i of c) {
      if (!s[i + 6] || (level && s[i + 6] !== level)) continue;
      const limit = s[i + 4] - r;
      if (limit <= 0) continue;
      const ax = s[i], ay = s[i + 1], bx = s[i + 2], by = s[i + 3];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const len = Math.sqrt(l2) || 1;
      const tr = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      any = true;
      // past an open deck end (and still close to it, not beside some other deck's end)
      const openHere = tr < 0 ? s[i + 7] && (x - ax) ** 2 + (y - ay) ** 2 < (s[i + 4] + 1.5) ** 2 : tr > 1 && s[i + 8] && (x - bx) ** 2 + (y - by) ** 2 < (s[i + 4] + 1.5) ** 2;
      if (openHere) {
        f.on = true;
        f.depth = 0;
        (f.ux = dx / len), (f.uy = dy / len), (f.level = s[i + 6] as 1 | 2);
        return f;
      }
      const t = tr < 0 ? 0 : tr > 1 ? 1 : tr;
      const ex = x - (ax + dx * t), ey = y - (ay + dy * t);
      const d = Math.hypot(ex, ey) || 1e-4;
      if (d <= limit) {
        f.on = true;
        f.depth = 0;
        (f.ux = dx / len), (f.uy = dy / len), (f.level = s[i + 6] as 1 | 2);
        return f;
      }
      if (d - limit < f.depth) (f.depth = d - limit), (f.nx = -ex / d), (f.ny = -ey / d), (f.ux = dx / len), (f.uy = dy / len), (f.level = s[i + 6] as 1 | 2);
    }
    if (!any) return null;
    f.on = false;
    return f;
  }

  /** Push a circle on a bridge deck back inside the railings. It only pushes when the circle is
   *  outside every deck it fits on (twin carriageways and multi-segment decks don't fight each
   *  other), never at an open deck end, and never by more than a small correction: anything
   *  further out isn't really on that deck, and `updateLevel` drops it back to ground level. */
  private railPush(x: number, y: number, r: number, level: number): { nx: number; ny: number; depth: number } | null {
    const f = this.deckFit(x, y, r, level);
    if (!f || f.on || f.depth > r + 1) return null;
    return { nx: f.nx, ny: f.ny, depth: f.depth };
  }

  /** Where a circle of radius `r` is relative to the tunnel tubes it fits in: inside one, out past
   *  a portal (back at the surface), or how far outside the nearest tube's walls. Null when no
   *  tube is nearby. Returns a shared scratch object. */
  private tubeFit(x: number, y: number, r: number): TubeFit | null {
    const c = this.tubeGrid.get(this.key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!c) return null;
    const s = this.tubeSegs, f = this.tfit;
    let any = false;
    f.depth = Infinity;
    f.on = f.out = false;
    for (const i of c) {
      const limit = Math.max(0.05, s[i + 4] - r);
      const ax = s[i], ay = s[i + 1], bx = s[i + 2], by = s[i + 3];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const tr = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      any = true;
      if ((tr < 0 && s[i + 5]) || (tr > 1 && s[i + 6])) {
        // beyond a portal: out of the tunnel if it is close to that portal
        const px = tr < 0 ? ax : bx, py = tr < 0 ? ay : by;
        if ((x - px) ** 2 + (y - py) ** 2 < (s[i + 4] + 1.5) ** 2) {
          f.out = true;
          f.depth = 0;
          return f;
        }
      }
      const t = tr < 0 ? 0 : tr > 1 ? 1 : tr;
      const ex = x - (ax + dx * t), ey = y - (ay + dy * t);
      const d = Math.hypot(ex, ey) || 1e-4;
      if (d <= limit) {
        f.on = true;
        f.depth = 0;
        return f;
      }
      if (d - limit < f.depth) (f.depth = d - limit), (f.nx = -ex / d), (f.ny = -ey / d);
    }
    return any ? f : null;
  }

  /** Update an entity's level: 1 on a bridge deck, -1 in a tunnel, else 0. (vx, vy) is its
   *  velocity and `r` its radius. From the ground it only goes up at an open deck end (or down at
   *  a tunnel portal), moving along the deck (tube) into it, and only into one it fits: traffic
   *  passing underneath near a deck end (e.g. along Staromestská under Albertova lávka) stays below.
   *  `rescue` also lifts an entity that ended up underneath a deck over water while travelling
   *  along it, so a missed ramp can't drown it. It drops back to 0 once it leaves the bridge
   *  footprint or strays well off every deck it fits on, or leaves a tunnel through a portal. */
  updateLevel(e: { x: number; y: number; level: Level }, vx: number, vy: number, r: number, rescue = true) {
    if (e.level === -1) {
      const f = this.tubeFit(e.x, e.y, r);
      if (!f || f.out || f.depth > r + 2) e.level = 0;
      return;
    }
    const sp = Math.hypot(vx, vy);
    if (e.level === 0 && sp >= 0.3 && this.atPortal(e.x, e.y, vx, vy, sp, r)) {
      e.level = -1;
      return;
    }
    if (!this.onBridge(e.x, e.y)) {
      e.level = 0;
      return;
    }
    if (e.level >= 1) {
      const f = this.deckFit(e.x, e.y, r, e.level);
      if (f && (f.on || f.depth <= r + 1)) return;
      // off the end of its deck: onto a deck of the other level it carries on along (a ramp
      // rising onto a flyover), else down on the ground
      e.level = sp >= 0.3 ? this.deckAlong(e.x, e.y, vx / sp, vy / sp, r, e.level === 1 ? 2 : 1) : 0;
      return;
    }
    if (sp < 0.3) return;
    const ends = this.bridgeEnds;
    for (let i = 0; i < ends.length; i += END) {
      const hw = ends[i + 4];
      if (hw - r < DECK_FIT) continue;
      const dx = e.x - ends[i], dy = e.y - ends[i + 1];
      const ux = ends[i + 2], uy = ends[i + 3];
      const along = dx * ux + dy * uy;
      if (along < -(hw + 2) || along > 12 || Math.abs(dx * uy - dy * ux) > hw) continue;
      if (vx * ux + vy * uy < 0.5 * sp) continue;
      e.level = ends[i + 5] as 1 | 2;
      return;
    }
    if (rescue && this.inWater(e.x, e.y, 0)) {
      const lv = this.deckAlong(e.x, e.y, vx / sp, vy / sp, r);
      if (lv) e.level = lv;
    }
  }

  /** Just inside a tunnel portal, heading into the tunnel along it, and fitting in the tube. */
  private atPortal(x: number, y: number, vx: number, vy: number, sp: number, r: number) {
    const pt = this.portals;
    for (let i = 0; i < pt.length; i += END) {
      const hw = pt[i + 4];
      if (hw - r < DECK_FIT * 0.5) continue;
      const dx = x - pt[i], dy = y - pt[i + 1];
      const ux = pt[i + 2], uy = pt[i + 3];
      const along = dx * ux + dy * uy;
      if (along < 0 || along > 6 || Math.abs(dx * uy - dy * ux) > hw) continue;
      if (vx * ux + vy * uy < 0.5 * sp) continue;
      return true;
    }
    return false;
  }

  /** The level of a deck the circle is on, fits on and is heading along (within ~37°), upper
   *  decks first, or 0. `only` restricts it to one level. */
  private deckAlong(x: number, y: number, hx: number, hy: number, r: number, only = 0): 0 | 1 | 2 {
    for (const lv of [2, 1] as const) {
      if (only && lv !== only) continue;
      const f = this.deckFit(x, y, r + DECK_FIT, lv);
      if (f && f.on && Math.abs(hx * f.ux + hy * f.uy) > 0.8) return lv;
    }
    return 0;
  }

  /** Level for something that has just appeared at (x, y) facing `angle` (spawned traffic,
   *  parked cars, trams, pedestrians): the deck's level if it is on a deck it fits on, heading
   *  along it (or, with no heading, only when over water so pedestrians under a deck stay
   *  underneath); -1 if it is well inside a tunnel heading along it. */
  spawnLevel(x: number, y: number, r: number, angle?: number): Level {
    if (angle !== undefined && this.tunnelDepth(x, y) > 6) {
      const f = this.tubeFit(x, y, r);
      if (f && f.on) return -1;
    }
    if (!this.onBridge(x, y)) return 0;
    if (angle === undefined) {
      const f = this.deckFit(x, y, r + DECK_FIT);
      return f && f.on && this.inWater(x, y, 0) ? f.level : 0;
    }
    return this.deckAlong(x, y, Math.cos(angle), Math.sin(angle), r);
  }

  /** How far into a tunnel (x, y) is, in metres from the nearest portal (Infinity deep inside),
   *  or -1 when it isn't inside any tube's footprint. */
  tunnelDepth(x: number, y: number): number {
    const c = this.tubeGrid.get(this.key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!c) return -1;
    const s = this.tubeSegs;
    let inside = false;
    for (const i of c) {
      const ax = s[i], ay = s[i + 1], bx = s[i + 2], by = s[i + 3];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const tr = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      if ((tr < 0 && s[i + 5]) || (tr > 1 && s[i + 6])) continue;
      const t = tr < 0 ? 0 : tr > 1 ? 1 : tr;
      if ((x - ax - dx * t) ** 2 + (y - ay - dy * t) ** 2 <= (s[i + 4] + 0.5) ** 2) inside = true;
    }
    if (!inside) return -1;
    let depth = Infinity;
    const pt = this.portals;
    for (let i = 0; i < pt.length; i += END) {
      const dx = x - pt[i], dy = y - pt[i + 1];
      const along = dx * pt[i + 2] + dy * pt[i + 3];
      if (along >= -0.5 && Math.abs(dx * pt[i + 3] - dy * pt[i + 2]) < pt[i + 4] + 2) depth = Math.min(depth, Math.max(0, along));
    }
    return depth;
  }

  insideBuilding(x: number, y: number) {
    const c = this.buildingGrid.get(this.key(Math.floor(x / BCELL), Math.floor(y / BCELL)));
    if (!c) return false;
    for (const i of c) {
      const b = this.buildings[i], bb = b.bboxAll;
      if (!b.solid || x < bb.x0 || x > bb.x1 || y < bb.y0 || y > bb.y1) continue;
      if (pointInRings(x, y, b.rings)) return true;
    }
    return false;
  }

  /** Visit every building whose `bboxAll` overlaps the box, once each. */
  forBuildingsNear(x0: number, y0: number, x1: number, y1: number, fn: (b: Building) => void) {
    const stamp = ++this.stamp;
    const seen = this.buildingStamp;
    for (let gx = Math.floor(x0 / BCELL); gx <= Math.floor(x1 / BCELL); gx++)
      for (let gy = Math.floor(y0 / BCELL); gy <= Math.floor(y1 / BCELL); gy++) {
        const c = this.buildingGrid.get(this.key(gx, gy));
        if (!c) continue;
        for (const i of c) {
          if (seen[i] === stamp) continue;
          seen[i] = stamp;
          const bb = this.buildings[i].bboxAll;
          if (bb.x1 < x0 || bb.x0 > x1 || bb.y1 < y0 || bb.y0 > y1) continue;
          fn(this.buildings[i]);
        }
      }
  }

  /** `level`: pass an entity's level so someone underneath a deck (0) still drowns in the water
   *  below it, while the default (omitted) keeps the bridge footprint dry, as before. Piers and
   *  pontoons are dry; tunnels (-1) never are wet. */
  inWater(x: number, y: number, level?: Level) {
    if (level === -1) return false;
    const gx = Math.floor((x - this.bounds.x0) / WCELL), gy = Math.floor((y - this.bounds.y0) / WCELL);
    const cell = gx >= 0 && gx < this.waterCols && gy >= 0 ? this.waterCells[gy * this.waterCols + gx] : 2;
    if (cell === 0) return false;
    if (cell === 1) return !this.onPier(x, y) && (level === 0 || !this.onBridge(x, y));
    for (const w of this.water) {
      if (x < w.bbox.x0 || x > w.bbox.x1 || y < w.bbox.y0 || y > w.bbox.y1) continue;
      if (!pointInRings(x, y, w.rings)) continue;
      if (this.onPier(x, y)) return false;
      if (level === 0 || !this.onBridge(x, y)) return true;
    }
    return false;
  }

  /** Fill `waterCells`: cells a shore line passes through are "look closer" (2); every other cell
   *  is all wet or all dry, whichever its centre is. */
  private rasterWater() {
    const B = this.bounds;
    const cols = Math.ceil((B.x1 - B.x0) / WCELL) + 1, rows = Math.ceil((B.y1 - B.y0) / WCELL) + 1;
    const cells = new Uint8Array(cols * rows).fill(255);
    const mark = (x: number, y: number) => {
      const gx = Math.floor((x - B.x0) / WCELL), gy = Math.floor((y - B.y0) / WCELL);
      for (let ix = gx - 1; ix <= gx + 1; ix++)
        for (let iy = gy - 1; iy <= gy + 1; iy++) if (ix >= 0 && iy >= 0 && ix < cols && iy < rows) cells[iy * cols + ix] = 2;
    };
    for (const w of this.water)
      for (const r of w.rings)
        for (let i = 0; i < r.length - 2; i += 2) {
          const L = Math.hypot(r[i + 2] - r[i], r[i + 3] - r[i + 1]);
          for (let d = 0; d <= L; d += WCELL / 2) mark(r[i] + ((r[i + 2] - r[i]) * d) / L, r[i + 1] + ((r[i + 3] - r[i + 1]) * d) / L);
        }
    for (let gy = 0; gy < rows; gy++)
      for (let gx = 0; gx < cols; gx++) {
        const k = gy * cols + gx;
        if (cells[k] === 2) continue;
        const x = B.x0 + (gx + 0.5) * WCELL, y = B.y0 + (gy + 0.5) * WCELL;
        cells[k] = this.water.some((w) => x >= w.bbox.x0 && x <= w.bbox.x1 && y >= w.bbox.y0 && y <= w.bbox.y1 && pointInRings(x, y, w.rings)) ? 1 : 0;
      }
    this.waterCells = cells;
    this.waterCols = cols;
  }

  /** On a pier or pontoon (a walkable deck over the water). */
  onPier(x: number, y: number) {
    for (const p of this.piers) {
      if (x < p.bbox.x0 || x > p.bbox.x1 || y < p.bbox.y0 || y > p.bbox.y1) continue;
      if (pointInRings(x, y, p.rings)) return true;
    }
    return false;
  }

  /** Within the footprint of a bridge deck (of the given level; any by default). */
  onBridge(x: number, y: number, level = 0) {
    const k = this.key(Math.floor(x / CELL), Math.floor(y / CELL));
    if (!this.bridgeCells.has(k)) return false;
    const c = this.roadGrid.get(k);
    if (!c) return false;
    const s = this.roadSegs;
    for (const i of c) {
      if (!s[i + 6] || (level && s[i + 6] !== level)) continue;
      const hw = s[i + 4] + 1.5;
      if (segDist2(x, y, s[i], s[i + 1], s[i + 2], s[i + 3]) < hw * hw) return true;
    }
    return false;
  }

  /** Name of the nearest named street within ~15 m. */
  streetName(x: number, y: number): string | null {
    const c = this.roadGrid.get(this.key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!c) return null;
    const s = this.roadSegs;
    let best = -1, bestD = Infinity;
    for (const i of c) {
      if (s[i + 5] < 0) continue;
      const d = Math.sqrt(segDist2(x, y, s[i], s[i + 1], s[i + 2], s[i + 3])) - s[i + 4];
      if (d < bestD) (bestD = d), (best = s[i + 5]);
    }
    return best >= 0 && bestD < 15 ? this.names[best] : null;
  }

  /** Surface under a point, for tyre grip/drag: bridge deck, steps (class 10: a car crawls down them),
   *  up on a traffic island's kerb, cobble (pedestrian zones, class >= 8, and streets paved with
   *  setts), asphalt, or off-road. */
  surfaceAt(x: number, y: number, level?: Level): Surface {
    if (level === -1) return 'asphalt';
    if (this.onBridge(x, y)) return 'bridge';
    if (this.islands.at(x, y) >= 0) return 'kerb';
    const c = this.surfGrid.get(this.key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!c) return 'offroad';
    const s = this.surfSegs;
    let bestD = Infinity, bestCls = -1, bestPave = 0;
    for (const i of c) {
      const d = Math.sqrt(segDist2(x, y, s[i], s[i + 1], s[i + 2], s[i + 3])) - s[i + 4];
      if (d < bestD) (bestD = d), (bestCls = s[i + 5]), (bestPave = s[i + 6]);
    }
    if (bestD > 2) return 'offroad';
    return bestCls === 10 && bestD < 0.3 ? 'steps' : bestCls >= 8 || bestPave === 1 ? 'cobble' : 'asphalt';
  }

  /** Is (x, y) on a street cars drive on (or within `margin` of its edge)? */
  onCarriageway(x: number, y: number, margin = 0): boolean {
    const c = this.surfGrid.get(this.key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!c) return false;
    const s = this.surfSegs;
    for (const i of c) if (s[i + 5] <= 7 && Math.sqrt(segDist2(x, y, s[i], s[i + 1], s[i + 2], s[i + 3])) - s[i + 4] < margin) return true;
    return false;
  }

  /** The borough (mestská časť) a point is in, from the real boundaries; the nearest one for points
   *  outside all of them (the river between them). */
  district(x: number, y: number): string {
    if (!this.districts.length) return 'Staré Mesto';
    let best = this.districts[0].name, bd = Infinity;
    for (const d of this.districts) {
      const b = d.bbox;
      if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && pointInRings(x, y, d.rings)) return d.name;
      for (const r of d.rings)
        for (let i = 0; i < r.length - 2; i += 2) {
          const dd = segDist2(x, y, r[i], r[i + 1], r[i + 2], r[i + 3]);
          if (dd < bd) (bd = dd), (best = d.name);
        }
    }
    return best;
  }

  /** The named quarter (Vnútorné mesto, Podhradie, Dunajská štvrť…) nearest a point, within ~650 m,
   *  and in the same borough as the point. */
  quarter(x: number, y: number): string | null {
    let best: string | null = null, bd = 650 * 650;
    const here = this.district(x, y);
    for (const q of this.quarters) {
      const d = (q.x - x) ** 2 + (q.y - y) ** 2;
      if (d < bd && this.district(q.x, q.y) === here) (bd = d), (best = q.name);
    }
    return best;
  }

  /** the named square (x, y) is on, or null */
  squareAt(x: number, y: number): string | null {
    for (const q of this.squares) {
      const b = q.bbox;
      if (x >= b.x0 - 1 && x <= b.x1 + 1 && y >= b.y0 - 1 && y <= b.y1 + 1 && pointInRings(x, y, q.rings)) return q.name;
    }
    return null;
  }

  /** Visit the street furniture near (x, y): index into `furniture` (x, y, angle, kind at i..i+3). */
  forFurnitureNear(x: number, y: number, r: number, fn: (i: number) => void) {
    for (let gx = Math.floor((x - r) / CELL); gx <= Math.floor((x + r) / CELL); gx++)
      for (let gy = Math.floor((y - r) / CELL); gy <= Math.floor((y + r) / CELL); gy++) {
        const c = this.furnGrid.get(this.key(gx, gy));
        if (c) for (const i of c) fn(i);
      }
  }

  pois(kind: 'police' | 'hospital' | 'fuel' | 'shop') {
    return this.data.pois.filter((p) => p.k === kind);
  }

  /** Walkable spot near a point (outside buildings and water). */
  walkableNear(x: number, y: number) {
    const n = this.ped.nearest(x, y, 300);
    if (n >= 0) return { x: this.ped.nx(n), y: this.ped.ny(n) };
    return { x, y };
  }

  /** The nearest spot to (x, y) where a body of radius `r` stands clear of every wall, fountain,
   *  post and trunk, on dry ground (searching outwards in rings), for putting people down. */
  clearSpot(x: number, y: number, r = 0.5): { x: number; y: number } {
    const ok = (px: number, py: number) => !this.collideCircle(px, py, r, 0, false) && !this.inWater(px, py, 0) && !this.insideBuilding(px, py);
    if (ok(x, y)) return { x, y };
    for (let d = 0.75; d <= 30; d += 0.75)
      for (let k = 0, n = Math.ceil((d * 2 * Math.PI) / 0.75); k < n; k++) {
        const a = (k / n) * Math.PI * 2, px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
        if (ok(px, py)) return { x: px, y: py };
      }
    return { x, y };
  }

  landmark(id: string, fx = 0, fy = 0): Landmark {
    return this.landmarks.get(id) ?? { id, name: id, x: fx, y: fy };
  }
}

const NO_SPANS: [number, number][] = [];

/** Unit direction pointing into a polyline from its start (or end): toward the point ~3 m along
 *  (short first segments give a poor heading). */
function inward(p: ArrayLike<number>, fromEnd: boolean): [number, number] {
  const n = p.length;
  const x = fromEnd ? p[n - 2] : p[0], y = fromEnd ? p[n - 1] : p[1];
  let ix = x, iy = y;
  for (let k = 1; k < n / 2; k++) {
    const j = fromEnd ? n - 2 - k * 2 : k * 2;
    (ix = p[j]), (iy = p[j + 1]);
    if (Math.hypot(ix - x, iy - y) >= 3) break;
  }
  const d = Math.hypot(ix - x, iy - y) || 1;
  return [(ix - x) / d, (iy - y) / d];
}

/** The fractions [u0, u1] of segment A->B that lie within distance `r` of segment P->Q (the
 *  capsule around it), or null. The capsule is convex, so this is one interval: the union of the
 *  line's overlap with its middle band and with its two end discs. */
export function capsuleSpan(ax: number, ay: number, bx: number, by: number, px: number, py: number, qx: number, qy: number, r: number): [number, number] | null {
  if (r <= 0) return null;
  const dx = bx - ax, dy = by - ay;
  let lo = Infinity, hi = -Infinity;
  const disc = (cx: number, cy: number) => {
    const fx = ax - cx, fy = ay - cy;
    const a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - r * r;
    if (a < 1e-12) return;
    const D = b * b - 4 * a * c;
    if (D <= 0) return;
    const s = Math.sqrt(D);
    lo = Math.min(lo, (-b - s) / (2 * a));
    hi = Math.max(hi, (-b + s) / (2 * a));
  };
  disc(px, py);
  disc(qx, qy);
  const ex = qx - px, ey = qy - py;
  const len = Math.hypot(ex, ey);
  if (len > 1e-9) {
    const ux = ex / len, uy = ey / len;
    // along the band: 0 <= (X - P)·u <= len; across it: |(X - P)·n| < r (n = (-uy, ux))
    let l0 = -Infinity, l1 = Infinity;
    const slab = (a0: number, b0: number, min: number, max: number) => {
      // min < a0 + b0·u < max
      if (Math.abs(b0) < 1e-12) {
        if (a0 <= min || a0 >= max) (l0 = Infinity), (l1 = -Infinity);
        return;
      }
      let u0 = (min - a0) / b0, u1 = (max - a0) / b0;
      if (u0 > u1) [u0, u1] = [u1, u0];
      l0 = Math.max(l0, u0);
      l1 = Math.min(l1, u1);
    };
    slab((ax - px) * ux + (ay - py) * uy, dx * ux + dy * uy, 0, len);
    slab(-(ax - px) * uy + (ay - py) * ux, -dx * uy + dy * ux, -r, r);
    if (l0 < l1) (lo = Math.min(lo, l0)), (hi = Math.max(hi, l1));
  }
  lo = Math.max(0, lo);
  hi = Math.min(1, hi);
  return hi > lo ? [lo, hi] : null;
}

/** Signed area (positive for the winding whose (by-ay, ax-bx) edge normal points outward). */
function signedArea(r: ArrayLike<number>) {
  let a = 0;
  for (let i = 0; i < r.length - 2; i += 2) a += r[i] * r[i + 3] - r[i + 2] * r[i + 1];
  return a / 2;
}

/** OSM gives rings in either winding. Wind outer rings positive and courtyard holes negative, so
 *  wall normals and facade back-face tests work the same for every building. A ring is a hole
 *  when most of its vertices lie inside an odd number of the building's other rings. */
function orientRings(rings: Float32Array[]): Float32Array[] {
  return rings.map((r, i) => {
    let hole = false;
    if (rings.length > 1) {
      const others = rings.filter((_, j) => j !== i);
      let inside = 0;
      const n = r.length / 2 - 1;
      for (let k = 0; k < n; k++) if (pointInRings(r[k * 2], r[k * 2 + 1], others)) inside++;
      hole = inside * 2 > n;
    }
    if (signedArea(r) > 0 === !hole) return r;
    const out = new Float32Array(r.length);
    for (let k = 0; k < r.length; k += 2) (out[k] = r[r.length - 2 - k]), (out[k + 1] = r[r.length - 1 - k]);
    return out;
  });
}

/** Storeys to draw for a building OSM gives no height for (the map builder defaults them to 3,
 *  which makes whole streets one flat slab). Small sheds and kiosks get 1-2; otherwise a ~60 m
 *  cell picks 3 or 4 so a street stays coherent, and each building varies by one storey either
 *  way now and then, clamped to 2-5. Deterministic, and only visual (collision is 2D). */
function drawnLevels(area: number, cx: number, cy: number, seed: number): number {
  if (area < 30) return 1;
  if (area < 55) return 2;
  const cell = rng((Math.floor(cx / 60) * 73856093) ^ (Math.floor(cy / 60) * 19349663))();
  const own = rng((seed * 7717) ^ ((cx * 131) | 0) ^ ((cy * 977) | 0))();
  const base = cell < 0.55 ? 3 : 4;
  return Math.max(2, Math.min(5, base + (own < 0.15 ? -1 : own > 0.85 ? 1 : 0)));
}
