// Hopík taxi offers: a hailing fare ahead of the car, and a landmark-ish destination for them. Shared
// by both hosts — sim.rng only, never Math.random. Plan: docs/plans/social-events.md.
import type { Sim } from '../../Sim';
import type { Vehicle } from '../../../entities/Vehicle';
import { Ped } from '../../../entities/Ped';
import { pickInBand, type Pt } from './courier';
import { placeName } from '../placeName';

const FARE_RANGE: [number, number] = [150, 500];
const DEST_RANGE: [number, number] = [800, 2500];
/** how far off dead-ahead a sidewalk node may be and still count as "ahead of the car's heading"
 *  (cos of a ~72° half-cone) */
const AHEAD_COS = 0.3;

/** Destination kinds with the flavour the plan asks for ("museum, theatre, hotel, …"). A landmark is
 *  tried first (see offerDestination) since it always carries a proper name; these fill out the rest
 *  of the city for places that aren't landmarks. Only museum/theatre/church/library carry a name in
 *  the map data (World.places' `n`); the others fall back to a generic "<kind> <placeName phrase>" label ("Hotel na ulici Obchodná"). */
const DEST_KINDS: { k: string; label: string }[] = [
  { k: 'museum', label: 'Múzeum' },
  { k: 'theatre', label: 'Divadlo' },
  { k: 'hotel', label: 'Hotel' },
  { k: 'church', label: 'Kostol' },
  { k: 'library', label: 'Knižnica' },
  { k: 'bank', label: 'Banka' },
  { k: 'view', label: 'Vyhliadka' },
];

/** A sidewalk spot 150-500 m ahead of the car's heading, for a hailing fare to stand at. Falls back to
 *  any walkable node in range (behind, or to the side) rather than finding nobody at all. */
export function offerFare(sim: Sim, car: Vehicle): { x: number; y: number } | null {
  const world = sim.world;
  const nodes = world.ped.nodesAround(car.x, car.y, FARE_RANGE[0], FARE_RANGE[1]);
  if (!nodes.length) return null;
  const hx = Math.cos(car.angle), hy = Math.sin(car.angle);
  const ahead = nodes.filter((i) => {
    const nx = world.ped.nx(i) - car.x, ny = world.ped.ny(i) - car.y;
    const d = Math.hypot(nx, ny) || 1;
    return (nx * hx + ny * hy) / d > AHEAD_COS;
  });
  const pts = (ahead.length ? ahead : nodes).map((i) => ({ x: world.ped.nx(i), y: world.ped.ny(i) }));
  return pickInBand(sim, pts, car.x, car.y, FARE_RANGE);
}

/** Spawn the hailing civilian: hands up, and `kinematic` so it waits right there instead of wandering
 *  off (AI.ts skips kinematic peds outright) — which also, and just as importantly, exempts it from
 *  the "despawn what no player is near" cull (AI.ts ~245): a fare 500 m out, near the far edge of its
 *  own spawn range, is well past that cull's 200 m radius, and would otherwise vanish before the
 *  player ever got there. The trade-off: a kinematic ped can't be run over (Physics.ts skips it too),
 *  so "the fare dies" (see the re-offer check in Jobs.ts) never fires in practice — only "despawns". */
export function spawnFare(sim: Sim, x: number, y: number): Ped {
  const ped = new Ped('civ', x, y, sim.rng.seed());
  ped.state = 'idle';
  ped.handsUp = true;
  ped.kinematic = true;
  sim.addPed(ped);
  return ped;
}

/** A landmark or notable place 800-2500 m from the fare, for the ride's destination. */
export function offerDestination(sim: Sim, fromX: number, fromY: number): Pt | null {
  const world = sim.world;
  const pool: Pt[] = [];
  for (const l of world.landmarks.values()) pool.push({ x: l.x, y: l.y, label: l.name });
  for (const dk of DEST_KINDS)
    for (const place of world.places(dk.k)) {
      const label =
        place.n !== undefined
          ? world.names[place.n]
          : `${dk.label} ${placeName(world, place.x, place.y)}`;
      pool.push({ x: place.x, y: place.y, label });
    }
  const dest = pickInBand(sim, pool, fromX, fromY, DEST_RANGE);
  if (!dest) return null;
  // as with the courier's pickup: land on the nearest walkable point to the POI, not its raw (maybe
  // inside-a-building) coordinate, so the drop-off is always actually reachable
  const at = world.walkableNear(dest.x, dest.y);
  return { x: at.x, y: at.y, label: dest.label };
}

/** The passenger bails (Mood hit 0): a civilian storms off beside the car. */
export function spawnBailingPed(sim: Sim, car: Vehicle): Ped {
  const side = sim.rng.chance(0.5) ? 1 : -1;
  const a = car.angle + (Math.PI / 2) * side;
  const ped = new Ped('civ', car.x + Math.cos(a) * 2, car.y + Math.sin(a) * 2, sim.rng.seed());
  ped.state = 'flee';
  ped.fleeFrom = { x: car.x, y: car.y };
  sim.addPed(ped);
  return ped;
}
