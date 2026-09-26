// Candidate spots for the daily "Kde to je?" puzzle (docs/plans/social-events.md). Shared and
// DOM-free (tsconfig.shared.json) so the Node test suite and the browser's photo mode (?photo,
// src/game/features/PhotoMode.ts) generate the exact same list from the same seed, and so
// scripts/spots-gen.mjs can pick a day's spot without either side guessing at the other's logic.
//
// A spot is deliberately unremarkable up close (no landmark, no name in view) but recognisable once
// you know the kind: a courtyard ringed by buildings, a marked crossing, a square, a riverside path,
// or a spot beside a distinctive roof. Every kind is sourced so its raw coordinate is already
// expected to be walkable (ped-graph nodes for courtyard/square/river; the map's own crossing
// coordinates; a building's nearest walkable point for roof); `tryAccept` below just confirms it and
// applies the shared distance, roof-clearance and visual-interest rules.
//
// There used to be a sixth kind, 'passage' (a gateway or covered corridor through a building). It's
// gone: a passage is architecturally *under* the building that spans it, so a real one is invisible
// from directly above no matter how it's framed — underAnyRoof() below rejects every one of them, by
// design, the same way it rejects a target actually inside a building (confirmed against the real
// map: 0 of ~130 passage candidates survived that check).
import type { World } from './World';
import { placePickups } from '../sim/Pickups';
import { Rng } from '../util/Rng';
import { dist, pointInRings, segDist2 } from '../util/math';

export type SpotKind = 'courtyard' | 'crossing' | 'square' | 'river' | 'roof';

export interface Spot {
  x: number;
  y: number;
  level: 0;
  kind: SpotKind;
  /** borough (mestská časť); always set (World.district falls back to the nearest one) */
  district: string;
  /** named quarter, or null within ~650 m of none */
  quarter: string | null;
  /** nearest named street within 40 m, or null */
  street: string | null;
}

const MIN_LANDMARK_DIST = 80;
const MIN_SPOT_SPACING = 150;
/** the courtyard-enclosure ray fan: this far out, this many rays, evenly spaced */
const COURTYARD_RADIUS = 25;
const COURTYARD_DIRECTIONS = 12;
const COURTYARD_MIN_HITS = 9;
/** the widest gap (in ray steps) a courtyard's "opening" may be: 2 steps = 60° of open sky, about a
 *  gateway's width, not a whole street frontage */
const COURTYARD_MAX_OPEN_RUN = 2;
/** a courtyard must be this far from any drivable road, or it's just a pavement beside one
 *  (docs/plans/social-events.md review: 2026-10-21 put the ✕ on a kerb, not a yard) */
const COURTYARD_ROAD_CLEARANCE = 12;
const RIVER_RADIUS = 15;
const WALKABLE_SLACK = 1.5;
const GRAPH_REACH = 15;
const STREET_HINT_RADIUS = 40;
/** how far around a spot counts for the "is there anything to look at here" score below */
const INTEREST_RADIUS = 25;
/** raw candidates scoring below this are rejected as too plain (tuned on real dry-run output: see
 *  visualInterestScore's doc comment) */
export const MIN_INTEREST_SCORE = 3;
/** the order candidates are round-robined in; also the mix `spots-gen.mjs` rotates through */
export const SPOT_KINDS: SpotKind[] = ['courtyard', 'crossing', 'square', 'river', 'roof'];
/** roofShape values (World.Building.roofShape, from BuildingJSON.rs) distinctive enough to spot from
 *  street level: pyramidal, dome, round, cone, an inverted pyramid. Flat/gabled/hipped/skillion and
 *  unset are far too common in Bratislava (skillion alone is 61 buildings) to read as "that one
 *  building" from a close-up photo. */
const DISTINCTIVE_ROOFS = new Set([4, 5, 7, 9, 10]);

/** Deterministic candidate spots, mixed across kinds and the three boroughs. Never uses Math.random. */
export function candidateSpots(world: World, n: number, seed: number): Spot[] {
  const rng = new Rng(seed);
  const exclude = exclusionPoints(world);
  const ctx = buildFeatureCtx(world);
  const nodes = nodePools(world, ctx.waterSegs);

  const pools: Record<SpotKind, { x: number; y: number }[]> = {
    courtyard: nodes.courtyards,
    crossing: ctx.crossings,
    square: nodes.squares,
    river: nodes.rivers,
    roof: roofCandidates(world),
  };
  // each kind's queue alternates districts, so a long run of one borough can't starve the others
  const queues = new Map(SPOT_KINDS.map((k) => [k, districtRoundRobin(world, shuffled(pools[k], rng), rng)]));

  const accepted: Spot[] = [];
  let anyLeft = true;
  while (accepted.length < n && anyLeft) {
    anyLeft = false;
    for (const kind of SPOT_KINDS) {
      if (accepted.length >= n) break;
      const q = queues.get(kind)!;
      if (!q.length) continue;
      anyLeft = true;
      // one accepted spot per kind per pass (round-robin): try candidates until one sticks or the queue empties
      let c: { x: number; y: number } | undefined;
      while ((c = q.shift())) {
        const spot = tryAccept(world, ctx, kind, c, exclude, accepted);
        if (spot) {
          accepted.push(spot);
          break;
        }
      }
    }
  }
  return accepted;
}

/** the shared per-candidate gate, cheapest checks first: on walkable ground, reachable on the ped
 *  graph, far enough from every landmark/fixed Čumil and every spot already accepted, never under a
 *  roof (a building really does hide its own footprint from directly above — that includes a passage
 *  tunnelled under one), and not too plain a scene once framed; null when any check fails */
function tryAccept(world: World, ctx: FeatureCtx, kind: SpotKind, c: { x: number; y: number }, exclude: { x: number; y: number }[], accepted: Spot[]): Spot | null {
  const w = world.walkableNear(c.x, c.y);
  if (dist(w.x, w.y, c.x, c.y) > WALKABLE_SLACK) return null;
  if (world.ped.nearest(c.x, c.y, GRAPH_REACH) < 0) return null;
  for (const e of exclude) if (dist(e.x, e.y, c.x, c.y) < MIN_LANDMARK_DIST) return null;
  for (const s of accepted) if (dist(s.x, s.y, c.x, c.y) < MIN_SPOT_SPACING) return null;
  if (underAnyRoof(world, c.x, c.y)) return null;
  if (visualInterestScore(world, ctx, c.x, c.y) < MIN_INTEREST_SCORE) return null;
  return {
    x: c.x,
    y: c.y,
    level: 0,
    kind,
    district: world.district(c.x, c.y),
    quarter: world.quarter(c.x, c.y),
    street: nearestStreetName(world, c.x, c.y, STREET_HINT_RADIUS),
  };
}

/** Every building the renderer actually draws as a roofed volume — `kind === 5` is the Most SNP
 *  pylon/UFO, drawn specially by Game.drawLandmarks, which photo mode never calls; a `hidden`
 *  outline draws its parts instead, which are their own separate building entries — covering
 *  (x, y) with its own footprint polygon. A real building really does block the view straight down
 *  no matter the camera height (unlike its *shifted* roof silhouette, which — because photo mode's
 *  camera is centred exactly on the candidate point — is a pure dilation of the footprint about
 *  that same point, and so can never sweep over it: see the review notes for why that first,
 *  more elaborate theory for the "✕ on a roof" reports turned out not to be the cause). A passage
 *  tunnelled under a building is exactly this case: its footprint still covers the tunnel below. */
export function underAnyRoof(world: World, x: number, y: number): boolean {
  let found = false;
  world.forBuildingsNear(x - 0.5, y - 0.5, x + 0.5, y + 0.5, (b) => {
    if (found || b.kind === 5 || b.hidden) return;
    if (pointInRings(x, y, b.rings)) found = true;
  });
  return found;
}

export interface FeatureCtx {
  waterSegs: Float32Array;
  tramSegs: Float32Array;
  crossings: { x: number; y: number }[];
}

/** builds the context visualInterestScore needs; exported so tests (and this module's own tuning)
 *  can call that scorer directly without re-running the whole candidate search */
export function buildFeatureCtx(world: World): FeatureCtx {
  return { waterSegs: waterSegments(world), tramSegs: tramSegments(world), crossings: crossingCandidates(world) };
}

/** Counts distinct "something to look at here" categories within INTEREST_RADIUS, each worth at most
 *  one point: two or more distinct buildings and at least one visually distinctive one (a hand-set
 *  colour, an uncommon roof shape, or a church/castle), trees, water, tram tracks, a marked crossing,
 *  street furniture, a named square. Rejects a spot that's just plain paving or a lone wall — found
 *  by looking at real dry-run photos (docs/plans/social-events.md's review), e.g. 2026-10-23's bare
 *  plaza. MIN_INTEREST_SCORE was tuned against a 60-candidate sample of the real map so that roughly
 *  one in three raw candidates fails it, per that review. */
export function visualInterestScore(world: World, ctx: FeatureCtx, x: number, y: number): number {
  let score = 0;
  let buildings = 0, distinctive = false;
  const shapes = new Set<number>();
  world.forBuildingsNear(x - INTEREST_RADIUS, y - INTEREST_RADIUS, x + INTEREST_RADIUS, y + INTEREST_RADIUS, (b) => {
    if (b.kind === 5 || b.hidden) return;
    buildings++;
    shapes.add(b.roofShape);
    if (b.color || b.wallColor || (b.roofShape && b.roofShape !== 0) || b.kind === 1 || b.kind === 2) distinctive = true;
  });
  if (buildings >= 2) score++;
  if (distinctive || shapes.size >= 2) score++;
  if (treesNear(world, x, y, INTEREST_RADIUS)) score++;
  if (distToSegs(ctx.waterSegs, x, y) <= INTEREST_RADIUS) score++;
  if (ctx.tramSegs.length && distToSegs(ctx.tramSegs, x, y) <= INTEREST_RADIUS) score++;
  if (ctx.crossings.some((cr) => dist(cr.x, cr.y, x, y) <= INTEREST_RADIUS)) score++;
  let furniture = false;
  world.forFurnitureNear(x, y, INTEREST_RADIUS, () => (furniture = true));
  if (furniture) score++;
  if (world.squareAt(x, y)) score++;
  return score;
}

function treesNear(world: World, x: number, y: number, r: number): boolean {
  const t = world.trees, r2 = r * r;
  for (let i = 0; i < t.length; i += 4) if ((t[i] - x) ** 2 + (t[i + 1] - y) ** 2 <= r2) return true;
  return false;
}

/** every tram track edge, flat [ax, ay, bx, by, ...], for the interest score above */
function tramSegments(world: World): Float32Array {
  const out: number[] = [];
  for (const line of world.data.trams) for (let i = 0; i < line.length - 2; i += 2) out.push(line[i], line[i + 1], line[i + 2], line[i + 3]);
  return Float32Array.from(out);
}

/** landmarks and the ten fixed (collectible) Čumil statues: everything a spot must stay 80 m from */
function exclusionPoints(world: World): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const l of world.landmarks.values()) out.push({ x: l.x, y: l.y });
  // placePickups() uses its own hardcoded seed (1337) for the Čumils, independent of our seed, and
  // is a pure read of `world` (no mutation), so calling it here just to read their spots is cheap and safe
  for (const p of placePickups(world)) if (p.kind === 'cumil') out.push({ x: p.x, y: p.y });
  return out;
}

// ---------------------------------------------------------------------------- ped-graph-sourced kinds
/** One pass over every ped-graph node with an outgoing edge (so it's already "reachable" by
 *  definition), bucketing each into every pool it qualifies for: inside a named square, a courtyard
 *  (ringed by buildings), or a dry spot within RIVER_RADIUS of the water. */
function nodePools(world: World, waterSegs: Float32Array) {
  const squares: { x: number; y: number }[] = [];
  const courtyards: { x: number; y: number }[] = [];
  const rivers: { x: number; y: number }[] = [];
  const g = world.ped, nodes = g.nodes;
  const wb = waterBounds(world);
  for (let i = 0; i < nodes.length / 2; i++) {
    if (!g.out[i].length) continue;
    const x = nodes[i * 2], y = nodes[i * 2 + 1];
    if (world.squareAt(x, y)) squares.push({ x, y });
    if (isCourtyard(world, x, y)) courtyards.push({ x, y });
    if (wb && x > wb.x0 && x < wb.x1 && y > wb.y0 && y < wb.y1 && !world.inWater(x, y) && distToSegs(waterSegs, x, y) <= RIVER_RADIUS) rivers.push({ x, y });
  }
  return { squares, courtyards, rivers };
}

/** `dirs` evenly-spaced rays out to `radius`: true where one hits a building first (a cheap "how
 *  enclosed is this point" reading, for the courtyard test below) */
function rayHitPattern(world: World, x: number, y: number, radius: number, dirs: number): boolean[] {
  const hits: boolean[] = [];
  for (let k = 0; k < dirs; k++) {
    const a = (k / dirs) * Math.PI * 2;
    hits.push(world.raycast(x, y, x + Math.cos(a) * radius, y + Math.sin(a) * radius, 0) < 1);
  }
  return hits;
}

/** longest run of consecutive `false` in a circular boolean list (the widest gap in the ray fan) */
function longestGap(hits: boolean[]): number {
  const start = hits.findIndex((h) => h);
  if (start < 0) return hits.length; // no hit at all: wide open on every side
  let longest = 0, run = 0;
  for (let i = 0; i < hits.length; i++) {
    if (hits[(start + i) % hits.length]) run = 0;
    else longest = Math.max(longest, ++run);
  }
  return longest;
}

/** A real, enclosed yard: away from any drivable road (not just a pavement beside one), with
 *  buildings hitting most of the ray fan and no gap wider than a gateway (COURTYARD_MAX_OPEN_RUN) —
 *  not one open side onto a street or a plaza. */
export function isCourtyard(world: World, x: number, y: number): boolean {
  if (world.onCarriageway(x, y, COURTYARD_ROAD_CLEARANCE)) return false;
  const hits = rayHitPattern(world, x, y, COURTYARD_RADIUS, COURTYARD_DIRECTIONS);
  return hits.filter(Boolean).length >= COURTYARD_MIN_HITS && longestGap(hits) <= COURTYARD_MAX_OPEN_RUN;
}

// ------------------------------------------------------------------------------------------ river
/** every water ring edge, flat [ax, ay, bx, by, ...] (rings repeat their closing vertex, so this
 *  covers every edge with no explicit wraparound needed) */
function waterSegments(world: World): Float32Array {
  const out: number[] = [];
  for (const shape of world.data.areas.water) for (const ring of shape) for (let i = 0; i < ring.length - 2; i += 2) out.push(ring[i], ring[i + 1], ring[i + 2], ring[i + 3]);
  return Float32Array.from(out);
}

/** one padded bbox over every water shape, to reject nodes nowhere near any of them before the
 *  per-segment distance check */
function waterBounds(world: World): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const shape of world.data.areas.water)
    for (const ring of shape)
      for (let i = 0; i < ring.length; i += 2) {
        if (ring[i] < x0) x0 = ring[i];
        if (ring[i] > x1) x1 = ring[i];
        if (ring[i + 1] < y0) y0 = ring[i + 1];
        if (ring[i + 1] > y1) y1 = ring[i + 1];
      }
  if (x0 > x1) return null;
  return { x0: x0 - RIVER_RADIUS, y0: y0 - RIVER_RADIUS, x1: x1 + RIVER_RADIUS, y1: y1 + RIVER_RADIUS };
}

function distToSegs(segs: Float32Array, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < segs.length; i += 4) {
    const d = segDist2(x, y, segs[i], segs[i + 1], segs[i + 2], segs[i + 3]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// ---------------------------------------------------------------------------------- other kinds
/** marked pedestrian crossings: flat [x, y, street direction, street width, ...] */
function crossingCandidates(world: World): { x: number; y: number }[] {
  const c = world.data.crossings ?? [];
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < c.length; i += 4) out.push({ x: c[i], y: c[i + 1] });
  return out;
}

/** buildings mapped in parts (a tower, a spire) or with a distinctive roof shape: the target is the
 *  nearest walkable point outside the building, i.e. beside it, not on top of it */
function roofCandidates(world: World): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const b of world.buildings) if (b.part || DISTINCTIVE_ROOFS.has(b.roofShape)) out.push(world.walkableNear(b.cx, b.cy));
  return out;
}

// -------------------------------------------------------------------------------------- ordering
function shuffled<T>(list: T[], rng: Rng): T[] {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** groups a (pre-shuffled) list by borough and interleaves the groups, so consuming it in order
 *  alternates districts instead of exhausting one before touching another */
function districtRoundRobin<T extends { x: number; y: number }>(world: World, list: T[], rng: Rng): T[] {
  const groups = new Map<string, T[]>();
  for (const c of list) {
    const d = world.district(c.x, c.y);
    let g = groups.get(d);
    if (!g) groups.set(d, (g = []));
    g.push(c);
  }
  // shuffled() already randomised order within the source list; re-shuffling per group keeps that
  // property after the grouping split it up, still deterministic for the given seed
  for (const g of groups.values()) shuffleInPlace(g, rng);
  const districts = [...groups.keys()];
  const out: T[] = [];
  let moved = true;
  while (moved) {
    moved = false;
    for (const d of districts) {
      const g = groups.get(d)!;
      if (g.length) {
        out.push(g.shift()!);
        moved = true;
      }
    }
  }
  return out;
}

function shuffleInPlace<T>(list: T[], rng: Rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
}

/** World.streetName only looks within ~15 m; ring outward up to `maxDist` for a hint when that
 *  misses (a courtyard or square whose nearest named street is a little further off) */
function nearestStreetName(world: World, x: number, y: number, maxDist: number): string | null {
  const direct = world.streetName(x, y);
  if (direct) return direct;
  const STEP = 5, ANGLES = 8;
  for (let r = STEP; r <= maxDist; r += STEP) {
    for (let k = 0; k < ANGLES; k++) {
      const a = (k / ANGLES) * Math.PI * 2;
      const name = world.streetName(x + Math.cos(a) * r, y + Math.sin(a) * r);
      if (name) return name;
    }
  }
  return null;
}
