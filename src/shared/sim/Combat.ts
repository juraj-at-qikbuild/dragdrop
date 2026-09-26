// Weapons and damage rules: shot tracing, hits, kills and explosions. Visual effects are events (see
// events.ts); the browser draws them with Fx. A player's shot is traced by their own client against what
// it sees (`traceShot`) and applied here (`applyShot`), the server first validating the claim.
import type { Level } from '../world/World';
import type { Ped, WeaponId } from '../entities/Ped';
import type { Vehicle } from '../entities/Vehicle';
import type { World } from '../world/World';
import { dist } from '../util/math';
import type { Sim } from './Sim';

export const WEAPONS: Record<WeaponId, { name: string; dmg: number; cd: number; spread: number; range: number; pellets: number }> = {
  fist: { name: 'Päste', dmg: 34, cd: 0.45, spread: 0, range: 1.4, pellets: 1 },
  pistol: { name: 'Pištoľ', dmg: 55, cd: 0.3, spread: 0.035, range: 45, pellets: 1 },
  uzi: { name: 'Samopal', dmg: 28, cd: 0.085, spread: 0.08, range: 38, pellets: 1 },
  shotgun: { name: 'Brokovnica', dmg: 34, cd: 0.9, spread: 0.22, range: 22, pellets: 6 },
};
export const WEAPON_IDS: WeaponId[] = ['fist', 'pistol', 'uzi', 'shotgun'];

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
      if (p.id === s.id || p.dead || p.vehicle || p.level !== s.level) continue;
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
    if (p.id === s.id || p.dead || p.vehicle || p.level !== s.level) continue;
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
    const ends: number[] = [];
    let sparks = 0;
    const player = pid ? sim.players.get(pid) ?? null : null;
    shot.pellets.forEach((pl, i) => {
      ends.push(pl.hx, pl.hy);
      if (pl.kind === HitKind.Ped) {
        const p = sim.pedById(pl.hit);
        if (p && !p.dead) this.hurtPed(p, w.dmg, shooter, pid);
      } else if (pl.kind === HitKind.Car) {
        sparks |= 1 << i;
        const car = sim.vehicleById(pl.hit);
        if (!car || car.wrecked) return;
        const carDmg = w.dmg * 0.35 * car.armor;
        sim.damageVehicle(car, carDmg, pid);
        for (const r of sim.rules) r.onVehicleHit?.(car, carDmg, pid, pl.hx, pl.hy);
        // a pellet near a wheel bursts the tyres, for any car (Horúca Kofolka's box-in-and-ram dynamic)
        if (hitsWheel(car, pl.hx, pl.hy)) {
          car.tyresBurst = 1;
          if (car.owner) sim.events.toPlayer(car.owner, { k: 'tyres', vehicle: car.id });
        }
        if (player && car.kind === 'police' && !car.isPlayer) sim.crime(player, 'shootCop');
        if (car.driver && !car.driver.playerId && !car.isPlayer && sim.rng.chance(0.15)) this.hurtPed(car.driver, w.dmg, shooter, pid);
        if (car.isPlayer && car.owner !== pid) {
          const victim = sim.players.get(car.owner);
          if (victim) sim.hurtPlayer(victim, w.dmg * 0.12, shooter.x, shooter.y, pid);
        }
      } else if (pl.kind === HitKind.Wall) sparks |= 1 << i;
    });
    sim.events.shot({ by: shooter.id, pid, x: shot.ox, y: shot.oy, a: shot.a, w: shot.w, lvl: shot.lvl, ends, sparks });
    if (player) {
      sim.crime(player, 'shoot');
      sim.police.danger(shooter.x, shooter.y, 16);
      for (const p of sim.pedsNear(shooter.x, shooter.y, 35))
        if (p.kind === 'civ' && !p.dead && !p.vehicle && dist(p.x, p.y, shooter.x, shooter.y) < 35) this.scare(p, shooter.x, shooter.y);
    }
  }

  applyMelee(shooter: Shooter, pid: number, target: Ped | null) {
    this.sim.events.melee(shooter.x, shooter.y, !!target);
    if (target && !target.dead) this.hurtPed(target, WEAPONS.fist.dmg, shooter, pid, true);
  }

  /** Damage a ped. `by` is who did it (for knock-back direction), `pid` the player responsible (0 =
   *  NPC); `melee`: a punch (which the odd civilian answers in kind). */
  hurtPed(p: Ped, dmg: number, by: { x: number; y: number } | null, pid: number, melee = false) {
    const sim = this.sim;
    if (p.dead) return;
    if (p.playerId) {
      const victim = sim.players.get(p.playerId);
      if (victim && victim.id !== pid) sim.hurtPlayer(victim, dmg * 0.35, by?.x ?? p.x, by?.y ?? p.y, pid);
      return;
    }
    const player = pid ? sim.players.get(pid) ?? null : null;
    p.health -= dmg;
    p.hitFlash = 0.14;
    sim.events.pedHit(p.id, p.x, p.y, 0.4);
    if (p.health <= 0) {
      p.kill(by?.x ?? p.x, by?.y ?? p.y, 3);
      sim.events.pedHit(p.id, p.x, p.y, 1);
      sim.events.pedKilled(p.id, p.x, p.y, pid, 'shot');
      if (player) {
        sim.crime(player, p.kind === 'cop' ? 'killCop' : 'killPed');
        sim.dropCash(p.x, p.y, p.money);
        sim.events.toPlayer(player.id, { k: 'style', label: 'KILL', cash: p.kind === 'cop' ? 40 : 15, x: p.x, y: p.y - 1.5 });
      }
    } else if (p.kind === 'civ' && by) sim.crowd.hurt(p, player, by, melee);
    if (p.kind === 'cop' && player) sim.crime(player, 'shootCop');
  }

  scare(p: Ped, fx: number, fy: number) {
    // someone who got away and is on the phone to the police keeps talking, unless it's right by them
    if (p.state === 'phone' && dist(p.x, p.y, fx, fy) > 8) return;
    p.state = 'flee';
    p.timer = this.sim.rng.range(4, 7);
    p.fleeFrom.x = fx;
    p.fleeFrom.y = fy;
    p.goal = null;
    p.waitStop = -1;
  }

  /** A car blows up (or anything else explodes) at (x, y). `pid` is the player responsible, if any. */
  explode(x: number, y: number, source: Vehicle | null, pid: number) {
    const sim = this.sim;
    sim.events.explode(x, y, source?.id ?? 0, source?.color ?? null);
    const player = pid ? sim.players.get(pid) ?? null : null;
    const lvl = source?.level ?? 0;
    for (const p of sim.pedsNear(x, y, 30)) {
      if (p.dead || p.vehicle) continue;
      const d = dist(p.x, p.y, x, y);
      // the blast stays on its level (a deck or the tunnel roof shields the other side); everyone hears it
      if (d < 7 && p.level === lvl) {
        if (p.playerId) {
          const victim = sim.players.get(p.playerId);
          if (victim) sim.hurtPlayer(victim, 90 * (1 - d / 7), x, y, victim.id === pid ? 0 : pid);
        } else {
          p.kill(x, y, 10);
          sim.events.pedKilled(p.id, p.x, p.y, pid, 'blast');
          if (player) sim.crime(player, 'killPed');
        }
      } else if (d < 30 && p.kind === 'civ') this.scare(p, x, y);
    }
    for (const v of sim.vehiclesNear(x, y, 12)) {
      if (v === source || v.wrecked || v.level !== lvl) continue;
      const d = dist(v.x, v.y, x, y);
      if (d < 9) {
        const k = ((1 - d / 9) * 11) / (v.spec.mass / 1200);
        const nx = (v.x - x) / (d || 1), ny = (v.y - y) / (d || 1);
        sim.damageVehicle(v, 90 * (1 - d / 9), pid, { dvx: nx * k, dvy: ny * k, dav: (sim.rng.next() - 0.5) * k * 0.3 });
      }
    }
  }
}
