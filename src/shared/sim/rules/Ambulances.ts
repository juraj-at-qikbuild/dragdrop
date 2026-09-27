// The ambulances (docs/plans/gameplay.md, Phase 3): one parked outside each hospital, for a player to
// take (its siren works, and it patches its driver up: Sim.step). Kept there near players the way the
// AI keeps parked cars: put down out of sight when there isn't one, and gone again when nobody's near
// (AI's despawning), so it's back the next time someone comes by. Both modes: online everyone sees
// the same one.
import { Vehicle } from '../../entities/Vehicle';
import { dist } from '../../util/math';
import type { Sim } from '../Sim';
import type { SimRule } from './SimRule';

/** a player within this of a hospital gets its ambulance (m) */
const NEAR = 240;
/** an ambulance still this close to its spot is the one parked there */
const HELD = 60;
/** checked this often (s) */
const EVERY = 2;

interface Spot {
  x: number;
  y: number;
  a: number;
}

export class Ambulances implements SimRule {
  readonly id = 'ambulances';
  private spots: Spot[] | null = null;
  private parked = new Map<number, Vehicle>();
  private timer = 0;

  constructor(private sim: Sim) {}

  /** by each hospital, where its ambulance waits: the kerb of the nearest street, facing along it */
  private findSpots(): Spot[] {
    const w = this.sim.world;
    const out: Spot[] = [];
    for (const h of w.pois('hospital')) {
      const n = w.car.nearest(h.x, h.y, 160);
      const link = n >= 0 ? w.car.out[n][0] : undefined;
      if (!link) continue;
      const p = link.edge.p, fwd = link.fwd, k = fwd ? 0 : p.length - 2;
      const bx = p[fwd ? 2 : p.length - 4], by = p[fwd ? 3 : p.length - 3];
      const ax = p[k], ay = p[k + 1];
      const a = Math.atan2(by - ay, bx - ax);
      // a car's length along the street from the node, and over to its right-hand kerb
      const along = Math.min(8, Math.hypot(bx - ax, by - ay) / 2), right = Math.max(0, link.edge.width / 2 - 1.3);
      out.push({ x: ax + Math.cos(a) * along - Math.sin(a) * right, y: ay + Math.sin(a) * along + Math.cos(a) * right, a });
    }
    return out;
  }

  step(dt: number) {
    if ((this.timer -= dt) > 0) return;
    this.timer = EVERY;
    const sim = this.sim;
    const spots = (this.spots ??= this.findSpots());
    spots.forEach((s, i) => {
      const had = this.parked.get(i);
      if (had && !had.wrecked && sim.vehicles.includes(had) && dist(had.x, had.y, s.x, s.y) < HELD) return;
      this.parked.delete(i);
      let near = false;
      for (const p of sim.players.values()) if (p.observing && dist(p.observer.fx, p.observer.fy, s.x, s.y) < NEAR) near = true;
      if (!near || sim.visibleToAny(s.x, s.y, 6)) return;
      const v = new Vehicle('ambulance', s.x, s.y, s.a, '#fafafa');
      v.parked = true;
      if (!sim.clearFor(v)) return;
      sim.addVehicle(v);
      this.parked.set(i, v);
    });
  }

  /** where the ambulances wait (tests, the map) */
  get places(): readonly Spot[] {
    return (this.spots ??= this.findSpots());
  }
}
