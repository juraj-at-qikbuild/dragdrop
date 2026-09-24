import type { LightLayer } from '../world/Lighting';
import type { Game } from './Game';
import type { Ped, WeaponId } from '../entities/Ped';
import type { Vehicle } from '../entities/Vehicle';
import { dist, rand, pick } from '../util/math';

export const WEAPONS: Record<WeaponId, { name: string; dmg: number; cd: number; spread: number; range: number; pellets: number }> = {
  fist: { name: 'Päste', dmg: 34, cd: 0.45, spread: 0, range: 1.4, pellets: 1 },
  pistol: { name: 'Pištoľ', dmg: 55, cd: 0.3, spread: 0.035, range: 45, pellets: 1 },
  uzi: { name: 'Samopal', dmg: 28, cd: 0.085, spread: 0.08, range: 38, pellets: 1 },
  shotgun: { name: 'Brokovnica', dmg: 34, cd: 0.9, spread: 0.22, range: 22, pellets: 6 },
};

type PKind = 'smoke' | 'fire' | 'spark' | 'debris' | 'muzzle' | 'blood' | 'splash' | 'ring';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  grow: number;
  color: string;
  top: boolean;
  kind: PKind;
  rot?: number;
  vr?: number;
}

interface Decal {
  kind: 'blood' | 'scorch' | 'skid';
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  w?: number;
  size: number;
  age: number;
  shape?: number[]; // irregular blob radii offsets, precomputed
}

interface LightEvent {
  x: number;
  y: number;
  r: number;
  color: string;
  intensity: number;
  glow?: number;
  life: number;
}

interface Tracer {
  x: number;
  y: number;
  x2: number;
  y2: number;
  life: number;
}

export class Combat {
  /** the most recently constructed Combat, so other owned files (Vehicle) can push effects without a Game import */
  static active: Combat | null = null;
  particles: Particle[] = [];
  decals: Decal[] = [];
  tracers: Tracer[] = [];
  lightEvents: LightEvent[] = [];
  private lastSkid = new Map<Vehicle, [number, number, number, number]>();

  constructor(private game: Game) {
    Combat.active = this;
  }

  /** Fire a weapon from a ped. Returns true if a shot happened. */
  fire(shooter: Ped, angle: number, weapon: WeaponId) {
    const g = this.game;
    const w = WEAPONS[weapon];
    if (weapon === 'fist') {
      // melee: nearest ped in front
      for (const p of g.peds) {
        if (p === shooter || p.dead || p.vehicle || p.level !== shooter.level) continue;
        const d = dist(p.x, p.y, shooter.x, shooter.y);
        if (d > w.range + p.r) continue;
        const a = Math.atan2(p.y - shooter.y, p.x - shooter.x);
        if (Math.abs(Math.atan2(Math.sin(a - angle), Math.cos(a - angle))) > 0.9) continue;
        this.hurtPed(p, w.dmg, shooter);
        g.audio.punch();
        return true;
      }
      g.audio.whoosh();
      return true;
    }
    this.muzzleFlash(shooter.x + Math.cos(angle) * 0.55, shooter.y + Math.sin(angle) * 0.55, angle);
    for (let i = 0; i < w.pellets; i++) {
      const a = angle + rand(-w.spread, w.spread);
      const sx = shooter.x + Math.cos(angle) * 0.5, sy = shooter.y + Math.sin(angle) * 0.5;
      const ex = sx + Math.cos(a) * w.range, ey = sy + Math.sin(a) * w.range;
      let t = g.world.raycast(sx, sy, ex, ey);
      let hitPed: Ped | null = null;
      let hitCar: Vehicle | null = null;
      for (const p of g.peds) {
        if (p === shooter || p.dead || p.vehicle || p.level !== shooter.level) continue;
        const pt = rayCircle(sx, sy, ex, ey, p.x, p.y, p.r + 0.15);
        if (pt >= 0 && pt < t) (t = pt), (hitPed = p), (hitCar = null);
      }
      for (const v of g.vehicles) {
        if (v === shooter.vehicle || v.wrecked || v.level !== shooter.level) continue;
        if (dist(v.x, v.y, sx, sy) > w.range + v.radius) continue;
        for (let c = 0; c < v.circles.length; c++) {
          const [cx, cy] = v.circleAt(c);
          const vt = rayCircle(sx, sy, ex, ey, cx, cy, v.spec.width / 2);
          if (vt >= 0 && vt < t) (t = vt), (hitCar = v), (hitPed = null);
        }
      }
      const hx = sx + (ex - sx) * t, hy = sy + (ey - sy) * t;
      this.tracers.push({ x: sx, y: sy, x2: hx, y2: hy, life: 0.06 });
      if (hitPed) this.hurtPed(hitPed, w.dmg, shooter);
      else if (hitCar) {
        hitCar.damage(w.dmg * 0.35);
        this.spark(hx, hy);
        if (shooter === g.player && hitCar.kind === 'police') g.crime('shootCop');
        if (hitCar.driver && hitCar.driver !== g.player && !hitCar.isPlayer && Math.random() < 0.15) this.hurtPed(hitCar.driver, w.dmg, shooter);
        if (hitCar.isPlayer && shooter !== g.player) g.hurtPlayer(w.dmg * 0.12, shooter.x, shooter.y);
      } else if (t < 1) this.spark(hx, hy);
    }
    g.audio.shot(weapon, dist(shooter.x, shooter.y, g.player.x, g.player.y));
    if (shooter === g.player) {
      g.crime('shoot');
      for (const p of g.peds)
        if (p.kind === 'civ' && !p.dead && !p.vehicle && dist(p.x, p.y, shooter.x, shooter.y) < 35) this.scare(p, shooter.x, shooter.y);
    }
    return true;
  }

  hurtPed(p: Ped, dmg: number, by: Ped | null) {
    const g = this.game;
    if (p.dead) return;
    if (p === g.player) {
      g.hurtPlayer(dmg * 0.35, by?.x ?? p.x, by?.y ?? p.y);
      return;
    }
    p.health -= dmg;
    this.blood(p.x, p.y, 0.4);
    if (p.health <= 0) {
      p.kill(by?.x ?? p.x, by?.y ?? p.y, 3);
      this.blood(p.x, p.y, 1);
      if (by === g.player) {
        g.crime(p.kind === 'cop' ? 'killCop' : 'killPed');
        g.dropCash(p.x, p.y, p.money);
      }
      g.audio.scream();
    } else if (p.kind === 'civ' && by) this.scare(p, by.x, by.y);
    if (p.kind === 'cop' && by === g.player) g.crime('shootCop');
  }

  scare(p: Ped, fx: number, fy: number) {
    p.state = 'flee';
    p.timer = rand(4, 7);
    p.fleeFrom.x = fx;
    p.fleeFrom.y = fy;
  }

  explode(x: number, y: number, source: Vehicle | null) {
    const g = this.game;
    g.audio.explosion(dist(x, y, g.player.x, g.player.y));
    g.shake = Math.max(g.shake, 1.2);
    this.decals.push({ kind: 'scorch', x, y, size: 4.5, age: 0, shape: blobShape() });
    // expanding shockwave ring
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.5, max: 0.5, size: 0.5, grow: 22, color: 'rgba(255,220,150,0.8)', top: true, kind: 'ring' });
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(2, 14);
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.4, 1), max: 1, size: rand(0.8, 2.2), grow: 2,
        color: pickFire(), top: true, kind: 'fire',
      });
    }
    for (let i = 0; i < 14; i++) this.debris(x, y);
    for (let i = 0; i < 18; i++) this.smoke(x + rand(-2, 2), y + rand(-2, 2), 2.5);
    this.lightEvents.push({ x, y, r: 26, color: '#ff8a2f', intensity: 1.6, glow: 30, life: 0.45 });
    for (const p of g.peds) {
      if (p.dead || p.vehicle) continue;
      const d = dist(p.x, p.y, x, y);
      if (d < 7) {
        if (p === g.player) g.hurtPlayer(90 * (1 - d / 7), x, y);
        else {
          p.kill(x, y, 10);
          if (source?.isPlayer || g.lastPlayerCar === source) g.crime('killPed');
        }
      } else if (d < 30 && p.kind === 'civ') this.scare(p, x, y);
    }
    for (const v of g.vehicles) {
      if (v === source || v.wrecked) continue;
      const d = dist(v.x, v.y, x, y);
      if (d < 8) {
        v.damage(90 * (1 - d / 8));
        const k = (1 - d / 8) * 10 / (v.spec.mass / 1200);
        v.vx += ((v.x - x) / (d || 1)) * k;
        v.vy += ((v.y - y) / (d || 1)) * k;
      }
    }
  }

  blood(x: number, y: number, size: number) {
    this.decals.push({ kind: 'blood', x: x + rand(-0.3, 0.3), y: y + rand(-0.3, 0.3), size: size * rand(0.6, 1.2), age: 0, shape: blobShape() });
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(0.5, 3.5) * size;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.25, max: 0.25, size: rand(0.05, 0.12) * size, grow: 0, color: '#8a0000', top: false, kind: 'blood' });
    }
  }

  spark(x: number, y: number) {
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(3, 9);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.15, max: 0.15, size: 0.15, grow: 0, color: '#ffe082', top: false, kind: 'spark' });
    }
  }

  /** metal sparks from car-car collisions (call this from a collision handler if one exists elsewhere) */
  metalSpark(x: number, y: number) {
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(4, 12);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.12, 0.25), max: 0.25, size: 0.13, grow: 0, color: '#fff3c4', top: false, kind: 'spark' });
    }
  }

  smoke(x: number, y: number, size = 1) {
    this.particles.push({
      x, y, vx: rand(-0.5, 0.5) + 1.2, vy: rand(-0.5, 0.5) - 0.6, life: rand(1, 2), max: 2, size: 0.6 * size, grow: 1.2 * size,
      color: 'rgba(60,60,60,0.45)', top: true, kind: 'smoke',
    });
  }

  /** light grey tyre smoke, e.g. from a handbrake turn */
  tireSmoke(x: number, y: number) {
    this.particles.push({
      x: x + rand(-0.2, 0.2), y: y + rand(-0.2, 0.2), vx: rand(-0.4, 0.4), vy: rand(-0.4, 0.4), life: rand(0.5, 1), max: 1,
      size: rand(0.2, 0.4), grow: 0.7, color: 'rgba(210,210,210,0.35)', top: false, kind: 'smoke',
    });
  }

  flame(x: number, y: number) {
    this.particles.push({ x: x + rand(-0.6, 0.6), y: y + rand(-0.6, 0.6), vx: rand(-0.5, 0.5), vy: rand(-1.5, -0.3), life: 0.5, max: 0.5, size: rand(0.5, 1.1), grow: -0.5, color: pickFire(), top: true, kind: 'fire' });
  }

  debris(x: number, y: number) {
    const a = Math.random() * Math.PI * 2, s = rand(2, 9);
    this.particles.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.6, 1.3), max: 1.3, size: rand(0.1, 0.25), grow: 0,
      color: pick(['#2a2a2a', '#3a332c', '#1c1c1c']), top: true, kind: 'debris', rot: Math.random() * Math.PI * 2, vr: rand(-8, 8),
    });
  }

  /** star-shaped muzzle flash at a gun tip, 1-2 frames */
  muzzleFlash(x: number, y: number, angle: number) {
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.045, max: 0.045, size: 0.35, grow: 0, color: '#fff6c8', top: true, kind: 'muzzle', rot: angle });
    this.lightEvents.push({ x, y, r: 5, color: '#fff1c8', intensity: 1.2, glow: 2.2, life: 0.05 });
  }

  /** water impact splash, e.g. a car driving into the river */
  splash(x: number, y: number) {
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(1, 5);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1, life: rand(0.3, 0.6), max: 0.6, size: rand(0.1, 0.25), grow: 0.6, color: 'rgba(210,230,240,0.55)', top: true, kind: 'splash' });
    }
  }

  skid(v: Vehicle) {
    const c = Math.cos(v.angle), s = Math.sin(v.angle);
    const bx = v.x - c * v.spec.length * 0.35, by = v.y - s * v.spec.length * 0.35;
    const ox = -s * v.spec.width * 0.38, oy = c * v.spec.width * 0.38;
    const cur: [number, number, number, number] = [bx + ox, by + oy, bx - ox, by - oy];
    const last = this.lastSkid.get(v);
    if (last && dist(last[0], last[1], cur[0], cur[1]) < 3) {
      this.decals.push({ kind: 'skid', x: last[0], y: last[1], x2: cur[0], y2: cur[1], size: 0.28, age: 0 });
      this.decals.push({ kind: 'skid', x: last[2], y: last[3], x2: cur[2], y2: cur[3], size: 0.28, age: 0 });
    }
    this.lastSkid.set(v, cur);
  }

  noSkid(v: Vehicle) {
    this.lastSkid.delete(v);
  }

  update(dt: number) {
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - dt * 2;
      p.vy *= 1 - dt * 2;
      p.size = Math.max(0.02, p.size + p.grow * dt);
      if (p.vr) p.rot = (p.rot ?? 0) + p.vr * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    if (this.particles.length > PARTICLE_CAP) this.particles.splice(0, this.particles.length - PARTICLE_CAP);
    for (const t of this.tracers) t.life -= dt;
    this.tracers = this.tracers.filter((t) => t.life > 0);
    for (const d of this.decals) d.age += dt;
    this.decals = this.decals.filter((d) => d.age < (d.kind === 'skid' ? 25 : 60));
    if (this.decals.length > 1500) this.decals.splice(0, this.decals.length - 1500);
    for (const ev of this.lightEvents) ev.life -= dt;
    this.lightEvents = this.lightEvents.filter((ev) => ev.life > 0);
  }

  /** Muzzle flashes, fires and explosions. */
  emitLights(L: LightLayer) {
    for (const ev of this.lightEvents) {
      const k = Math.max(0, ev.life) / 0.45;
      L.point(ev.x, ev.y, ev.r, ev.color, ev.intensity * Math.min(1, k * 2));
      if (ev.glow) L.glow(ev.x, ev.y, ev.glow, ev.color, Math.min(1, k * 1.5));
    }
    for (const p of this.particles) {
      if (p.kind === 'fire') L.point(p.x, p.y, p.size * 2.2, '#ff7a1f', Math.min(1, (p.life / p.max) * 0.7));
    }
  }

  drawDecals(ctx: CanvasRenderingContext2D) {
    ctx.lineCap = 'round';
    for (const d of this.decals) {
      const fade = Math.min(1, (d.kind === 'skid' ? 25 : 60) - d.age);
      if (d.kind === 'skid') {
        ctx.strokeStyle = `rgba(15,15,15,${0.4 * fade})`;
        ctx.lineWidth = d.size;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x2!, d.y2!);
        ctx.stroke();
        ctx.strokeStyle = `rgba(15,15,15,${0.18 * fade})`;
        ctx.lineWidth = d.size * 2.4;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x2!, d.y2!);
        ctx.stroke();
      } else {
        ctx.fillStyle = d.kind === 'blood' ? `rgba(110,0,0,${0.68 * fade})` : `rgba(12,10,9,${0.58 * fade})`;
        drawBlob(ctx, d.x, d.y, d.size, d.shape);
      }
    }
  }

  drawParticles(ctx: CanvasRenderingContext2D, top: boolean) {
    // normal (non-additive) particles first
    for (const p of this.particles) {
      if (p.top !== top || p.kind === 'fire') continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, (p.life / p.max) * 1.5));
      if (p.kind === 'spark') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * 0.5;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
        ctx.stroke();
      } else if (p.kind === 'debris') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot ?? 0);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size, -p.size * 0.6, p.size * 2, p.size * 1.2);
        ctx.restore();
      } else if (p.kind === 'muzzle') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot ?? 0);
        ctx.fillStyle = p.color;
        for (let i = 0; i < 4; i++) {
          ctx.save();
          ctx.rotate((i * Math.PI) / 4 - Math.PI / 8);
          ctx.beginPath();
          ctx.moveTo(0, -0.06);
          ctx.lineTo(p.size, 0);
          ctx.lineTo(0, 0.06);
          ctx.fill();
          ctx.restore();
        }
        ctx.restore();
      } else if (p.kind === 'ring') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(0.05, 0.5 - p.size * 0.015);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // fire: additive glow, restored afterwards
    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      if (p.top !== top || p.kind !== 'fire') continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, (p.life / p.max) * 0.9));
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = prevOp;
    ctx.globalAlpha = 1;
    if (!top) return;
    ctx.strokeStyle = 'rgba(255,240,170,0.9)';
    ctx.lineWidth = 0.08;
    for (const t of this.tracers) {
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x2, t.y2);
      ctx.stroke();
    }
  }
}

const PARTICLE_CAP = 600;

function drawBlob(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, shape?: number[]) {
  const pts = shape ?? blobShape();
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const a = (i / pts.length) * Math.PI * 2;
    const r = size * pts[i];
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r * 0.85;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

/** deterministic-looking irregular blob radii offsets (0.7..1.15) */
function blobShape() {
  const n = 8;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(0.72 + Math.random() * 0.45);
  return out;
}

function pickFire() {
  return ['#ff6f00', '#ffa000', '#ffca28', '#e65100', '#ff3d00'][(Math.random() * 5) | 0];
}

/** ray AB vs circle, returns t in [0,1] of first hit or -1 */
function rayCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, r: number) {
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
