import type { Atmosphere } from '../world/Atmosphere';
import type { LightLayer } from '../world/Lighting';
import type { World } from '../world/World';
import { clamp, pick } from '../util/math';
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
}

// All vehicles are parody models, loosely styled on cars you see on Bratislava streets.
export const SPECS: Record<VehicleKind, CarSpec> = {
  hatch: { kind: 'hatch', name: 'Škodovka Felícia', length: 3.9, width: 1.66, maxSpeed: 38, accel: 8, grip: 7, mass: 1000, health: 100,
    colors: ['#c62828', '#1565c0', '#2e7d32', '#f9a825', '#eeeeee', '#6d4c41', '#455a64', '#8e24aa'] },
  sedan: { kind: 'sedan', name: 'Octávka Kombi', length: 4.65, width: 1.8, maxSpeed: 46, accel: 9.5, grip: 7.5, mass: 1350, health: 110,
    colors: ['#263238', '#b0bec5', '#37474f', '#fafafa', '#1a237e', '#4e342e', '#7b1fa2'] },
  taxi: { kind: 'taxi', name: 'Hopík Taxi', length: 4.65, width: 1.8, maxSpeed: 44, accel: 9, grip: 7.5, mass: 1350, health: 110, colors: ['#fdd835'] },
  police: { kind: 'police', name: 'Policajná Octávka', length: 4.7, width: 1.82, maxSpeed: 50, accel: 11, grip: 8, mass: 1450, health: 160, colors: ['#f5f5f5'] },
  van: { kind: 'van', name: 'Dodávka Kofolka', length: 5.4, width: 2.05, maxSpeed: 34, accel: 6.5, grip: 6, mass: 2200, health: 150, colors: ['#c8102e', '#fafafa', '#1e88e5'] },
  bus: { kind: 'bus', name: 'Mestský autobus', length: 12, width: 2.55, maxSpeed: 26, accel: 4, grip: 5, mass: 11000, health: 300, colors: ['#d71920'] },
  sport: { kind: 'sport', name: 'Porše 911 Blava', length: 4.5, width: 1.85, maxSpeed: 62, accel: 15, grip: 9, mass: 1400, health: 90, colors: ['#ff6f00', '#212121', '#d50000', '#00bfa5'] },
  classic: { kind: 'classic', name: 'Tatrovka 603', length: 5.1, width: 1.9, maxSpeed: 40, accel: 7, grip: 6, mass: 1500, health: 140, colors: ['#111111', '#2b2b2b', '#5d1a1a'] },
};

export interface Controls {
  throttle: number; // -1..1
  steer: number; // -1..1 (positive = right / clockwise)
  handbrake: boolean;
}

let nextId = 1;

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
  ctrl: Controls = { throttle: 0, steer: 0, handbrake: false };

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

  update(dt: number, world: World): number {
    const s = this.spec;
    const c = this.wrecked || this.sinking ? { throttle: 0, steer: 0, handbrake: true } : this.ctrl;
    const fx = Math.cos(this.angle), fy = Math.sin(this.angle);
    const rx = -fy, ry = fx;
    let vF = this.vx * fx + this.vy * fy;
    let vR = this.vx * rx + this.vy * ry;

    // engine / brakes
    if (c.throttle > 0) {
      if (vF < -0.5) vF += s.accel * 1.6 * dt;
      else vF += s.accel * c.throttle * dt * (1 - Math.max(0, vF) / s.maxSpeed);
    } else if (c.throttle < 0) {
      if (vF > 0.5) vF -= s.accel * 1.8 * dt;
      else vF = Math.max(vF - s.accel * 0.6 * dt, -s.maxSpeed * 0.3);
    } else {
      vF -= Math.sign(vF) * Math.min(Math.abs(vF), 2.2 * dt);
    }
    vF *= 1 - 0.08 * dt;

    // lateral grip (handbrake lets the back end slide)
    const grip = c.handbrake ? 1.2 : s.grip;
    const lat = vR * Math.min(1, grip * dt);
    vR -= lat;
    this.skid = Math.abs(vR) > 3 || (c.handbrake && Math.abs(vF) > 6) ? Math.min(1, Math.abs(vR) / 8 + 0.3) : 0;
    if (c.handbrake) vF -= Math.sign(vF) * Math.min(Math.abs(vF), 5 * dt);

    // steering (bicycle model)
    this.steer += (c.steer - this.steer) * Math.min(1, dt * 10);
    const maxSteer = 0.62 / (1 + Math.abs(vF) / 16);
    const wheelbase = s.length * 0.62;
    const targetAv = (vF * Math.tan(this.steer * maxSteer)) / wheelbase * (c.handbrake ? 1.35 : 1);
    this.av += (targetAv - this.av) * Math.min(1, dt * 12);
    this.angle += this.av * dt;

    const nfx = Math.cos(this.angle), nfy = Math.sin(this.angle);
    this.vx = nfx * vF - nfy * vR;
    this.vy = nfy * vF + nfx * vR;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // walls
    let impact = 0;
    const r = s.width / 2;
    for (let i = 0; i < this.circles.length; i++) {
      const [cx, cy] = this.circleAt(i);
      const hit = world.collideCircle(cx, cy, r);
      if (!hit) continue;
      this.x += hit.nx * hit.depth;
      this.y += hit.ny * hit.depth;
      const vn = this.vx * hit.nx + this.vy * hit.ny;
      if (vn < 0) {
        this.vx -= hit.nx * vn * 1.25;
        this.vy -= hit.ny * vn * 1.25;
        impact = Math.max(impact, -vn);
        // spin a little when hitting with the nose or tail
        this.av += Math.sign(this.circles[i]) * (hit.nx * -Math.sin(this.angle) + hit.ny * Math.cos(this.angle)) * -vn * 0.08;
      }
    }
    if (impact > 5) this.damage((impact - 4) * 2.2);

    // water
    if (!this.sinking && world.inWater(this.x, this.y)) this.sinking = 0.001;
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

  /** Apply AI or player controls (clamped). */
  setControls(throttle: number, steer: number, handbrake = false) {
    this.ctrl.throttle = clamp(throttle, -1, 1);
    this.ctrl.steer = clamp(steer, -1, 1);
    this.ctrl.handbrake = handbrake;
  }

  /** Headlights, tail/brake lights, police flashers, fire. */
  emitLights(_L: LightLayer, _time: number, _atmos: Atmosphere) {
    // TODO(visual): implement
  }

  draw(ctx: CanvasRenderingContext2D, time: number, _atmos?: Atmosphere) {
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
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(ctx, -L / 2 + 0.25, -W / 2 + 0.35, L, W, 0.4);
    ctx.fill();

    const body = this.wrecked ? '#2a2623' : this.color;
    ctx.fillStyle = body;
    roundRect(ctx, -L / 2, -W / 2, L, W, s.kind === 'bus' ? 0.35 : 0.5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 0.08;
    ctx.stroke();

    const glass = this.wrecked ? '#111' : '#27343f';
    if (s.kind === 'bus') {
      ctx.fillStyle = this.wrecked ? '#222' : '#f2f2f2';
      ctx.fillRect(-L / 2 + 0.6, -W / 2 + 0.25, L - 1.2, W - 0.5);
      ctx.fillStyle = glass;
      ctx.fillRect(L / 2 - 0.55, -W / 2 + 0.2, 0.4, W - 0.4);
      ctx.fillStyle = this.wrecked ? '#333' : '#c9c9c9';
      for (let i = 0; i < 3; i++) ctx.fillRect(-L / 2 + 2 + i * 3.4, -0.5, 1.2, 1);
      ctx.fillStyle = body;
      ctx.fillRect(-L / 2 + 0.6, -0.12, L - 1.2, 0.24);
    } else if (s.kind === 'van') {
      ctx.fillStyle = glass;
      ctx.fillRect(L / 2 - 1.35, -W / 2 + 0.2, 0.55, W - 0.4);
      ctx.fillStyle = this.wrecked ? '#333' : '#f5f5f5';
      ctx.fillRect(-L / 2 + 0.25, -W / 2 + 0.2, L - 1.8, W - 0.4);
      if (!this.wrecked) {
        ctx.fillStyle = '#c8102e';
        ctx.font = '900 0.62px Arial Black, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('KOFOLKA', -0.65, 0.02);
      }
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
