// Scooters and bikes (docs/plans/gameplay.md, Phase 3): a Bolťák e-scooter waits at each bike-share
// dock near a player, and a bike at every other bicycle stand, free to take (nobody's, so no crime).
// Put down out of sight, the way the AI parks its cars, and gone again when nobody's near (AI's
// despawning), so there's one back the next time someone comes by. Both modes: online everyone sees
// the same ones.
import { SPECS, Vehicle, type VehicleKind } from '../../entities/Vehicle';
import { dist } from '../../util/math';
import type { Sim } from '../Sim';
import type { SimRule } from './SimRule';

/** street furniture kinds (FURNITURE in world/Street.ts): a bicycle stand, a bike-share dock */
const F_STAND = 7;
const F_DOCK = 13;
/** docks and stands this close to a player get a ride waiting at them (m) */
const NEAR = 150;
/** at most this many waiting round one player */
const MAX_NEAR = 8;
/** checked this often (s) */
const EVERY = 1.5;

/** 0..1, the same for the same piece of furniture every time */
const hash = (i: number) => (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;

export interface BikeSpot {
  x: number;
  y: number;
  a: number;
  kind: VehicleKind;
}

/** Where dock or stand `i` (an index into World.furniture) keeps its ride, lined up with it: a scooter
 *  in the dock's next slot, a bike in a stand's free rack (as StreetDetail draws them); null for any
 *  other furniture, and for the stands left empty. */
export function bikeSpot(f: ArrayLike<number>, i: number): BikeSpot | null {
  const k = f[i + 3];
  if (k !== F_DOCK && (k !== F_STAND || hash(i) < 0.5)) return null;
  const a = f[i + 2] + (hash(i + 1) < 0.5 ? Math.PI : 0), off = k === F_DOCK ? 1.6 : 0.3;
  return { x: f[i] - Math.sin(f[i + 2]) * off, y: f[i + 1] + Math.cos(f[i + 2]) * off, a, kind: k === F_DOCK ? 'scooter' : 'bike' };
}

export class Bikes implements SimRule {
  readonly id = 'bikes';
  private timer = 0;

  constructor(private sim: Sim) {}

  step(dt: number) {
    if ((this.timer -= dt) > 0) return;
    this.timer = EVERY;
    const sim = this.sim, f = sim.world.furniture;
    for (const p of sim.players.values()) {
      if (!p.observing) continue;
      const o = p.observer;
      let n = 0;
      for (const v of sim.vehiclesNear(o.fx, o.fy, NEAR)) if (v.spec.twoWheeler && !v.owner && !v.wrecked) n++;
      sim.world.forFurnitureNear(o.fx, o.fy, NEAR, (i) => {
        if (n >= MAX_NEAR) return;
        const s = bikeSpot(f, i);
        if (!s || dist(s.x, s.y, o.fx, o.fy) > NEAR || sim.visibleToAny(s.x, s.y, 3)) return;
        for (const v of sim.vehiclesNear(s.x, s.y, 3)) if (v.spec.twoWheeler && dist(v.x, v.y, s.x, s.y) < 3) return;
        const colors = SPECS[s.kind].colors;
        const v = new Vehicle(s.kind, s.x, s.y, s.a, colors[Math.floor(hash(i + 2) * colors.length)]);
        v.parked = true;
        v.setControls(0, 0, true);
        if (!sim.clearFor(v)) return;
        // (added to the neighbour hash at once: another player by the same dock sees it's taken)
        sim.addVehicle(v);
        n++;
      });
    }
  }
}
