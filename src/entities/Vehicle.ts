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
    if (this.skid > 0.4 && Math.random() < dt * 5) {
      const bx = this.x - Math.cos(this.angle) * s.length * 0.4, by = this.y - Math.sin(this.angle) * s.length * 0.4;
      Combat.active?.tireSmoke(bx, by);
    }

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

  /** Apply AI or player controls (clamped). */
  setControls(throttle: number, steer: number, handbrake = false) {
    this.ctrl.throttle = clamp(throttle, -1, 1);
    this.ctrl.steer = clamp(steer, -1, 1);
    this.ctrl.handbrake = handbrake;
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

    const dmg = ((this as any).dmg ?? { front: 0, rear: 0, left: 0, right: 0 }) as { front: number; rear: number; left: number; right: number };
    const k = Math.max(atmos.night, atmos.rain * 0.5);
    if (k > 0.02 && dmg.front <= 0.7) {
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

    const dmg = ((this as any).dmg ?? { front: 0, rear: 0, left: 0, right: 0 }) as { front: number; rear: number; left: number; right: number };
    const body = this.wrecked ? '#2a2623' : this.color;
    ctx.save();
    roundRect(ctx, -L / 2, -W / 2, L, W, s.kind === 'bus' ? 0.35 : 0.5);
    ctx.clip();
    ctx.fillStyle = this.wrecked ? body : bodyGradient(ctx, body);
    ctx.fillRect(-L / 2 - 0.1, -W / 2 - 0.1, L + 0.2, W + 0.2);
    // panel lines: hood/trunk seams and a door crease
    if (!this.wrecked && s.kind !== 'bus') {
      ctx.strokeStyle = shade(body, -0.32);
      ctx.lineWidth = 0.03;
      ctx.beginPath();
      ctx.moveTo(L * 0.06, -W / 2 + 0.08);
      ctx.lineTo(L * 0.06, W / 2 - 0.08);
      ctx.stroke();
    }
    // sun-dependent specular sweep: a soft diagonal highlight band across the paint
    if (!this.wrecked && atmos) {
      const ca = Math.cos(this.angle), sa = Math.sin(this.angle);
      const lx = -atmos.sun.dx * ca - atmos.sun.dy * sa; // light dir in car-local x
      const t = Math.max(-1, Math.min(1, lx)) * L * 0.3;
      const g = ctx.createLinearGradient(t - L * 0.22, -W / 2, t + L * 0.22, W / 2);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, `rgba(255,255,255,${0.22 + 0.16 * (atmos.daylight ?? 0.6)})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-L / 2 - 0.1, -W / 2 - 0.1, L + 0.2, W + 0.2);
    }
    // per-side damage: crumpled dents + a scorch tint at the hit end
    for (const side of ['front', 'rear', 'left', 'right'] as const) {
      const v = dmg[side];
      if (!v) continue;
      ctx.save();
      let cx = 0, cy = 0, w = 0, h = 0;
      if (side === 'front') { cx = L / 2 - 0.3; cy = 0; w = 0.7; h = W - 0.2; }
      else if (side === 'rear') { cx = -L / 2 + 0.3; cy = 0; w = 0.7; h = W - 0.2; }
      else if (side === 'left') { cx = 0; cy = -W / 2 + 0.15; w = L - 0.4; h = 0.5; }
      else { cx = 0; cy = W / 2 - 0.15; w = L - 0.4; h = 0.5; }
      ctx.globalAlpha = Math.min(0.8, v);
      ctx.fillStyle = shade(body, -0.4);
      roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 0.15);
      ctx.fill();
      ctx.fillStyle = 'rgba(30,15,10,0.35)';
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      ctx.restore();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 0.08;
    roundRect(ctx, -L / 2, -W / 2, L, W, s.kind === 'bus' ? 0.35 : 0.5);
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
      // windscreen with a soft reflection gradient
      const wsGrad = ctx.createLinearGradient(L * 0.2, -W / 2, L * 0.36, W / 2);
      wsGrad.addColorStop(0, shade(glass, 0.22));
      wsGrad.addColorStop(0.5, glass);
      wsGrad.addColorStop(1, shade(glass, -0.15));
      ctx.fillStyle = this.wrecked ? glass : wsGrad;
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
      if (dmg.front > 0.35 && !this.wrecked) {
        // cracked glass: a small spiderweb where the impact hit
        ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.7, dmg.front)})`;
        ctx.lineWidth = 0.02;
        const cx = L * 0.27, cy = 0;
        ctx.beginPath();
        for (let a = 0; a < 6; a++) {
          const ang = (a / 6) * Math.PI * 2;
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(ang) * 0.16, cy + Math.sin(ang) * 0.12);
        }
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
    // lights (dead/dark if that end took heavy damage)
    if (!this.wrecked) {
      ctx.fillStyle = dmg.front > 0.7 ? '#3a352c' : '#fff6c4';
      ctx.fillRect(L / 2 - 0.16, -W / 2 + 0.12, 0.14, 0.38);
      ctx.fillRect(L / 2 - 0.16, W / 2 - 0.5, 0.14, 0.38);
      const braking = this.ctrl.throttle < 0 && this.fwdSpeed > 0.5;
      ctx.fillStyle = dmg.rear > 0.7 ? '#3a2c2c' : braking ? '#ff1f1f' : '#9b1111';
      ctx.fillRect(-L / 2 + 0.02, -W / 2 + 0.12, 0.14, 0.34);
      ctx.fillRect(-L / 2 + 0.02, W / 2 - 0.46, 0.14, 0.34);
      // missing bumper on a badly-hit end
      if (dmg.front > 0.7) { ctx.fillStyle = '#15130f'; ctx.fillRect(L / 2 - 0.1, -W / 2 + 0.35, 0.25, W - 0.7); }
      if (dmg.rear > 0.7) { ctx.fillStyle = '#15130f'; ctx.fillRect(-L / 2 - 0.1, -W / 2 + 0.35, 0.25, W - 0.7); }
    }
    // exhaust flame when boosting
    if ((this as any).boosting && !this.wrecked) {
      const flick = 0.7 + Math.random() * 0.3;
      const fx0 = -L / 2 - 0.05;
      const g = ctx.createLinearGradient(fx0, 0, fx0 - 0.9 * flick, 0);
      g.addColorStop(0, `rgba(255,220,120,${0.9 * flick})`);
      g.addColorStop(0.5, `rgba(255,120,30,${0.7 * flick})`);
      g.addColorStop(1, 'rgba(255,60,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(fx0, -0.16);
      ctx.lineTo(fx0 - 0.9 * flick, 0);
      ctx.lineTo(fx0, 0.16);
      ctx.closePath();
      ctx.fill();
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
