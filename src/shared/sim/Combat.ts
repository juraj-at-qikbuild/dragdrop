// Toys and soaking rules: shot tracing, hits, knock-downs and explosions (docs/plans/non-violent.md:
// nobody gets hurt, everybody gets annoyed). The ids stay the wire's (`fist | pistol | uzi | shotgun`),
// the toys are what they are now: tickling, a water pistol, a bubble gun and a confetti shotgun. Visual
// effects are events (see events.ts); the browser draws them with Fx. A player's shot is traced by their
// own client against what it sees (`traceShot`) and applied here (`applyShot`), the server first
// validating the claim.
import type { Level } from '../world/World';
import { WEAPON_IDS, type Mess, type Ped, type WeaponId } from '../entities/Ped';
export type { Mess } from '../entities/Ped';
import type { Vehicle } from '../entities/Vehicle';
import type { World } from '../world/World';
import { dist } from '../util/math';
import { SOAK_LABEL } from './rules/Style';
import type { Sim } from './Sim';

export interface WeaponSpec {
  name: string;
  /** what the HUD calls it */
  short: string;
  /** how much it soaks */
  dmg: number;
  cd: number;
  spread: number;
  /** how far it reaches (a thrown toy: how far it's thrown at most) */
  range: number;
  pellets: number;
  /** a thrown toy (Toys.ts): how fast it flies (m/s); a player's client sends a `throw`, not a `fire` */
  thrown?: number;
  /** what a hit does to a car, of what it does to a person (default 1) */
  car?: number;
  /** a pellet by a wheel bursts the tyre (the first three toys) */
  tyres?: boolean;
  /** makes no noise: no crime for firing it, nobody around runs (the peashooter) */
  quiet?: boolean;
}

/** each toy: its name, how much it soaks (dmg), cooldown, spread, range and pellets. The second
 *  shelf's gags (Kofola's stickiness, the blower's push, the foam putting out a fire...) are in
 *  CombatRules.toyHit and toyCar; the thrown ones land in Toys.ts. */
export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  fist: { name: 'Šteklenie', short: 'Šteklenie', dmg: 34, cd: 0.45, spread: 0, range: 1.4, pellets: 1 },
  pistol: { name: 'Vodná pištoľ', short: 'Striekačka', dmg: 55, cd: 0.3, spread: 0.035, range: 45, pellets: 1, tyres: true },
  uzi: { name: 'Bublinkový samopal', short: 'Bublifuk', dmg: 28, cd: 0.085, spread: 0.08, range: 38, pellets: 1, tyres: true },
  shotgun: { name: 'Konfetová brokovnica', short: 'Konfeťák', dmg: 34, cd: 0.9, spread: 0.22, range: 22, pellets: 6, tyres: true },
  // a bonk that sits anyone down with a squeak (the reach of a swing)
  hammer: { name: 'Pískacie kladivko', short: 'Kladivko', dmg: 100, cd: 0.55, spread: 0.3, range: 1.9, pellets: 1, car: 0.1 },
  // a shaken bottle of Kofola: short and fizzy, and whoever it hits is sticky and slow for a while
  kofola: { name: 'Kofolový sifón', short: 'Kofola', dmg: 12, cd: 0.1, spread: 0.16, range: 11, pellets: 3, car: 0.2 },
  // grandma's perfume: barely wet, but everyone near coughs and runs
  perfume: { name: 'Babkin parfém', short: 'Parfém', dmg: 6, cd: 0.3, spread: 0.4, range: 7, pellets: 4, car: 0 },
  // a peashooter: a sniper, as a joke (weak, quiet, very far)
  pea: { name: 'Hrach cez slamku', short: 'Hrach', dmg: 10, cd: 0.2, spread: 0.004, range: 90, pellets: 1, car: 0.05, quiet: true },
  // the leaf blower: pushes people over, and scooters and bikes aside
  blower: { name: 'Fúkač na lístie', short: 'Fúkač', dmg: 22, cd: 0.08, spread: 0.18, range: 8, pellets: 1, car: 0 },
  // the foam extinguisher: puts out a burning car (your own too)
  foam: { name: 'Hasiaci prístroj', short: 'Hasiák', dmg: 10, cd: 0.1, spread: 0.1, range: 12, pellets: 2, car: 0 },
  // thrown: a slippery patch, an egg on a windscreen, a clamp on a wheel, a bucket of water, a pigeon
  soap: { name: 'Mydlová bomba', short: 'Mydlo', dmg: 0, cd: 1, spread: 0, range: 20, pellets: 1, thrown: 14 },
  egg: { name: 'Vajíčko', short: 'Vajce', dmg: 100, cd: 0.5, spread: 0, range: 24, pellets: 1, thrown: 18 },
  clamp: { name: 'Parkovacia papuča', short: 'Papuča', dmg: 0, cd: 1.2, spread: 0, range: 12, pellets: 1, thrown: 11 },
  bucket: { name: 'Veľkonočná oblievačka', short: 'Oblievačka', dmg: 100, cd: 1.2, spread: 0, range: 10, pellets: 1, thrown: 10 },
  pigeon: { name: 'Holub z Hlavného', short: 'Holub', dmg: 60, cd: 1.5, spread: 0, range: 45, pellets: 1, thrown: 13 },
};

/** what each toy leaves on a person it hits (the look ClientEvents gives them) */
export const WEAPON_MESS: Record<WeaponId, Mess> = {
  fist: 'tickle', pistol: 'water', uzi: 'bubbles', shotgun: 'confetti',
  hammer: 'bonk', kofola: 'kofola', perfume: 'perfume', pea: 'pea', blower: 'leaves', foam: 'foam',
  soap: 'bubbles', egg: 'egg', clamp: 'bonk', bucket: 'water', pigeon: 'pigeon',
};
export { WEAPON_IDS };
/** every toy but tickling: what a player has refills of (SimPlayer.ammo), in WEAPON_IDS' order */
export const TOY_IDS = WEAPON_IDS.filter((w): w is Exclude<WeaponId, 'fist'> => w !== 'fist');
/** a thrown toy (Toys.ts) */
export const isThrown = (w: WeaponId) => !!WEAPONS[w].thrown;

/** how long a Kofola hit keeps someone sticky (s) */
export const STICKY_S = 5;

/** what a pellet ended on */
export const enum HitKind {
  None = 0,
  Wall = 1,
  Ped = 2,
  Car = 3,
}

export interface PelletReport {
  /** direction after spread */
  a: number;
  kind: HitKind;
  /** entity id for Ped/Car hits */
  hit: number;
  /** end point */
  hx: number;
  hy: number;
}

/** A traced shot, as the shooter saw it. */
export interface ShotReport {
  w: WeaponId;
  /** muzzle */
  ox: number;
  oy: number;
  a: number;
  lvl: Level;
  pellets: PelletReport[];
}

/** anything that can shoot: a ped, or the helicopter */
export interface Shooter {
  id: number;
  x: number;
  y: number;
  level: Level;
  vehicle: Vehicle | null;
}

/** ray AB vs circle, returns t in [0,1] of first hit or -1 */
export function rayCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, r: number) {
  const dx = bx - ax, dy = by - ay;
  const fx = ax - cx, fy = ay - cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : c < 0 ? 0 : -1;
}

/** Trace a gun shot from `s` through the given peds and vehicles (walls from the world). */
export function traceShot(
  world: World, peds: Iterable<Ped>, vehicles: Iterable<Vehicle>, s: Shooter, angle: number, weapon: WeaponId, rand: () => number,
): ShotReport {
  const w = WEAPONS[weapon];
  const sx = s.x + Math.cos(angle) * 0.5, sy = s.y + Math.sin(angle) * 0.5;
  const out: ShotReport = { w: weapon, ox: sx, oy: sy, a: angle, lvl: s.level, pellets: [] };
  for (let i = 0; i < w.pellets; i++) {
    const a = angle + (rand() * 2 - 1) * w.spread;
    const ex = sx + Math.cos(a) * w.range, ey = sy + Math.sin(a) * w.range;
    let t = world.raycast(sx, sy, ex, ey, s.level);
    let kind = t < 1 ? HitKind.Wall : HitKind.None;
    let hit = 0;
    for (const p of peds) {
      if (p.id === s.id || p.dazed || p.vehicle || p.aboard || p.level !== s.level) continue;
      if (Math.abs(p.x - sx) > w.range + 1 || Math.abs(p.y - sy) > w.range + 1) continue;
      const pt = rayCircle(sx, sy, ex, ey, p.x, p.y, p.r + 0.15);
      if (pt >= 0 && pt < t) (t = pt), (kind = HitKind.Ped), (hit = p.id);
    }
    for (const v of vehicles) {
      if (v === s.vehicle || v.wrecked || v.level !== s.level) continue;
      if (dist(v.x, v.y, sx, sy) > w.range + v.radius) continue;
      for (let c = 0; c < v.circles.length; c++) {
        const [cx, cy] = v.circleAt(c);
        const vt = rayCircle(sx, sy, ex, ey, cx, cy, v.spec.width / 2);
        if (vt >= 0 && vt < t) (t = vt), (kind = HitKind.Car), (hit = v.id);
      }
    }
    out.pellets.push({ a, kind, hit, hx: sx + (ex - sx) * t, hy: sy + (ey - sy) * t });
  }
  return out;
}

/** The ped a punch from `s` at `angle` lands on, if any. */
export function traceMelee(peds: Iterable<Ped>, s: Shooter, angle: number): Ped | null {
  const w = WEAPONS.fist;
  for (const p of peds) {
    if (p.id === s.id || p.dazed || p.vehicle || p.aboard || p.level !== s.level) continue;
    const d = dist(p.x, p.y, s.x, s.y);
    if (d > w.range + p.r) continue;
    const a = Math.atan2(p.y - s.y, p.x - s.x);
    if (Math.abs(Math.atan2(Math.sin(a - angle), Math.cos(a - angle))) > 0.9) continue;
    return p;
  }
  return null;
}

/** true if (hx, hy) landed within 0.6 m of one of the car's four wheels: local (±(length/2 − 0.7),
 *  ±width/2), the wheel positions `Vehicle`'s own axle model assumes (see CarSpec). */
function hitsWheel(v: Vehicle, hx: number, hy: number): boolean {
  const s = v.spec, fx = Math.cos(v.angle), fy = Math.sin(v.angle);
  const lx = s.length / 2 - 0.7, ly = s.width / 2;
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const wx = v.x + sx * lx * fx - sy * ly * fy, wy = v.y + sx * lx * fy + sy * ly * fx;
      if (dist(hx, hy, wx, wy) <= 0.6) return true;
    }
  return false;
}

export class CombatRules {
  constructor(private sim: Sim) {}

  /** An NPC (cop, helicopter) fires: trace against the full simulation and apply. */
  fireNpc(shooter: Shooter, angle: number, weapon: WeaponId) {
    const sim = this.sim;
    if (weapon === 'fist') {
      const target = traceMelee(sim.pedsNear(shooter.x, shooter.y, 3), shooter, angle);
      this.applyMelee(shooter, 0, target);
      return;
    }
    const range = WEAPONS[weapon].range + 6;
    const shot = traceShot(sim.world, sim.pedsNear(shooter.x, shooter.y, range), sim.vehiclesNear(shooter.x, shooter.y, range), shooter, angle, weapon, () => sim.rng.next());
    this.applyShot(shooter, 0, shot);
  }

  /** Apply a traced shot. `pid` is the shooting player (0 for NPCs). Hit ids that no longer exist are ignored. */
  applyShot(shooter: Shooter, pid: number, shot: ShotReport) {
    const sim = this.sim;
    const w = WEAPONS[shot.w];
    // (the helicopter, the one shooter with no ped, tips its water bucket: water, whatever it fires)
    const mess = shooter.id === 0 ? 'water' : WEAPON_MESS[shot.w];
    const ends: number[] = [];
    let sparks = 0;
    const player = pid ? sim.players.get(pid) ?? null : null;
    shot.pellets.forEach((pl, i) => {
      ends.push(pl.hx, pl.hy);
      if (pl.kind === HitKind.Ped) {
        const p = sim.pedById(pl.hit);
        if (p && !p.dazed) {
          this.hurtPed(p, w.dmg, shooter, pid, false, mess);
          if (shooter.id !== 0) this.toyHit(shot.w, p, shooter, pid, pl.a, pl.hx, pl.hy);
        }
      } else if (pl.kind === HitKind.Car) {
        sparks |= 1 << i;
        const car = sim.vehicleById(pl.hit);
        if (!car || car.wrecked) return;
        if (shooter.id !== 0) this.toyCar(shot.w, car, pid, pl.a);
        const carDmg = w.dmg * 0.35 * car.armor * (w.car ?? 1);
        if (carDmg > 0) sim.damageVehicle(car, carDmg, pid);
        for (const r of sim.rules) r.onVehicleHit?.(car, carDmg, pid, pl.hx, pl.hy);
        // a pellet near a wheel bursts the tyres, for any car (Horúca Kofolka's box-in-and-ram dynamic),
        // but for run-flats (the Dielňa's tuning)
        if (w.tyres && hitsWheel(car, pl.hx, pl.hy) && car.burstTyres() && car.owner) sim.events.toPlayer(car.owner, { k: 'tyres', vehicle: car.id });
        if (player && car.kind === 'police' && !car.isPlayer) sim.crime(player, 'shootCop');
        if (car.driver && !car.driver.playerId && !car.isPlayer && sim.rng.chance(0.15)) this.hurtPed(car.driver, w.dmg, shooter, pid, false, mess);
        if (car.isPlayer && car.owner !== pid) {
          // a car keeps most of it off its driver; a scooter's or a bike's rider is out in the open
          const victim = sim.players.get(car.owner);
          if (victim) sim.hurtPlayer(victim, w.dmg * (car.spec.twoWheeler ? 0.35 : 0.12), shooter.x, shooter.y, pid, mess);
        }
      } else if (pl.kind === HitKind.Wall) sparks |= 1 << i;
    });
    sim.events.shot({ by: shooter.id, pid, x: shot.ox, y: shot.oy, a: shot.a, w: shot.w, lvl: shot.lvl, ends, sparks });
    // (a peashooter makes no noise: nobody hears it, nobody runs)
    if (player && !w.quiet) {
      sim.crime(player, 'shoot');
      sim.police.danger(shooter.x, shooter.y, 16);
      for (const p of sim.pedsNear(shooter.x, shooter.y, 35))
        if (p.kind === 'civ' && !p.dazed && !p.vehicle && dist(p.x, p.y, shooter.x, shooter.y) < 35) this.scare(p, shooter.x, shooter.y);
    }
  }

  /** The second shelf's gags on someone a toy hit (after the soaking itself, hurtPed): Kofola makes
   *  them sticky, the perfume makes everyone near cough and run, a pea on the neck gets a word, the
   *  blower throws whoever it pushed over. */
  private toyHit(w: WeaponId, p: Ped, by: Shooter, pid: number, a: number, hx: number, hy: number) {
    const sim = this.sim;
    const victim = p.playerId ? sim.players.get(p.playerId) : undefined;
    if (p.playerId && (!victim || victim.id === pid || !sim.touchable(victim, pid))) return;
    switch (w) {
      case 'kofola':
        p.sticky = STICKY_S;
        if (victim) sim.events.toPlayer(victim.id, { k: 'sticky', t: STICKY_S });
        break;
      case 'perfume':
        if (victim) break;
        for (const q of sim.pedsNear(hx, hy, 5))
          if (q.kind === 'civ' && !q.dazed && !q.vehicle && dist(q.x, q.y, hx, hy) < 5) this.scare(q, by.x, by.y);
        if (!p.dazed && sim.time - p.saidAt > 2) sim.crowd.sayUp(p, 'perfume');
        break;
      case 'pea':
        if (!victim && !p.dazed && sim.time - p.saidAt > 2 && sim.rng.chance(0.6)) sim.crowd.sayUp(p, 'pea');
        break;
      case 'blower':
        if (victim) sim.events.toPlayer(victim.id, { k: 'knock', dx: Math.cos(a) * 0.6, dy: Math.sin(a) * 0.6 });
        // pushed over: blown a good way off
        else if (p.dazed) (p.vx = Math.cos(a) * 8), (p.vy = Math.sin(a) * 8);
        break;
    }
  }

  /** ...and on a car: the foam puts its fire out, the blower pushes a scooter, a bike or the
   *  football along */
  private toyCar(w: WeaponId, car: Vehicle, pid: number, a: number) {
    const sim = this.sim;
    if (w === 'foam') sim.extinguish(car);
    else if (w === 'blower' && (car.spec.twoWheeler || car.spec.ball)) sim.damageVehicle(car, 0, pid, { dvx: Math.cos(a) * 1.1, dvy: Math.sin(a) * 1.1, dav: 0 });
  }

  applyMelee(shooter: Shooter, pid: number, target: Ped | null) {
    this.sim.events.melee(shooter.x, shooter.y, !!target);
    if (target && !target.dazed) this.hurtPed(target, WEAPONS.fist.dmg, shooter, pid, true);
  }

  /** Soak a ped. `by` is who did it (for knock-back direction), `pid` the player responsible (0 =
   *  NPC); `melee`: a tickle (which the odd civilian answers in kind); `mess`: what it leaves them
   *  with. */
  hurtPed(p: Ped, dmg: number, by: { x: number; y: number } | null, pid: number, melee = false, mess: Mess = melee ? 'tickle' : 'water') {
    const sim = this.sim;
    if (p.dazed) return;
    if (p.playerId) {
      const victim = sim.players.get(p.playerId);
      if (victim && victim.id !== pid) sim.hurtPlayer(victim, dmg * 0.35, by?.x ?? p.x, by?.y ?? p.y, pid, mess);
      return;
    }
    const player = pid ? sim.players.get(pid) ?? null : null;
    p.health -= dmg;
    p.hitFlash = 0.14;
    sim.events.pedHit(p.id, p.x, p.y, 0.4, mess);
    if (p.health <= 0) {
      // soaked through (tickled till they sit down): down for a moment, then up and off home
      const first = !p.leaving;
      sim.knockDown(p, by?.x ?? p.x, by?.y ?? p.y, 3, melee ? 'melee' : 'shot', pid, mess);
      if (player) {
        sim.crime(player, p.kind === 'cop' ? 'killCop' : 'killPed');
        // (one reward a person: someone already on their way home to change pays nothing twice)
        if (first) {
          sim.dropCash(p.x, p.y, p.money);
          p.money = 0;
          const labels = SOAK_LABEL[mess] ?? SOAK_LABEL.water;
          sim.style(player, p.kind === 'cop' ? 'copsoak' : 'soak', p.x, p.y, { label: labels[p.kind === 'cop' ? 1 : 0] });
        }
      }
    } else if (p.kind === 'civ' && by) sim.crowd.hurt(p, player, by, melee);
    if (p.kind === 'cop' && player) sim.crime(player, 'shootCop');
  }

  scare(p: Ped, fx: number, fy: number) {
    // someone knocked down stays down until they get up by themselves (AI.getUp)
    if (p.dazed) return;
    // someone who got away and is on the phone to the police keeps talking, unless it's right by them
    if (p.state === 'phone' && dist(p.x, p.y, fx, fy) > 8) return;
    p.state = 'flee';
    p.timer = this.sim.rng.range(4, 7);
    p.fleeFrom.x = fx;
    p.fleeFrom.y = fy;
    p.goal = null;
    p.waitStop = -1;
  }

  /** A car blows up (or anything else explodes) at (x, y): it pushes cars away and knocks down whoever
   *  stands close, sooty (docs/plans/non-violent.md: nobody gets hurt). `pid` is the player responsible,
   *  if any. */
  explode(x: number, y: number, source: Vehicle | null, pid: number) {
    const sim = this.sim;
    sim.events.explode(x, y, source?.id ?? 0, source?.color ?? null);
    const player = pid ? sim.players.get(pid) ?? null : null;
    const lvl = source?.level ?? 0;
    for (const p of sim.pedsNear(x, y, 30)) {
      if (p.dazed || p.vehicle || p.aboard) continue;
      const d = dist(p.x, p.y, x, y);
      // the blast stays on its level (a deck or the tunnel roof shields the other side); everyone hears it
      if (d < 7 && p.level === lvl) {
        if (p.playerId) {
          const victim = sim.players.get(p.playerId);
          if (victim) sim.hurtPlayer(victim, 90 * (1 - d / 7), x, y, victim.id === pid ? 0 : pid, 'soot');
        } else {
          sim.knockDown(p, x, y, 10, 'blast', pid, 'soot');
          if (player) sim.crime(player, 'killPed');
        }
      } else if (d < 30 && p.kind === 'civ') this.scare(p, x, y);
    }
    for (const v of sim.vehiclesNear(x, y, 12)) {
      if (v === source || v.wrecked || v.level !== lvl) continue;
      const d = dist(v.x, v.y, x, y);
      // a scooter's or a bike's rider is out in the open: the blast reaches them as it would on foot
      const rider = v.spec.twoWheeler && d < 7 ? sim.players.get(v.owner) : undefined;
      if (rider && rider.ped.vehicle === v) sim.hurtPlayer(rider, 90 * (1 - d / 7), x, y, rider.id === pid ? 0 : pid, 'soot');
      if (d < 9) {
        // (a scooter or a bike is thrown, not fired off, and its rider with it: Sim.damageVehicle)
        const k = ((1 - d / 9) * 11) / Math.max(0.6, v.spec.mass / 1200);
        const nx = (v.x - x) / (d || 1), ny = (v.y - y) / (d || 1);
        sim.damageVehicle(v, 90 * (1 - d / 9), pid, { dvx: nx * k, dvy: ny * k, dav: (sim.rng.next() - 0.5) * k * 0.3 });
      }
    }
  }
}
