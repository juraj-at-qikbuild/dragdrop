// Candidate spots for the daily "Kde to je?" puzzle (docs/plans/social-events.md). Shared and
// DOM-free (tsconfig.shared.json) so the Node test suite and the browser's photo mode (?photo,
// src/game/features/PhotoMode.ts) generate the exact same list from the same seed, and so
// scripts/spots-gen.mjs can pick a day's spot without either side guessing at the other's logic.
//
// A spot is deliberately unremarkable up close (no landmark, no name in view) but recognisable once
// you know the kind: a courtyard ringed by buildings, a marked crossing, a gateway passage, a square,
// a riverside path, or a spot beside a distinctive roof. Every kind is sourced so its raw coordinate
// is already expected to be walkable (ped-graph nodes for courtyard/square/river; the map's own
// crossing/passage coordinates; a building's nearest walkable point for roof); `tryAccept` below just
// confirms it and applies the shared distance rules.
import type { World } from './World';
import { placePickups } from '../sim/Pickups';
import { Rng } from '../util/Rng';
import { dist, segDist2 } from '../util/math';

export type SpotKind = 'courtyard' | 'crossing' | 'passage' | 'square' | 'river' | 'roof';

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
const COURTYARD_RADIUS = 30;
const COURTYARD_DIRECTIONS = 12;
const COURTYARD_MIN_HITS = 9;
const RIVER_RADIUS = 15;
const WALKABLE_SLACK = 1.5;
const GRAPH_REACH = 15;
const STREET_HINT_RADIUS = 40;
/** shorter passages are just a single archway with little either side to frame (see passageCandidates) */
const MIN_PASSAGE_LEN = 8;
/** a passage needs at least this many of the courtyard test's 12 rays to hit a building nearby, or
 *  the 45 m photo mostly shows the open plaza it opens onto instead of the gateway itself */
const MIN_PASSAGE_ENCLOSURE = 4;
/** the order candidates are round-robined in; also the mix `spots-gen.mjs` rotates through */
export const SPOT_KINDS: SpotKind[] = ['courtyard', 'crossing', 'passage', 'square', 'river', 'roof'];
/** roofShape values (World.Building.roofShape, from BuildingJSON.rs) distinctive enough to spot from
 *  street level: pyramidal, dome, round, cone, an inverted pyramid. Flat/gabled/hipped/skillion and
 *  unset are far too common in Bratislava (skillion alone is 61 buildings) to read as "that one
 *  building" from a tight 45 m photo. */
const DISTINCTIVE_ROOFS = new Set([4, 5, 7, 9, 10]);

/** Deterministic candidate spots, mixed across kinds and the three boroughs. Never uses Math.random. */
export function candidateSpots(world: World, n: number, seed: number): Spot[] {
  const rng = new Rng(seed);
  const exclude = exclusionPoints(world);
  const waterSegs = waterSegments(world);
  const nodes = nodePools(world, waterSegs);

  const pools: Record<SpotKind, { x: number; y: number }[]> = {
    courtyard: nodes.courtyards,
    crossing: crossingCandidates(world),
    passage: passageCandidates(world),
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
        const spot = tryAccept(world, kind, c, exclude, accepted);
        if (spot) {
          accepted.push(spot);
          break;
        }
      }
    }
  }
  return accepted;
}

/** the shared per-candidate gate: on walkable ground, reachable on the ped graph, and far enough from
 *  every landmark/fixed Čumil and every spot already accepted; null when any check fails */
function tryAccept(world: World, kind: SpotKind, c: { x: number; y: number }, exclude: { x: number; y: number }[], accepted: Spot[]): Spot | null {
  const w = world.walkableNear(c.x, c.y);
  if (dist(w.x, w.y, c.x, c.y) > WALKABLE_SLACK) return null;
  if (world.ped.nearest(c.x, c.y, GRAPH_REACH) < 0) return null;
  for (const e of exclude) if (dist(e.x, e.y, c.x, c.y) < MIN_LANDMARK_DIST) return null;
  for (const s of accepted) if (dist(s.x, s.y, c.x, c.y) < MIN_SPOT_SPACING) return null;
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

/** how many of `dirs` evenly-spaced rays out to `radius` hit a building first (a cheap "how enclosed
 *  is this point" reading, shared by the courtyard test and the passage one below) */
function buildingRayHits(world: World, x: number, y: number, radius: number, dirs: number): number {
  let hits = 0;
  for (let k = 0; k < dirs; k++) {
    const a = (k / dirs) * Math.PI * 2;
    if (world.raycast(x, y, x + Math.cos(a) * radius, y + Math.sin(a) * radius, 0) < 1) hits++;
  }
  return hits;
}

/** buildings within COURTYARD_RADIUS in at least COURTYARD_MIN_HITS of COURTYARD_DIRECTIONS rays */
function isCourtyard(world: World, x: number, y: number): boolean {
  return buildingRayHits(world, x, y, COURTYARD_RADIUS, COURTYARD_DIRECTIONS) >= COURTYARD_MIN_HITS;
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

/** the arc-length midpoint of every passage corridor long enough to actually read as a gateway once
 *  framed (a photo centred on one of the ~130 under MIN_PASSAGE_LEN, most just a couple of metres
 *  where a footway ducks under a single archway, is mostly bare wall either side: unrecognisable),
 *  and with enough building mass around it that the photo doesn't mostly show open plaza instead */
function passageCandidates(world: World): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const p of world.data.passages ?? []) {
    const len = polylineLen(p.p);
    if (len < MIN_PASSAGE_LEN) continue;
    const mid = midpointAlong(p.p, len);
    if (buildingRayHits(world, mid.x, mid.y, COURTYARD_RADIUS, COURTYARD_DIRECTIONS) >= MIN_PASSAGE_ENCLOSURE) out.push(mid);
  }
  return out;
}

function polylineLen(p: number[]): number {
  let total = 0;
  for (let i = 0; i < p.length - 2; i += 2) total += dist(p[i], p[i + 1], p[i + 2], p[i + 3]);
  return total;
}

function midpointAlong(p: number[], total: number): { x: number; y: number } {
  const half = total / 2;
  let acc = 0;
  for (let i = 0; i < p.length - 2; i += 2) {
    const segLen = dist(p[i], p[i + 1], p[i + 2], p[i + 3]);
    if (acc + segLen >= half || i + 4 >= p.length) {
      const t = segLen > 1e-6 ? (half - acc) / segLen : 0;
      return { x: p[i] + (p[i + 2] - p[i]) * t, y: p[i + 1] + (p[i + 3] - p[i + 1]) * t };
    }
    acc += segLen;
  }
  return { x: p[0], y: p[1] };
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
