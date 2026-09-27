// Boats on the Danube (docs/plans/gameplay.md, Phase 3): moored along the piers near players, free to
// take (nobody's), and the police boat that comes after a player on the water at 4★. Moored boats are
// put down out of sight and go again when nobody's near (AI's despawning), as the parked cars do. The
// police boat is driven here: straight for the player, backing off the bank when it runs aground, and
// its cop shoots from it. Both modes: online everyone sees the same ones.
import { Ped } from '../../entities/Ped';
import { SPECS, Vehicle } from '../../entities/Vehicle';
import { clamp, dist } from '../../util/math';
import type { Sim } from '../Sim';
import type { SimPlayer } from '../SimPlayer';
import type { SimRule } from './SimRule';

/** piers this close to a player get a boat moored along them (m) */
const NEAR = 220;
/** at most this many moored round one player */
const MAX_NEAR = 4;
/** checked this often (s) */
const EVERY = 2;
/** the police boat comes for a player on the water from this many stars */
export const POLICE_BOAT_STARS = 4;
/** ...from about this far off, out of sight (m) */
const POLICE_FROM = [110, 220];
/** its cop shoots at the player within this range (m), this often (s) */
const SHOOT_R = 28;
const SHOOT_CD = [0.8, 1.4];

/** Is `p` on the water: in a boat, or swimming? */
export function onWater(sim: Sim, p: SimPlayer): boolean {
  const ped = p.ped, v = ped.vehicle;
  return v ? !!v.spec.boat : !ped.aboard && sim.world.inWater(ped.x, ped.y, ped.level);
}

interface Chase {
  boat: Vehicle;
  /** stuck against the bank for this long (s), backing off for this long (s) */
  stuck: number;
  back: number;
  cd: number;
}

export class Boats implements SimRule {
  readonly id = 'boats';
  private timer = 0;
  private spots: number[] | null = null;
  private police = new Map<SimPlayer, Chase>();

  constructor(private sim: Sim) {}

  /** where boats lie along the piers (flat x, y, angle; tests) */
  get moorings(): readonly number[] {
    return (this.spots ??= this.sim.world.moorings(SPECS.boat.length, SPECS.boat.width));
  }

  /** the police boat after `p`, if there is one (tests) */
  policeBoat(p: SimPlayer): Vehicle | null {
    return this.police.get(p)?.boat ?? null;
  }

  step(dt: number) {
    for (const [p, c] of this.police) this.chase(p, c, dt);
    if ((this.timer -= dt) > 0) return;
    this.timer = EVERY;
    const sim = this.sim;
    for (const p of sim.players.values()) {
      if (!p.observing) continue;
      this.moor(p);
      // the police boat: gone (out of the city, sunk, taken), or wanted for the first time
      const c = this.police.get(p);
      if (c && (!sim.vehicles.includes(c.boat) || c.boat.wrecked || c.boat.owner || !c.boat.driver || c.boat.driver.dead)) this.police.delete(p);
      if (!this.police.has(p) && p.state === 'play' && p.stars >= POLICE_BOAT_STARS && onWater(sim, p)) this.launch(p);
    }
  }

  onRemove(p: SimPlayer) {
    this.police.delete(p);
  }

  /** a boat along each pier near `p` that has none, out of sight, up to MAX_NEAR round them */
  private moor(p: SimPlayer) {
    const sim = this.sim, S = this.moorings, o = p.observer;
    let n = 0;
    for (const v of sim.vehiclesNear(o.fx, o.fy, NEAR)) if (v.kind === 'boat' && !v.owner && !v.wrecked) n++;
    for (let i = 0; i < S.length && n < MAX_NEAR; i += 3) {
      const x = S[i], y = S[i + 1];
      if (dist(x, y, o.fx, o.fy) > NEAR || sim.visibleToAny(x, y, 6)) continue;
      if (sim.vehiclesNear(x, y, 8).some((v) => v.spec.boat && dist(v.x, v.y, x, y) < 8)) continue;
      const colors = SPECS.boat.colors;
      const v = new Vehicle('boat', x, y, S[i + 2], colors[(i / 3) % colors.length]);
      v.parked = true;
      v.setControls(0, 0, true);
      sim.addVehicle(v);
      n++;
    }
  }

  /** a police boat on the water some way off `p`, out of sight, facing them */
  private launch(p: SimPlayer) {
    const sim = this.sim, w = sim.world, f = p.focus(), spec = SPECS.policeboat;
    for (let k = 0; k < 24; k++) {
      const a = sim.rng.next() * Math.PI * 2, r = POLICE_FROM[0] + sim.rng.next() * (POLICE_FROM[1] - POLICE_FROM[0]);
      const x = f.x + Math.cos(a) * r, y = f.y + Math.sin(a) * r, facing = a + Math.PI;
      if (!w.afloat(x, y, facing, spec.length, spec.width) || sim.visibleToAny(x, y, 10)) continue;
      const boat = sim.addVehicle(new Vehicle('policeboat', x, y, facing, spec.colors[0]));
      boat.siren = true;
      const cop = new Ped('cop', x, y, sim.rng.seed());
      cop.vehicle = boat;
      cop.targetPid = p.id;
      boat.driver = cop;
      sim.addPed(cop);
      this.police.set(p, { boat, stuck: 0, back: 0, cd: SHOOT_CD[1] });
      return;
    }
  }

  /** Straight for the player while they're wanted and on the water (idling once they're off it),
   *  backing off the bank when it runs aground, the cop on board firing when they're in range. */
  private chase(p: SimPlayer, c: Chase, dt: number) {
    const sim = this.sim, b = c.boat, cop = b.driver;
    if (!cop || cop.dead || b.wrecked || b.owner) return;
    const f = p.focus();
    if (p.state !== 'play' || p.wanted <= 0 || !onWater(sim, p)) {
      b.setControls(0, 0, true);
      return;
    }
    const d = dist(b.x, b.y, f.x, f.y);
    let turn = Math.atan2(f.y - b.y, f.x - b.x) - b.angle;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    let steer = clamp(turn * 2, -1, 1);
    let throttle = d > 30 ? 1 : d > 12 ? 0.55 : 0.3;
    if (c.back > 0) {
      c.back -= dt;
      throttle = -0.8;
      steer = -steer;
    } else if (b.speed < 1 && Math.abs(turn) < 1.2) {
      if ((c.stuck += dt) > 1.5) (c.back = 1.2), (c.stuck = 0);
    } else c.stuck = 0;
    b.setControls(throttle, steer, false, d > 60);
    b.siren = true;
    // the cop on board: in range, with a clear line
    if ((c.cd -= dt) > 0 || d > SHOOT_R) return;
    c.cd = SHOOT_CD[0] + sim.rng.next() * (SHOOT_CD[1] - SHOOT_CD[0]);
    if (sim.world.raycast(b.x, b.y, f.x, f.y, 0) < 1) return;
    sim.combat.fireNpc({ id: cop.id, x: b.x, y: b.y, level: 0, vehicle: b }, Math.atan2(f.y - b.y, f.x - b.x), 'pistol');
  }
}
