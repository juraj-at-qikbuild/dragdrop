// Vehicle state and arcade tyre physics. Shared by the browser and the game server; drawing lives in
// src/render/drawVehicle.ts and cosmetic effects (tyre smoke, sparks, splashes) in src/game/EntityFx.ts.
import type { World } from '../world/World';
import { clamp } from '../util/math';
import type { Ped } from './Ped';

export type VehicleKind = 'hatch' | 'sedan' | 'taxi' | 'police' | 'van' | 'bus' | 'sport' | 'classic';

export interface CarSpec {
  kind: VehicleKind;
  name: string;
  length: number;
  width: number;
  maxSpeed: number; // m/s
  accel: number;
  grip: number;
  mass: number;
  health: number;
  colors: string[];
  drive: 'fwd' | 'rwd' | 'awd';
  /** axle grip balance (1 = neutral); <1 on the front makes it push wide (understeer), <1 on the rear makes it swing out (oversteer) */
  frontGrip: number;
  rearGrip: number;
  /** yaw moment of inertia, kg·m² — filled in below from mass/length/width */
  inertia: number;
}

// All vehicles are parody models, loosely styled on cars you see on Bratislava streets.
export const SPECS: Record<VehicleKind, CarSpec> = {
  hatch: { kind: 'hatch', name: 'Škodovka Felícia', length: 3.9, width: 1.66, maxSpeed: 38, accel: 8, grip: 7, mass: 1000, health: 100,
    drive: 'fwd', frontGrip: 1, rearGrip: 1.05, inertia: 0,
    colors: ['#c62828', '#1565c0', '#2e7d32', '#f9a825', '#eeeeee', '#6d4c41', '#455a64', '#8e24aa'] },
  sedan: { kind: 'sedan', name: 'Octávka Kombi', length: 4.65, width: 1.8, maxSpeed: 46, accel: 9.5, grip: 7.5, mass: 1350, health: 110,
    drive: 'fwd', frontGrip: 1, rearGrip: 1.02, inertia: 0,
    colors: ['#263238', '#b0bec5', '#37474f', '#fafafa', '#1a237e', '#4e342e', '#7b1fa2'] },
  taxi: { kind: 'taxi', name: 'Hopík Taxi', length: 4.65, width: 1.8, maxSpeed: 44, accel: 9, grip: 7.5, mass: 1350, health: 110,
    drive: 'fwd', frontGrip: 1, rearGrip: 1.02, inertia: 0, colors: ['#fdd835'] },
  police: { kind: 'police', name: 'Policajná Octávka', length: 4.7, width: 1.82, maxSpeed: 50, accel: 11, grip: 8, mass: 1450, health: 160,
    drive: 'rwd', frontGrip: 1, rearGrip: 1, inertia: 0, colors: ['#f5f5f5'] },
  van: { kind: 'van', name: 'Dodávka Kofolka', length: 5.4, width: 2.05, maxSpeed: 34, accel: 6.5, grip: 6, mass: 2200, health: 150,
    drive: 'rwd', frontGrip: 0.85, rearGrip: 1, inertia: 0, colors: ['#c8102e', '#fafafa', '#1e88e5'] },
  bus: { kind: 'bus', name: 'Mestský autobus', length: 12, width: 2.55, maxSpeed: 26, accel: 4, grip: 5, mass: 11000, health: 300,
    drive: 'rwd', frontGrip: 0.8, rearGrip: 0.95, inertia: 0, colors: ['#d71920'] },
  sport: { kind: 'sport', name: 'Porše 911 Blava', length: 4.5, width: 1.85, maxSpeed: 62, accel: 15, grip: 9, mass: 1400, health: 90,
    drive: 'rwd', frontGrip: 1, rearGrip: 0.85, inertia: 0,
    colors: ['#ff6f00', '#212121', '#d50000', '#00bfa5'] },
  classic: { kind: 'classic', name: 'Tatrovka 603', length: 5.1, width: 1.9, maxSpeed: 40, accel: 7, grip: 6, mass: 1500, health: 140,
    drive: 'rwd', frontGrip: 1, rearGrip: 0.95, inertia: 0, colors: ['#111111', '#2b2b2b', '#5d1a1a'] },
};
for (const k of Object.keys(SPECS) as VehicleKind[]) {
  const s = SPECS[k];
  s.inertia = (s.mass * (s.length * s.length + s.width * s.width)) / 12;
}

export interface Controls {
  throttle: number; // -1..1
  steer: number; // -1..1 (positive = right / clockwise)
  handbrake: boolean;
  boost: boolean;
}

const STOPPED: Controls = { throttle: 0, steer: 0, handbrake: true, boost: false };

export class Vehicle {
  /** network id, assigned by Sim.addVehicle (or the server, for mirrors) */
  id = 0;
  spec: CarSpec;
  x: number;
  y: number;
  angle: number;
  vx = 0;
  vy = 0;
  av = 0;
  steer = 0;
  color: string;
  health: number;
  fire = -1; // seconds until explosion when burning
  wrecked = false;
  sinking = 0;
  driver: Ped | null = null;
  /** bridge deck level: 0 ground/underneath, 1 on the deck (see World.updateLevel) */
  level: 0 | 1 = 0;
  /** false until the first level update places it on/under a deck it spawned on (World.spawnLevel) */
  levelInit = false;
  /** id of the player driving it (0 = nobody / an NPC) */
  owner = 0;
  /** posed from outside the local simulation (a mirror of a server entity, or on the server a car its
   *  driver's client simulates): never integrated or pushed locally */
  kinematic = false;
  /** bumped when a static field (kind/colour/mission) changes, so snapshots resend it */
  rev = 0;
  /** last player whose shots/ram damaged it, for kill credit */
  lastDamagedBy = 0;
  lastDamagedAt = -1e9;
  siren = false;
  parked = false;
  mission = false;
  skid = 0;
  lastHit = 0;
  horn = 0;
  radius: number;
  circles: number[];
  ctrl: Controls = { throttle: 0, steer: 0, handbrake: false, boost: false };
  /** located damage 0..1, front/rear/left/right — for crumple rendering and handling penalties */
  dmg = { front: 0, rear: 0, left: 0, right: 0 };
  /** burst-tyre flag/bitmask (future spike strips): nonzero drops grip hard */
  tyresBurst = 0;
  /** nitro charge 0..1 */
  nitro = 1;
  boosting = false;
  private surf: 'asphalt' | 'cobble' | 'offroad' | 'bridge' = 'asphalt';
  private surfT = 0;

  /** shared per-frame environment, set by Game before stepping vehicles */
  static env = { wet: 0 };

  constructor(kind: VehicleKind, x: number, y: number, angle: number, color: string) {
    this.spec = SPECS[kind];
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.color = color;
    this.health = this.spec.health;
    const r = this.spec.width / 2;
    const n = Math.max(2, Math.ceil(this.spec.length / this.spec.width));
    this.circles = [];
    for (let i = 0; i < n; i++) this.circles.push(-this.spec.length / 2 + r + ((this.spec.length - 2 * r) * i) / (n - 1));
    this.radius = Math.hypot(this.spec.length / 2, this.spec.width / 2);
  }

  get speed() {
    return Math.hypot(this.vx, this.vy);
  }
  /** signed forward speed */
  get fwdSpeed() {
    return this.vx * Math.cos(this.angle) + this.vy * Math.sin(this.angle);
  }
  get kind() {
    return this.spec.kind;
  }
  /** driven by a player (local or remote) */
  get isPlayer() {
    return this.owner !== 0;
  }

  circleAt(i: number): [number, number] {
    const o = this.circles[i];
    return [this.x + Math.cos(this.angle) * o, this.y + Math.sin(this.angle) * o];
  }

  /** Fixed-step (Game calls this at 1/120 s) tyre-model update: axle slip-angle forces, weight transfer, yaw inertia. */
  update(dt: number, world: World): number {
    const s = this.spec;
    const c = this.wrecked || this.sinking ? STOPPED : this.ctrl;

    // surface, cached and re-queried a few times a second
    this.surfT -= dt;
    if (this.surfT <= 0) {
      this.surf = world.surfaceAt(this.x, this.y);
      this.surfT = 0.1;
    }
    let muSurf = this.surf === 'cobble' ? 0.9 : this.surf === 'offroad' ? 0.65 : 1;
    const offroadDrag = this.surf === 'offroad' ? 1.4 : 0;
    muSurf *= 1 - 0.28 * Vehicle.env.wet;
    const tyreMul = this.tyresBurst ? 0.45 : 1;

    // nitro
    if (c.boost && this.nitro > 0) {
      this.nitro = Math.max(0, this.nitro - 0.35 * dt);
      this.boosting = true;
    } else {
      this.boosting = false;
      this.nitro = Math.min(1, this.nitro + 0.03 * dt);
    }
    const boostAccel = this.boosting ? 1.6 : 1;
    const boostTop = this.boosting ? 1.25 : 1;
    const dmgTop = 1 - 0.2 * this.dmg.front;
    const dmgSteer = 1 - 0.35 * this.dmg.front;
    const maxSpeed = s.maxSpeed * boostTop * dmgTop;

    const fx = Math.cos(this.angle), fy = Math.sin(this.angle);
    const rx = -fy, ry = fx;
    let vF = this.vx * fx + this.vy * fy;
    let vR = this.vx * rx + this.vy * ry;

    // engine / brakes -> longitudinal accel this step (also drives weight transfer below)
    // braking (and, to a lesser extent, driving) is friction-limited: wet/loose surfaces stretch it out
    const muLong = clamp(muSurf, 0.35, 1);
    let ax = 0;
    if (c.throttle > 0) {
      ax = vF < -0.5 ? s.accel * 1.6 * muLong : s.accel * c.throttle * boostAccel * Math.sqrt(muLong) * (1 - Math.max(0, vF) / maxSpeed);
    } else if (c.throttle < 0) {
      ax = vF > 0.5 ? -s.accel * 1.8 * muLong : -s.accel * 0.6 * muLong;
    } else {
      ax = (-Math.sign(vF) * Math.min(Math.abs(vF), 2.2 * dt)) / dt;
    }
    ax -= Math.sign(vF || 1) * offroadDrag * Math.min(1, Math.abs(vF) / 4);
    vF += ax * dt;
    vF *= 1 - 0.08 * dt;
    if (c.handbrake) vF -= Math.sign(vF) * Math.min(Math.abs(vF), 5 * muLong * dt);
    vF = clamp(vF, -maxSpeed * 0.35, maxSpeed * 1.15);

    // steering
    this.steer += (c.steer - this.steer) * Math.min(1, dt * 10);
    const wheelbase = s.length * 0.6;
    const a = wheelbase * 0.5, b = wheelbase * 0.5; // axle distances from CG
    const maxSteer = (0.55 * dmgSteer) / (1 + Math.abs(vF) / 22);
    const steerAngle = this.steer * maxSteer;

    // weight transfer: braking loads the front, throttle loads the rear
    const staticF = s.mass * 4.9, staticR = s.mass * 4.9; // (mass*g/2)
    const transfer = clamp((s.mass * ax * 0.5) / wheelbase, -staticF * 0.6, staticR * 0.6);
    const loadF = Math.max(0.2 * staticF, staticF - transfer);
    const loadR = Math.max(0.2 * staticR, staticR + transfer);

    // axle slip angles, measured against |vF| so they stay small when rolling backwards (atan2 with a
    // negative x lands near ±PI and saturates the tyres). In reverse the steered wheels lead the other
    // way, so the steer term flips sign: wheel right swings the tail right, like a real car. It fades out
    // at a standstill so a parked car can't pivot on the spot.
    const dir = clamp(vF / 1.5, -1, 1);
    const vFa = Math.max(Math.abs(vF), 1.5);
    const slipF = Math.atan2(vR + a * this.av, vFa) - steerAngle * dir;
    const slipR = Math.atan2(vR - b * this.av, vFa);

    const muF = (s.grip / 7) * muSurf * s.frontGrip * tyreMul;
    const muR = (s.grip / 7) * muSurf * s.rearGrip * tyreMul * (c.handbrake ? 0.35 : 1);
    // Fy is a genuine force (N): tireCurve * mu * load-fraction * peak-accel-per-tyre * mass,
    // so dividing by mass below gives back the peak accel, and dividing by inertia gives a sane yaw accel.
    let FyF = -tireCurve(slipF) * muF * (loadF / staticF) * TIRE_FORCE * s.mass;
    let FyR = -tireCurve(slipR) * muR * (loadR / staticR) * TIRE_FORCE * s.mass;
    // friction ellipse: driven wheels give up some cornering force to longitudinal traction
    const driveF = s.drive === 'fwd' ? 1 : s.drive === 'awd' ? 0.5 : 0;
    const driveR = s.drive === 'rwd' ? 1 : s.drive === 'awd' ? 0.5 : 0;
    const demand = clamp(Math.abs(ax) / s.accel, 0, 1);
    FyF *= Math.sqrt(Math.max(0.15, 1 - 0.6 * (demand * driveF) ** 2));
    FyR *= Math.sqrt(Math.max(0.15, 1 - 0.6 * (demand * driveR) ** 2));

    vR += ((FyF + FyR) / s.mass) * dt;
    let avAccel = (a * FyF - b * FyR) / s.inertia;
    avAccel -= this.av * 0.6; // passive yaw damping
    if (Math.abs(vR) > 2.5 && this.steer * dir !== 0 && Math.sign(this.steer * dir) === -Math.sign(this.av)) avAccel -= this.av * 1.2; // counter-steer assist
    this.av += avAccel * dt;
    this.angle += this.av * dt;

    this.skid = Math.abs(vR) > 2.5 || (c.handbrake && Math.abs(vF) > 6) ? clamp(Math.abs(vR) / 7 + 0.3, 0, 1) : 0;

    const nfx = Math.cos(this.angle), nfy = Math.sin(this.angle);
    this.vx = nfx * vF - nfy * vR;
    this.vy = nfy * vF + nfx * vR;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // walls: impulse at the contact point, no energy gain
    let impact = 0;
    const r = s.width / 2;
    for (let i = 0; i < this.circles.length; i++) {
      const [cx, cy] = this.circleAt(i);
      const hit = world.collideCircle(cx, cy, r, this.level);
      if (!hit) continue;
      this.x += hit.nx * hit.depth;
      this.y += hit.ny * hit.depth;
      // hit.n points out of the wall; resolveContact wants the normal from the car towards what it hit,
      // applied at the circle's rim where it touches. Extra yaw inertia keeps an angled hit a deflection
      // along the wall rather than a spin-out.
      const px = cx - hit.nx * (r - hit.depth), py = cy - hit.ny * (r - hit.depth);
      const sev = resolveContact(this, px, py, null, px, py, -hit.nx, -hit.ny, 0.25, 0.45, undefined, 2.5);
      impact = Math.max(impact, sev);
    }
    if (impact > 7) this.damage((impact - 7) * 1.6);

    // water
    if (!this.sinking && world.inWater(this.x, this.y, this.level)) this.sinking = 0.001;
    if (this.sinking) {
      this.sinking += dt;
      this.vx *= 1 - dt * 2;
      this.vy *= 1 - dt * 2;
    }
    if (this.fire > 0) this.fire -= dt;
    if (this.horn > 0) this.horn -= dt;
    return impact;
  }

  damage(amount: number) {
    if (this.wrecked) return;
    this.health -= amount;
    if (this.health <= 0 && this.fire < 0) this.fire = 3.5;
  }

  /** Convert a world-space impact point to a local damage zone (front/rear/left/right) and accumulate. */
  applyDamageAt(px: number, py: number, amount: number) {
    if (amount <= 0) return;
    const fx = Math.cos(this.angle), fy = Math.sin(this.angle);
    const rx = -fy, ry = fx;
    const dx = px - this.x, dy = py - this.y;
    const lx = dx * fx + dy * fy, ly = dx * rx + dy * ry;
    const zone = Math.abs(lx) > Math.abs(ly) ? (lx > 0 ? 'front' : 'rear') : ly > 0 ? 'right' : 'left';
    this.dmg[zone] = clamp(this.dmg[zone] + amount, 0, 1);
  }

  /** Top up nitro charge (0..1), e.g. from a pickup. */
  addNitro(x: number) {
    this.nitro = clamp(this.nitro + x, 0, 1);
  }

  /** Apply AI or player controls (clamped). */
  setControls(throttle: number, steer: number, handbrake = false, boost = false) {
    this.ctrl.throttle = clamp(throttle, -1, 1);
    this.ctrl.steer = clamp(steer, -1, 1);
    this.ctrl.handbrake = handbrake;
    this.ctrl.boost = boost;
  }

}

const SLIP_PEAK = 0.15; // rad, ~8.6°, where a tyre's lateral force peaks
const TIRE_FORCE = 11; // m/s² of lateral accel a fully-loaded, fully-gripped tyre can give

/** Slip-angle -> normalized lateral force: rises to a peak near SLIP_PEAK, then softens slightly (real tyre behaviour, arcade-tuned). */
function tireCurve(slip: number): number {
  const x = clamp(slip / SLIP_PEAK, -4, 4);
  const base = Math.tanh(x * 1.3);
  const falloff = 1 - 0.15 * clamp(Math.abs(x) - 1, 0, 4);
  return base * Math.max(0.5, falloff);
}

/**
 * Resolves a contact-point impulse between vehicle `a` and either vehicle `b`, or an immovable surface
 * (b = null): a wall (bVel omitted) or a tram (bVel = its velocity at the contact, infinite mass so it
 * doesn't move). Restitution + Coulomb friction + angular terms from r×n keep it bounded (no energy gain)
 * and let side-swipes spin cars. `n` points from `a` towards `b` (into the wall/tram), i.e. opposite to the
 * direction `a` gets pushed out. `yawInertiaMul` > 1 makes `a` harder to spin (arcade-tuned wall hits).
 * Applies located damage on every party hit. Returns the impact severity.
 */
export function resolveContact(
  a: Vehicle, cax: number, cay: number,
  b: Vehicle | null, cbx: number, cby: number,
  nx: number, ny: number,
  restitution: number, friction: number,
  bVel?: { vx: number; vy: number; av: number },
  yawInertiaMul = 1,
): number {
  const invMa = 1 / a.spec.mass, invIa = 1 / (a.spec.inertia * yawInertiaMul);
  const invMb = b ? 1 / b.spec.mass : 0, invIb = b ? 1 / b.spec.inertia : 0;
  const rax = cax - a.x, ray = cay - a.y;
  const rbx = b ? cbx - b.x : 0, rby = b ? cby - b.y : 0;
  const bv = b ? { vx: b.vx, vy: b.vy, av: b.av } : bVel ?? { vx: 0, vy: 0, av: 0 };
  const pax = a.vx - a.av * ray, pay = a.vy + a.av * rax;
  const pbx = bv.vx - bv.av * rby, pby = bv.vy + bv.av * rbx;
  const rvx = pbx - pax, rvy = pby - pay;
  const vn = rvx * nx + rvy * ny;
  if (vn >= 0) return 0; // already separating

  const rCrossNa = rax * ny - ray * nx, rCrossNb = rbx * ny - rby * nx;
  const denomN = invMa + invMb + rCrossNa * rCrossNa * invIa + rCrossNb * rCrossNb * invIb;
  const jn = (-(1 + restitution) * vn) / (denomN || 1e-6);
  a.vx -= jn * nx * invMa;
  a.vy -= jn * ny * invMa;
  a.av -= rCrossNa * jn * invIa;
  if (b) {
    b.vx += jn * nx * invMb;
    b.vy += jn * ny * invMb;
    b.av += rCrossNb * jn * invIb;
  }

  const tx = -ny, ty = nx;
  const vt = rvx * tx + rvy * ty;
  const rCrossTa = rax * ty - ray * tx, rCrossTb = rbx * ty - rby * tx;
  const denomT = invMa + invMb + rCrossTa * rCrossTa * invIa + rCrossTb * rCrossTb * invIb;
  let jt = -vt / (denomT || 1e-6);
  const maxJt = friction * Math.abs(jn);
  jt = clamp(jt, -maxJt, maxJt);
  a.vx -= jt * tx * invMa;
  a.vy -= jt * ty * invMa;
  a.av -= rCrossTa * jt * invIa;
  if (b) {
    b.vx += jt * tx * invMb;
    b.vy += jt * ty * invMb;
    b.av += rCrossTb * jt * invIb;
  }

  const sev = -vn;
  a.applyDamageAt(cax, cay, clamp((sev - 3) * 0.06, 0, 0.4));
  if (b) b.applyDamageAt(cbx, cby, clamp((sev - 3) * 0.06, 0, 0.4));
  return sev;
}

