// Vlk courier offers: where an order comes from (a food place) and where it goes (a street address),
// both picked at map-realistic distances from the real city data. Shared by both hosts — sim.rng
// only, never Math.random (see rules/jobs/Jobs.ts for the state machine that uses this).
// Plan: docs/plans/social-events.md ("Vlk courier / Hopík taxi").
import type { Sim } from '../../Sim';
import type { World } from '../../../world/World';
import { dist } from '../../../util/math';

export interface Pt {
  x: number;
  y: number;
  label: string;
}

export interface CourierOffer {
  pickup: Pt;
  drop: Pt;
  /** road distance pickup -> drop, metres (the timer and the per-metre pay both key off this) */
  routeM: number;
}

const PICKUP_RANGE: [number, number] = [200, 900];
const DROP_RANGE: [number, number] = [600, 1800];

/** Pick one of `list` within [min, max] m of (x, y), via `sim.rng`. Falls back to whichever entry is
 *  closest to the band when none qualify (a player standing in a corner of the map, or a short list),
 *  so an offer never simply fails to appear — it's just a little short or long that one time. */
export function pickInBand<T extends { x: number; y: number }>(sim: Sim, list: readonly T[], x: number, y: number, [min, max]: [number, number]): T | null {
  if (!list.length) return null;
  const inBand = list.filter((p) => {
    const d = dist(p.x, p.y, x, y);
    return d >= min && d <= max;
  });
  if (inBand.length) return sim.rng.pick(inBand);
  let best = list[0], err = Infinity;
  for (const p of list) {
    const d = dist(p.x, p.y, x, y);
    const e = d < min ? min - d : d > max ? d - max : 0;
    if (e < err) (err = e), (best = p);
  }
  return best;
}

/** Road distance a -> b: car-graph A* summing edge lengths, the same method the race challenge's
 *  destination picker uses. Falls back to the straight line when either end sits off the drivable
 *  network or no path exists (shouldn't happen on the real, fully-connected map). */
export function roadMetres(world: World, ax: number, ay: number, bx: number, by: number): number {
  const straight = dist(ax, ay, bx, by);
  const a = world.car.nearest(ax, ay, 400), b = world.car.nearest(bx, by, 400);
  if (a < 0 || b < 0) return straight;
  const path = world.car.path(a, b);
  if (!path) return straight;
  let m = 0;
  for (const link of path) m += link.edge.len;
  return m || straight;
}

/** A Slovak label for wherever `x, y` sits, for the HUD (a street name, or the nearest broader area
 *  when the spot isn't on a named street — a park path, a courtyard). */
function placeLabel(world: World, x: number, y: number): string {
  return world.streetName(x, y) ?? world.quarter(x, y) ?? world.district(x, y);
}

/** The Vlk-branded pickup label, e.g. "Vlk: bistro na Obchodnej". */
function pickupLabel(world: World, x: number, y: number): string {
  return `Vlk: bistro na ${placeLabel(world, x, y)}`;
}

/** A fresh courier offer from wherever the player currently is: a food place 200-900 m away, and a
 *  delivery address 600-1800 m beyond that — a ped-graph node preferably beside a building on a named
 *  street (a real doorway), rather than an anonymous point in a park. Null only if the map has no food
 *  places at all (never happens on the real city: ~418 of them). */
export function offerCourier(sim: Sim, fromX: number, fromY: number): CourierOffer | null {
  const world = sim.world;
  const place = pickInBand(sim, world.places('food'), fromX, fromY, PICKUP_RANGE);
  if (!place) return null;
  // a POI sits wherever OSM put it — often against, or inside, its building — so the actual pickup
  // point (what the handover checks distance against) is the nearest walkable spot to it, the same
  // way Missions.ts's nodeNear() makes a landmark reachable; the label still names the real place
  const at = world.walkableNear(place.x, place.y);
  const pickup: Pt = { x: at.x, y: at.y, label: pickupLabel(world, place.x, place.y) };
  const nodes = world.ped.nodesAround(pickup.x, pickup.y, DROP_RANGE[0], DROP_RANGE[1]).map((i) => ({ x: world.ped.nx(i), y: world.ped.ny(i) }));
  if (!nodes.length) return null;
  const named = nodes.filter((n) => world.streetName(n.x, n.y) !== null);
  const node = pickInBand(sim, named.length ? named : nodes, pickup.x, pickup.y, DROP_RANGE)!;
  const drop: Pt = { x: node.x, y: node.y, label: placeLabel(world, node.x, node.y) };
  return { pickup, drop, routeM: roadMetres(world, pickup.x, pickup.y, drop.x, drop.y) };
}
