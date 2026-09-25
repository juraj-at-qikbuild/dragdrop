// Fixed-step vehicle physics and contacts (car-car, car-tram, ped-car, ped-tram), shared by the
// offline Sim, the server Sim and the online client (which simulates only its own car against mirrors).
//
// Bodies flagged `kinematic` are posed from outside (network mirrors on a client, players' cars on the
// server). They are never integrated or pushed here; against a dynamic body they act as a moving wall of
// infinite mass. Everything else behaves exactly like the original single-player code.
import { Vehicle, resolveContact } from '../entities/Vehicle';
import type { Ped } from '../entities/Ped';
import type { Tram } from '../entities/Tram';
import type { World } from '../world/World';
import { SpatialHash } from '../util/SpatialHash';
import { dist } from '../util/math';

export const PHYS_STEP = 1 / 120;
/** half the tram body's width, for bridge-deck fit checks */
export const TRAM_RADIUS = 1.2;
/** a car faster than this runs a pedestrian over instead of nudging them */
export const RUN_OVER_SPEED = 4.5;

export interface PhysicsHooks {
  /** a car hit a wall hard (sev > 6), once per substep */
  impact?(v: Vehicle, sev: number): void;
  /** two cars collided (after impulses and damage); n points from a to b */
  carContact?(a: Vehicle, b: Vehicle, sev: number, cx: number, cy: number, nx: number, ny: number): void;
  /** two kinematic cars overlap (server: two players' cars) */
  kinematicPair?(a: Vehicle, b: Vehicle): void;
  /** a tram shoved a car */
  tramContact?(v: Vehicle, t: Tram, sev: number): void;
}

interface Contact {
  nx: number;
  ny: number;
  depth: number;
  cx: number;
  cy: number;
}

export class VehiclePhysics {
  private accum = 0;
  readonly hash = new SpatialHash<Vehicle>(10);
  /** server: kinematic bodies coast along their last reported velocity between reports */
  extrapolateKinematic = false;

  /** Advance `dt` seconds in fixed substeps. Call with every vehicle and tram that can touch. */
  step(dt: number, vehicles: readonly Vehicle[], trams: readonly Tram[], world: World, hooks: PhysicsHooks) {
    this.accum = Math.min(this.accum + dt, PHYS_STEP * 8);
    for (const v of vehicles) {
      if (v.levelInit || v.kinematic) continue;
      v.level = world.spawnLevel(v.x, v.y, v.spec.width / 2, v.angle);
      v.levelInit = true;
    }
    while (this.accum >= PHYS_STEP) {
      for (const v of vehicles) {
        if (v.kinematic) {
          if (this.extrapolateKinematic) {
            v.x += v.vx * PHYS_STEP;
            v.y += v.vy * PHYS_STEP;
            v.angle += v.av * PHYS_STEP;
          }
          continue;
        }
        if (v.parked && !v.isPlayer && v.speed < 0.01 && v.fire < 0) continue;
        // per substep: the water check inside update() must see the deck level for this position
        world.updateLevel(v, v.vx, v.vy, v.spec.width / 2, !v.sinking);
        const impact = v.update(PHYS_STEP, world);
        if (impact > 6) hooks.impact?.(v, impact);
      }
      this.collide(vehicles, trams, hooks);
      this.accum -= PHYS_STEP;
    }
  }

  /** rebuild the broad-phase hash (also used by ped contacts and AI queries) */
  rehash(vehicles: readonly Vehicle[]) {
    this.hash.clear();
    for (const v of vehicles) this.hash.insert(v, v.x, v.y, v.radius);
  }

  private collide(vs: readonly Vehicle[], trams: readonly Tram[], hooks: PhysicsHooks) {
    this.rehash(vs);
    for (const a of vs) {
      this.hash.query(a.x, a.y, a.radius, (b) => {
        if (b.id <= a.id || a.level !== b.level) return;
        const rr = a.radius + b.radius;
        if (Math.abs(a.x - b.x) > rr || Math.abs(a.y - b.y) > rr) return;
        const best = deepest(a, b);
        if (!best) return;
        if (a.kinematic && b.kinematic) return void hooks.kinematicPair?.(a, b);
        if (a.kinematic || b.kinematic) return kinematicContact(a, b, best, hooks);
        const ma = a.parked && !a.isPlayer ? a.spec.mass * 1.5 : a.spec.mass;
        const mb = b.parked && !b.isPlayer ? b.spec.mass * 1.5 : b.spec.mass;
        const tot = ma + mb;
        a.x -= best.nx * best.depth * (mb / tot);
        a.y -= best.ny * best.depth * (mb / tot);
        b.x += best.nx * best.depth * (ma / tot);
        b.y += best.ny * best.depth * (ma / tot);
        const sev = resolveContact(a, best.cx, best.cy, b, best.cx, best.cy, best.nx, best.ny, 0.25, 0.4);
        if (sev <= 0) return;
        if (a.parked || b.parked) {
          a.parked = a.parked && !a.isPlayer && a.speed < 0.5 ? a.parked : false;
          b.parked = b.parked && !b.isPlayer && b.speed < 0.5 ? b.parked : false;
        }
        if (sev > 5) {
          a.damage((sev - 4) * 2 * (mb / tot) * 1.6);
          b.damage((sev - 4) * 2 * (ma / tot) * 1.6);
        }
        hooks.carContact?.(a, b, sev, best.cx, best.cy, best.nx, best.ny);
      });
    }
    // trams: infinite-mass contact through the same impulse solver
    for (const t of trams)
      for (const v of vs) {
        if (v.kinematic || v.level !== t.level || Math.abs(v.x - t.x) > 40 || Math.abs(v.y - t.y) > 40) continue;
        const s = t.hits(v.x, v.y, v.spec.width / 2);
        if (!s) continue;
        const nx = -Math.sin(s.a), ny = Math.cos(s.a);
        const side = (v.x - s.x) * nx + (v.y - s.y) * ny >= 0 ? 1 : -1;
        const n2x = nx * side, n2y = ny * side;
        v.x += n2x * 0.15;
        v.y += n2y * 0.15;
        const sev = resolveContact(v, v.x, v.y, null, v.x, v.y, -n2x, -n2y, 0.15, 0.5, {
          vx: Math.cos(s.a) * t.speed, vy: Math.sin(s.a) * t.speed, av: 0,
        });
        if (sev > 2) {
          if (t.speed > 3) v.damage(t.speed * 0.1);
          hooks.tramContact?.(v, t, sev);
        }
      }
  }
}

/** deepest overlap between the two cars' circle chains, or null */
function deepest(a: Vehicle, b: Vehicle): Contact | null {
  let best: Contact | null = null;
  const ra = a.spec.width / 2, rb = b.spec.width / 2;
  for (let ci = 0; ci < a.circles.length; ci++) {
    const [ax, ay] = a.circleAt(ci);
    for (let cj = 0; cj < b.circles.length; cj++) {
      const [bx, by] = b.circleAt(cj);
      const d = Math.hypot(bx - ax, by - ay);
      const depth = ra + rb - d;
      if (depth > 0 && (!best || depth > best.depth))
        best = { nx: (bx - ax) / (d || 1), ny: (by - ay) / (d || 1), depth, cx: (ax + bx) / 2, cy: (ay + by) / 2 };
    }
  }
  return best;
}

/** A dynamic car against a kinematic one: the kinematic car is a moving wall of infinite mass. Only the
 *  dynamic side is pushed and damaged (whoever simulates the other car handles its side). */
function kinematicContact(a: Vehicle, b: Vehicle, c: Contact, hooks: PhysicsHooks) {
  const dyn = a.kinematic ? b : a, kin = a.kinematic ? a : b;
  const s = dyn === a ? 1 : -1;
  const nx = c.nx * s, ny = c.ny * s;
  dyn.x -= nx * c.depth;
  dyn.y -= ny * c.depth;
  const sev = resolveContact(dyn, c.cx, c.cy, null, c.cx, c.cy, nx, ny, 0.25, 0.4, { vx: kin.vx, vy: kin.vy, av: 0 });
  if (sev <= 0) return;
  if (dyn.parked && !dyn.isPlayer && dyn.speed > 0.5) dyn.parked = false;
  if (sev > 5) {
    const share = kin.spec.mass / (kin.spec.mass + dyn.spec.mass);
    dyn.damage((sev - 4) * 2 * share * 1.6);
  }
  hooks.carContact?.(dyn, kin, sev, c.cx, c.cy, nx, ny);
}

export interface PedContactHooks {
  /** a car faster than RUN_OVER_SPEED hit the ped (it has not been moved or hurt yet) */
  runOver(p: Ped, v: Vehicle, speed: number, cx: number, cy: number): void;
  /** a moving tram hit the ped */
  tramHit(p: Ped, t: Tram, sx: number, sy: number): void;
}

/** Pedestrians against cars and trams: slow cars nudge people aside, fast ones run them over. */
export function pedContacts(peds: readonly Ped[], hash: SpatialHash<Vehicle>, trams: readonly Tram[], dt: number, hooks: PedContactHooks) {
  for (const p of peds) {
    if (p.vehicle || p.dead || p.kinematic) continue;
    pedContact(p, hash, trams, dt, hooks);
  }
}

export function pedContact(p: Ped, hash: SpatialHash<Vehicle>, trams: readonly Tram[], dt: number, hooks: PedContactHooks) {
  let hit = false;
  hash.query(p.x, p.y, 3, (v) => {
    if (hit || v.level !== p.level) return;
    if (Math.abs(v.x - p.x) > v.radius + 1 || Math.abs(v.y - p.y) > v.radius + 1) return;
    const r = v.spec.width / 2 + p.r;
    for (let i = 0; i < v.circles.length; i++) {
      const [cx, cy] = v.circleAt(i);
      const d = dist(cx, cy, p.x, p.y);
      if (d >= r) continue;
      const sp = v.speed;
      if (sp > RUN_OVER_SPEED) hooks.runOver(p, v, sp, cx, cy);
      else {
        const nx = (p.x - cx) / (d || 1), ny = (p.y - cy) / (d || 1);
        p.x += nx * (r - d);
        p.y += ny * (r - d);
      }
      hit = true;
      break;
    }
  });
  for (const t of trams) {
    if (t.level !== p.level || Math.abs(t.x - p.x) > 40 || Math.abs(t.y - p.y) > 40) continue;
    const s = t.hits(p.x, p.y, p.r);
    if (!s) continue;
    if (t.speed > 3) hooks.tramHit(p, t, s.x, s.y);
    const nx = -Math.sin(s.a), ny = Math.cos(s.a);
    const side = (p.x - s.x) * nx + (p.y - s.y) * ny >= 0 ? 1 : -1;
    p.x += nx * side * 3 * dt * 10;
    p.y += ny * side * 3 * dt * 10;
  }
}

/** bridge-deck level (0 ground/underneath, 1 on top) for trams and peds; vehicles are updated per
 *  physics substep, and anyone inside a vehicle shares its level. Kinematic bodies keep theirs. */
export function updateLevels(world: World, trams: readonly Tram[], peds: readonly Ped[]) {
  for (const t of trams) {
    if (!t.levelInit) (t.level = world.spawnLevel(t.x, t.y, TRAM_RADIUS, t.angle)), (t.levelInit = true);
    else world.updateLevel(t, Math.cos(t.angle) * t.speed, Math.sin(t.angle) * t.speed, TRAM_RADIUS, false);
  }
  for (const p of peds) {
    if (p.kinematic) continue;
    if (p.vehicle) (p.level = p.vehicle.level), (p.levelInit = true);
    else if (!p.levelInit) (p.level = world.spawnLevel(p.x, p.y, p.r)), (p.levelInit = true);
    else world.updateLevel(p, p.vx, p.vy, p.r);
  }
}
