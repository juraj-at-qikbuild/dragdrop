import type { Atmosphere } from '../world/Atmosphere';
import type { LightLayer } from '../world/Lighting';
import type { World } from '../world/World';
import { clamp, pick } from '../util/math';
import type { Ped } from './Ped';
import { Combat } from '../game/Combat';

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

let nextId = 1;
const STOPPED: Controls = { throttle: 0, steer: 0, handbrake: true, boost: false };

export class Vehicle {
  id = nextId++;
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
  /** player-controlled? set by Game */
  isPlayer = false;
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

  constructor(kind: VehicleKind, x: number, y: number, angle: number, color?: string) {
    this.spec = SPECS[kind];
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.color = color ?? pick(this.spec.colors);
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

    // axle slip angles (signed, forward speed keeps its sign so reversing steers naturally)
    const vFx = Math.sign(vF || 1) * Math.max(Math.abs(vF), 1.5);
    const slipF = Math.atan2(vR + a * this.av, vFx) - steerAngle;
    const slipR = Math.atan2(vR - b * this.av, vFx);

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
    if (Math.abs(vR) > 2.5 && this.steer !== 0 && Math.sign(this.steer) === -Math.sign(this.av)) avAccel -= this.av * 1.2; // counter-steer assist
    this.av += avAccel * dt;
    this.angle += this.av * dt;

    this.skid = Math.abs(vR) > 2.5 || (c.handbrake && Math.abs(vF) > 6) ? clamp(Math.abs(vR) / 7 + 0.3, 0, 1) : 0;
    if (this.skid > 0.4 && Math.random() < dt * 5) {
      const bx = this.x - Math.cos(this.angle) * s.length * 0.4, by = this.y - Math.sin(this.angle) * s.length * 0.4;
      Combat.active?.tireSmoke(bx, by);
    }
    if (this.tyresBurst && this.speed > 2 && Math.random() < dt * 4) Combat.active?.metalSpark(this.x, this.y);

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
      const hit = world.collideCircle(cx, cy, r);
      if (!hit) continue;
      this.x += hit.nx * hit.depth;
      this.y += hit.ny * hit.depth;
      const sev = resolveContact(this, cx, cy, null, cx, cy, hit.nx, hit.ny, 0.3, 0.45);
      impact = Math.max(impact, sev);
    }
    if (impact > 5) this.damage((impact - 4) * 2.2);

    // water
    if (!this.sinking && world.inWater(this.x, this.y)) {
      this.sinking = 0.001;
      Combat.active?.splash(this.x, this.y);
    }
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

  /** Headlights, tail/brake lights, police flashers, fire. */
  emitLights(L: LightLayer, time: number, atmos?: Atmosphere) {
    if (!atmos) return;
    const s = this.spec;
    const fx = Math.cos(this.angle), fy = Math.sin(this.angle);
    const rx = -fy, ry = fx;
    const noseX = this.x + fx * (s.length / 2 - 0.1), noseY = this.y + fy * (s.length / 2 - 0.1);
    const tailX = this.x - fx * (s.length / 2 - 0.1), tailY = this.y - fy * (s.length / 2 - 0.1);
    const hw = s.width / 2 - 0.18;

    if (this.wrecked) {
      if (this.fire > -1 && Math.random() < 0.7) {
        const fl = 0.55 + Math.random() * 0.45;
        L.point(this.x, this.y, 3.2, '#ff5a1f', fl);
        L.glow(this.x, this.y, 3.5, '#ff8a3d', fl * 0.55);
      }
      return;
    }
    if (this.fire > 0) {
      const fl = 0.6 + Math.random() * 0.4;
      L.point(this.x, this.y, 3.4, '#ff6a00', fl);
      L.glow(this.x, this.y, 3.5, '#ff7a20', fl * 0.6);
    }

    const k = Math.max(atmos.night, atmos.rain * 0.5);
    if (k > 0.02) {
      L.cone(noseX, noseY, this.angle, 16, 0.35, '#fff1c8', k);
      L.point(noseX + rx * hw, noseY + ry * hw, 1.8, '#fff1c8', 0.65 * k);
      L.point(noseX - rx * hw, noseY - ry * hw, 1.8, '#fff1c8', 0.65 * k);
    }

    const braking = this.ctrl.throttle < 0 && this.fwdSpeed > 0.5;
    const tailGlow = braking ? 1 : 0.35 * k;
    if (tailGlow > 0.02) {
      L.glow(tailX + rx * hw, tailY + ry * hw, braking ? 1.6 : 1, '#ff2a2a', tailGlow);
      L.glow(tailX - rx * hw, tailY - ry * hw, braking ? 1.6 : 1, '#ff2a2a', tailGlow);
    }
    if (k > 0.02) {
      L.point(tailX + rx * hw, tailY + ry * hw, 1.1, '#ff2a2a', 0.5 * k);
      L.point(tailX - rx * hw, tailY - ry * hw, 1.1, '#ff2a2a', 0.5 * k);
    }

    if (s.kind === 'police' && this.siren) {
      const on = Math.floor(time * 6) % 2 === 0;
      const c1 = on ? '#ff1744' : '#2979ff', c2 = on ? '#2979ff' : '#ff1744';
      const lx = this.x + rx * 0.22, ly = this.y + ry * 0.22;
      const rx2 = this.x - rx * 0.22, ry2 = this.y - ry * 0.22;
      L.point(lx, ly, 9, c1, 0.85);
      L.glow(lx, ly, 5, c1, 0.6);
      L.point(rx2, ry2, 9, c2, 0.85);
      L.glow(rx2, ry2, 5, c2, 0.6);
    }
  }

  draw(ctx: CanvasRenderingContext2D, time: number, atmos?: Atmosphere) {
    const s = this.spec;
    const L = s.length, W = s.width;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);
    if (this.sinking) {
      const k = Math.max(0.15, 1 - this.sinking / 2.5);
      ctx.globalAlpha = k;
      ctx.scale(k * 0.3 + 0.7, k * 0.3 + 0.7);
    }
    // shadow: cast along the sun direction, rotated into the car's local frame;
    // a small tight contact shadow at night instead of a long cast one.
    const night = atmos?.night ?? 0;
    let sx = 0.22, sy = 0.32, salpha = 0.3;
    if (atmos) {
      if (night > 0.72) {
        sx = 0.1; sy = 0.14; salpha = 0.28;
      } else {
        const h = 1.15;
        const wx = atmos.sun.dx * h, wy = atmos.sun.dy * h;
        const ca = Math.cos(this.angle), sa = Math.sin(this.angle);
        sx = wx * ca + wy * sa;
        sy = -wx * sa + wy * ca;
        salpha = 0.25 + 0.2 * atmos.daylight;
      }
    }
    ctx.fillStyle = `rgba(0,0,0,${salpha})`;
    roundRect(ctx, -L / 2 + sx, -W / 2 + sy, L, W, 0.4);
    ctx.fill();

    // wheels (front pair steers)
    const wheelLen = Math.min(0.5, L * 0.11), wheelWid = 0.22;
    const wx0 = L * 0.315, wy0 = W / 2 - 0.06;
    const steerAngle = this.steer * 0.5;
    drawWheel(ctx, wx0, -wy0, steerAngle, wheelLen, wheelWid);
    drawWheel(ctx, wx0, wy0, steerAngle, wheelLen, wheelWid);
    drawWheel(ctx, -wx0, -wy0, 0, wheelLen, wheelWid);
    drawWheel(ctx, -wx0, wy0, 0, wheelLen, wheelWid);

    const body = this.wrecked ? '#2a2623' : this.color;
    ctx.fillStyle = this.wrecked ? body : bodyGradient(ctx, body);
    roundRect(ctx, -L / 2, -W / 2, L, W, s.kind === 'bus' ? 0.35 : 0.5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 0.08;
    ctx.stroke();

    const glass = this.wrecked ? '#111' : '#27343f';
    if (s.kind === 'bus') {
      // DPB red/white livery: white belly band, red top/bottom, roof vents, doors
      ctx.fillStyle = this.wrecked ? '#222' : '#f2f2f2';
      ctx.fillRect(-L / 2 + 0.6, -W / 2 + 0.25, L - 1.2, W - 0.5);
      ctx.fillStyle = glass;
      ctx.fillRect(L / 2 - 0.55, -W / 2 + 0.2, 0.4, W - 0.4);
      ctx.fillStyle = this.wrecked ? '#333' : '#c9c9c9';
      for (let i = 0; i < 3; i++) ctx.fillRect(-L / 2 + 2 + i * 3.4, -0.5, 1.2, 1);
      ctx.fillStyle = body;
      ctx.fillRect(-L / 2 + 0.6, -0.12, L - 1.2, 0.24);
      if (!this.wrecked) {
        // roof vents
        ctx.fillStyle = shade(body, -0.25);
        for (let i = 0; i < 4; i++) roundRect(ctx, -L / 2 + 1.6 + i * 2.4, -0.55, 0.9, 1.1, 0.15), ctx.fill();
        // doors
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 0.05;
        for (const dx of [-L / 2 + 3.2, L / 2 - 2.6]) {
          ctx.beginPath();
          ctx.moveTo(dx, -W / 2 + 0.05);
          ctx.lineTo(dx, W / 2 - 0.05);
          ctx.stroke();
        }
        ctx.fillStyle = '#fdd835';
        ctx.font = '700 0.5px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('DPB', -L / 2 + 1.1, 0);
      }
    } else if (s.kind === 'van') {
      ctx.fillStyle = glass;
      ctx.fillRect(L / 2 - 1.35, -W / 2 + 0.2, 0.55, W - 0.4);
      ctx.fillStyle = this.wrecked ? '#333' : '#f5f5f5';
      ctx.fillRect(-L / 2 + 0.25, -W / 2 + 0.2, L - 1.8, W - 0.4);
      if (!this.wrecked) {
        // roof rack
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 0.05;
        ctx.strokeRect(-L / 2 + 0.5, -W / 2 + 0.35, L - 1, W - 0.7);
        ctx.fillStyle = '#c8102e';
        ctx.font = '900 0.62px Arial Black, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('KOFOLKA', -0.65, 0.02);
      }
      mirrors(ctx, L, W, body);
    } else {
      const k = s.kind === 'sport' ? 0.9 : 1;
      // windscreen
      ctx.fillStyle = glass;
      ctx.beginPath();
      ctx.moveTo(L * 0.2, -W / 2 + 0.18);
      ctx.lineTo(L * 0.33 * k, -W / 2 + 0.3);
      ctx.lineTo(L * 0.33 * k, W / 2 - 0.3);
      ctx.lineTo(L * 0.2, W / 2 - 0.18);
      ctx.closePath();
      ctx.fill();
      if (!this.wrecked) {
        ctx.strokeStyle = 'rgba(255,255,255,0.32)';
        ctx.lineWidth = 0.05;
        ctx.beginPath();
        ctx.moveTo(L * 0.23, -W / 2 + 0.26);
        ctx.lineTo(L * 0.29 * k, -0.02);
        ctx.stroke();
      }
      // rear window
      ctx.beginPath();
      ctx.moveTo(-L * 0.26, -W / 2 + 0.2);
      ctx.lineTo(-L * 0.36, -W / 2 + 0.32);
      ctx.lineTo(-L * 0.36, W / 2 - 0.32);
      ctx.lineTo(-L * 0.26, W / 2 - 0.2);
      ctx.closePath();
      ctx.fill();
      // roof
      ctx.fillStyle = this.wrecked ? '#1c1a18' : shade(body, s.kind === 'police' ? -0.05 : -0.12);
      roundRect(ctx, -L * 0.26, -W / 2 + 0.2, L * 0.46, W - 0.4, 0.25);
      ctx.fill();
      if (s.kind === 'police' && !this.wrecked) {
        ctx.fillStyle = '#1a3f9c';
        ctx.fillRect(-L / 2 + 0.2, -W / 2, L - 0.4, 0.22);
        ctx.fillRect(-L / 2 + 0.2, W / 2 - 0.22, L - 0.4, 0.22);
        const on = this.siren && Math.floor(time * 6) % 2 === 0;
        ctx.fillStyle = this.siren ? (on ? '#ff1744' : '#2979ff') : '#90a4ae';
        ctx.fillRect(-0.18, -W / 2 + 0.28, 0.36, (W - 0.56) / 2);
        ctx.fillStyle = this.siren ? (on ? '#2979ff' : '#ff1744') : '#90a4ae';
        ctx.fillRect(-0.18, 0, 0.36, (W - 0.56) / 2);
      }
      if (s.kind === 'taxi' && !this.wrecked) {
        ctx.fillStyle = '#111';
        ctx.fillRect(-0.3, -0.45, 0.55, 0.9);
        ctx.fillStyle = '#fdd835';
        ctx.font = '700 0.28px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.save();
        ctx.rotate(Math.PI / 2);
        ctx.fillText('TAXI', 0, 0.1);
        ctx.restore();
      }
      if (s.kind === 'sport' && !this.wrecked) {
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillRect(-L / 2, -0.25, L, 0.14);
        ctx.fillRect(-L / 2, 0.11, L, 0.14);
        // rear spoiler
        ctx.fillStyle = shade(body, -0.3);
        ctx.fillRect(-L / 2 - 0.05, -W / 2 + 0.06, 0.12, W - 0.12);
        ctx.fillRect(-L / 2 + 0.02, -W / 2 + 0.08, 0.05, W - 0.16);
      }
      mirrors(ctx, L, W, s.kind === 'sport' ? shade(body, -0.2) : body);
    }
    // damage: scuffs from lost health, cracked windscreen when badly hurt
    const dmgFrac = clamp(1 - this.health / s.health, 0, 1);
    if (this.wrecked) {
      ctx.fillStyle = 'rgba(20,16,14,0.45)';
      for (let i = 0; i < 6; i++) {
        const o = DMG_OFFSETS[i];
        ctx.beginPath();
        ctx.ellipse(o[0] * L * 0.42, o[1] * W * 0.42, o[2] * 0.5, o[2] * 0.32, o[0], 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (dmgFrac > 0.12) {
      const n = Math.min(DMG_OFFSETS.length, 1 + Math.floor(dmgFrac * 6));
      ctx.fillStyle = 'rgba(20,16,14,0.28)';
      for (let i = 0; i < n; i++) {
        const o = DMG_OFFSETS[i];
        ctx.beginPath();
        ctx.ellipse(o[0] * L * 0.42, o[1] * W * 0.42, o[2] * 0.4, o[2] * 0.26, o[0], 0, Math.PI * 2);
        ctx.fill();
      }
      if (dmgFrac > 0.45 && s.kind !== 'bus' && s.kind !== 'van') {
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 0.03;
        ctx.beginPath();
        ctx.moveTo(L * 0.22, -0.1);
        ctx.lineTo(L * 0.28, 0.05);
        ctx.lineTo(L * 0.24, 0.2);
        ctx.moveTo(L * 0.26, -0.15);
        ctx.lineTo(L * 0.3, -0.02);
        ctx.stroke();
      }
    }
    // lights
    if (!this.wrecked) {
      ctx.fillStyle = '#fff6c4';
      ctx.fillRect(L / 2 - 0.16, -W / 2 + 0.12, 0.14, 0.38);
      ctx.fillRect(L / 2 - 0.16, W / 2 - 0.5, 0.14, 0.38);
      const braking = this.ctrl.throttle < 0 && this.fwdSpeed > 0.5;
      ctx.fillStyle = braking ? '#ff1f1f' : '#9b1111';
      ctx.fillRect(-L / 2 + 0.02, -W / 2 + 0.12, 0.14, 0.34);
      ctx.fillRect(-L / 2 + 0.02, W / 2 - 0.46, 0.14, 0.34);
    }
    if (this.mission && !this.wrecked) {
      ctx.strokeStyle = `rgba(255,214,0,${0.5 + 0.5 * Math.sin(time * 6)})`;
      ctx.lineWidth = 0.25;
      roundRect(ctx, -L / 2 - 0.4, -W / 2 - 0.4, L + 0.8, W + 0.8, 0.6);
      ctx.stroke();
    }
    ctx.restore();
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
 * and let side-swipes spin cars. Applies located damage on every party hit. Returns the impact severity.
 */
export function resolveContact(
  a: Vehicle, cax: number, cay: number,
  b: Vehicle | null, cbx: number, cby: number,
  nx: number, ny: number,
  restitution: number, friction: number,
  bVel?: { vx: number; vy: number; av: number },
): number {
  const invMa = 1 / a.spec.mass, invIa = 1 / a.spec.inertia;
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

/** fractional (x, y, size) offsets for damage scuffs, deterministic across frames */
const DMG_OFFSETS: [number, number, number][] = [
  [0.35, -0.55, 0.5], [-0.5, 0.5, 0.42], [0.6, 0.4, 0.4], [-0.65, -0.45, 0.45], [0.05, 0.15, 0.55], [0.5, -0.1, 0.38],
];

function drawWheel(ctx: CanvasRenderingContext2D, x: number, y: number, ang: number, len: number, wid: number) {
  ctx.save();
  ctx.translate(x, y);
  if (ang) ctx.rotate(ang);
  ctx.fillStyle = '#161616';
  roundRect(ctx, -len / 2, -wid / 2, len, wid, 0.06);
  ctx.fill();
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(-len / 2 + 0.05, -0.03, len - 0.1, 0.06);
  ctx.restore();
}

function mirrors(ctx: CanvasRenderingContext2D, L: number, W: number, color: string) {
  ctx.fillStyle = shade(color, -0.25);
  ctx.fillRect(L * 0.14, -W / 2 - 0.06, 0.16, 0.1);
  ctx.fillRect(L * 0.14, W / 2 - 0.04, 0.16, 0.1);
}

const bodyGradCache = new Map<string, CanvasGradient>();
/** cached vertical gradient (across the car's width) giving a subtle specular ridge down the centreline */
function bodyGradient(ctx: CanvasRenderingContext2D, color: string) {
  let g = bodyGradCache.get(color);
  if (g) return g;
  g = ctx.createLinearGradient(0, -1.35, 0, 1.35);
  g.addColorStop(0, shade(color, -0.26));
  g.addColorStop(0.42, shade(color, 0.14));
  g.addColorStop(0.58, shade(color, 0.14));
  g.addColorStop(1, shade(color, -0.26));
  bodyGradCache.set(color, g);
  return g;
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

const shadeCache = new Map<string, string>();
export function shade(hex: string, amt: number) {
  const key = hex + amt;
  let r = shadeCache.get(key);
  if (r) return r;
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(clamp(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt, 0, 255));
  r = `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  shadeCache.set(key, r);
  return r;
}
