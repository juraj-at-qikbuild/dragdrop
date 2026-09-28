// The Hračkárstvo's thrown toys (docs/plans/gameplay.md, Phase 4; docs/plans/non-violent.md): a toy
// flies from the thrower to a spot and does its thing where it comes down. The soap bomb leaves a
// slippery patch (cars slide, people slip), the egg covers a windscreen (traffic stops to wipe it) or
// sits someone down, the wheel clamp (a PAAS joke) holds a car where it stands, the Easter bucket
// soaks everyone round the spot, and the pigeon from Hlavné námestie flies at whoever was nearest the
// spot and leaves them a gift. The flight is simulated here (the server's say), and shown by clients
// from the `toy` events.
import type { Ped, WeaponId } from '../entities/Ped';
import type { Vehicle } from '../entities/Vehicle';
import type { Level } from '../world/World';
import { dist } from '../util/math';
import { WEAPONS } from './Combat';
import type { Slick } from './Physics';
import type { Sim } from './Sim';
import type { SimPlayer } from './SimPlayer';

/** a soap bomb's patch: how big (m) and how long it stays slippery (s) */
export const SLICK_R = 5;
export const SLICK_S = 14;
/** how long an egg covers a windscreen, a pigeon's gift, a clamp holds a car (s) */
export const EGG_S = 3.5;
export const GIFT_S = 2.5;
export const CLAMP_S = 10;
/** how near the spot a car has to be for an egg or a clamp to land on it, a person for an egg (m) */
const CAR_R = 3;
const PED_R = 1.4;
/** the bucket's splash (m) */
const BUCKET_R = 3.2;
/** the pigeon looks for someone (or a car) this near the spot (m) */
const PIGEON_SEEK = 9;
/** someone walking on a soap patch slips over, at about this rate (1/s) */
const SLIP_RATE = 1.6;

interface Flight {
  w: WeaponId;
  pid: number;
  tx: number;
  ty: number;
  lvl: Level;
  /** seconds left in the air */
  t: number;
  /** the pigeon's target (a ped or a vehicle id; 0 none) */
  target: number;
}

export class Toys {
  private flights: Flight[] = [];
  /** the soap bombs' slippery patches (VehiclePhysics reads them too) */
  readonly slicks: Slick[] = [];

  constructor(private sim: Sim) {}

  /** `p` throws toy `w` at (tx, ty) (thrown no further than it goes); false when it can't be */
  throw(p: SimPlayer, w: WeaponId, tx: number, ty: number): boolean {
    const spec = WEAPONS[w];
    if (!spec.thrown || p.state !== 'play' || p.ped.aboard || !Number.isFinite(tx) || !Number.isFinite(ty)) return false;
    const f = p.focus(), lvl = p.ped.level;
    const d = dist(f.x, f.y, tx, ty);
    if (d > spec.range) {
      tx = f.x + ((tx - f.x) / d) * spec.range;
      ty = f.y + ((ty - f.y) / d) * spec.range;
    }
    // the pigeon picks whoever (or whatever car) is nearest the spot, and flies at them
    let target = 0;
    if (w === 'pigeon') {
      const t = this.nearest(tx, ty, PIGEON_SEEK, lvl, p);
      if (t) (target = t.id), (tx = t.x), (ty = t.y);
    }
    const fly = Math.max(0.25, dist(f.x, f.y, tx, ty) / spec.thrown);
    this.flights.push({ w, pid: p.id, tx, ty, lvl, t: fly, target });
    this.sim.events.toy({ op: 'throw', w, pid: p.id, x: f.x, y: f.y, tx, ty, d: fly, lvl });
    return true;
  }

  step(dt: number) {
    if (this.flights.length) {
      const landed = this.flights.filter((f) => (f.t -= dt) <= 0);
      if (landed.length) {
        this.flights = this.flights.filter((f) => f.t > 0);
        for (const f of landed) this.land(f);
      }
    }
    for (let i = this.slicks.length - 1; i >= 0; i--) {
      const s = this.slicks[i];
      if ((s.t -= dt) <= 0) this.slicks.splice(i, 1);
      else this.slip(s, dt);
    }
  }

  /** anyone walking on a soap patch may slip over (the local player's own client slides them) */
  private slip(s: Slick, dt: number) {
    const sim = this.sim;
    for (const p of sim.pedsNear(s.x, s.y, s.r)) {
      if (p.dazed || p.vehicle || p.aboard || p.playerId || p.kinematic || Math.hypot(p.vx, p.vy) < 0.6) continue;
      if (dist(p.x, p.y, s.x, s.y) > s.r || !sim.rng.chance(dt * SLIP_RATE)) continue;
      sim.knockDown(p, p.x - p.vx, p.y - p.vy, 2, 'shot', 0, 'bubbles');
    }
  }

  private land(f: Flight) {
    const sim = this.sim;
    const player = sim.players.get(f.pid) ?? null;
    let x = f.tx, y = f.ty, hit: 0 | 1 = 0;
    switch (f.w) {
      case 'soap': {
        const s: Slick = { x, y, r: SLICK_R, t: SLICK_S };
        this.slicks.push(s);
        sim.events.toy({ op: 'slick', x, y, r: s.r, t: s.t });
        break;
      }
      case 'egg': {
        const car = this.carAt(x, y, f.lvl);
        if (car) {
          this.stick(car, 'egg', EGG_S, player);
          (x = car.x), (y = car.y), (hit = 1);
          break;
        }
        const p = this.pedAt(x, y, PED_R, f.lvl, player);
        if (p) {
          this.soak(p, WEAPONS.egg.dmg, x, y, f.pid, 'egg');
          (x = p.x), (y = p.y), (hit = 1);
        }
        break;
      }
      case 'clamp': {
        const car = this.carAt(x, y, f.lvl);
        // (nothing to clamp on a scooter, a bike, a boat or the football)
        if (car && !car.spec.twoWheeler && !car.spec.boat && !car.spec.ball) {
          this.stick(car, 'clamp', CLAMP_S, player);
          (x = car.x), (y = car.y), (hit = 1);
        }
        break;
      }
      case 'bucket':
        for (const p of sim.pedsNear(x, y, BUCKET_R + 1)) {
          if (p.dazed || p.vehicle || p.aboard || p.level !== f.lvl || dist(p.x, p.y, x, y) > BUCKET_R || p.playerId === f.pid) continue;
          this.soak(p, WEAPONS.bucket.dmg, x, y, f.pid, 'water');
          hit = 1;
        }
        break;
      case 'pigeon': {
        const t = f.target ? sim.pedById(f.target) ?? sim.vehicleById(f.target) : null;
        // (they get away if they went far enough while it flew)
        if (!t || dist(t.x, t.y, f.tx, f.ty) > PIGEON_SEEK) break;
        (x = t.x), (y = t.y), (hit = 1);
        if ('spec' in t) this.stick(t, 'egg', GIFT_S, player);
        else if (!t.dazed && !t.vehicle && !t.aboard) {
          this.soak(t, WEAPONS.pigeon.dmg, x, y, f.pid, 'pigeon');
          if (!t.playerId && !t.dazed && t.kind === 'civ') sim.combat.scare(t, x, y);
        }
        break;
      }
    }
    sim.events.toy({ op: 'land', w: f.w, x, y, hit });
  }

  /** an egg or a clamp on a car; egging or clamping a police car is going for the police */
  private stick(v: Vehicle, what: 'egg' | 'clamp', t: number, by: SimPlayer | null) {
    const sim = this.sim;
    const owner = v.owner ? sim.players.get(v.owner) : undefined;
    if (owner && (owner === by || !sim.touchable(owner, by?.id ?? 0))) return;
    v[what] = t;
    sim.events.toy({ op: 'stick', what, vid: v.id, x: v.x, y: v.y, t });
    if (by && v.kind === 'police' && !v.isPlayer) {
      sim.crime(by, 'shootCop');
      if (what === 'clamp') sim.style(by, 'takedown', v.x, v.y, { label: 'PAPUČA!' });
    }
  }

  /** a person soaked by a toy that came down on them: as a toy's hit (CombatRules.hurtPed) */
  private soak(p: Ped, dmg: number, x: number, y: number, pid: number, mess: 'egg' | 'water' | 'pigeon') {
    this.sim.combat.hurtPed(p, dmg, { x, y }, pid, false, mess);
  }

  /** the car nearest (x, y) on level `lvl` (within CAR_R of its outline) */
  private carAt(x: number, y: number, lvl: Level): Vehicle | null {
    let best: Vehicle | null = null, bd = Infinity;
    for (const v of this.sim.vehiclesNear(x, y, CAR_R + 8)) {
      if (v.wrecked || v.level !== lvl) continue;
      const d = dist(v.x, v.y, x, y) - v.spec.width / 2;
      if (d < CAR_R && d < bd) (bd = d), (best = v);
    }
    return best;
  }

  /** the person on foot nearest (x, y), not the thrower */
  private pedAt(x: number, y: number, r: number, lvl: Level, by: SimPlayer | null): Ped | null {
    let best: Ped | null = null, bd = r;
    for (const p of this.sim.pedsNear(x, y, r + 1)) {
      if (p.dazed || p.vehicle || p.aboard || p.level !== lvl || (by && p === by.ped)) continue;
      const d = dist(p.x, p.y, x, y);
      if (d < bd) (bd = d), (best = p);
    }
    return best;
  }

  /** the pigeon's pick: the person on foot or the car nearest (x, y), not the thrower's */
  private nearest(x: number, y: number, r: number, lvl: Level, by: SimPlayer): { id: number; x: number; y: number } | null {
    const p = this.pedAt(x, y, r, lvl, by);
    let best: { id: number; x: number; y: number } | null = p, bd = p ? dist(p.x, p.y, x, y) : r;
    for (const v of this.sim.vehiclesNear(x, y, r + 6)) {
      if (v.wrecked || v.level !== lvl || v === by.ped.vehicle) continue;
      const d = dist(v.x, v.y, x, y);
      if (d < bd) (bd = d), (best = v);
    }
    return best;
  }
}
