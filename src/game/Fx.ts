// Visual effects: particles, baked decals (skids, blood, scorch marks), tracers and light flashes.
// Client only. The simulation reports what happened through SimEvents (see ClientEvents), and
// EntityFx adds the per-frame vehicle effects (tyre smoke, exhaust, flames).
import type { LightLayer } from '../world/Lighting';
import type { Vehicle } from '../shared/entities/Vehicle';
import { dist, rand, pick } from '../shared/util/math';

type PKind = 'smoke' | 'fire' | 'spark' | 'debris' | 'muzzle' | 'blood' | 'splash' | 'ring' | 'glass' | 'shell' | 'chunk';

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
  alphaMax: number;
  top: boolean;
  kind: PKind;
  rot?: number;
  vr?: number;
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

// -------------------------------------------------------------- decal chunks
// Skid/blood/scorch marks are baked once into small per-region offscreen
// canvases (4px/m) instead of being redrawn as vector shapes every frame.
// Chunks are lazily allocated and LRU-evicted, so decals persist cheaply
// without an unbounded per-frame draw list.
const CHUNK_M = 128;
const CHUNK_PX = 4; // px per metre
const CHUNK_CAP = 48;

interface DecalChunk {
  cx: number;
  cy: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  used: number;
}

class DecalBaker {
  private chunks = new Map<string, DecalChunk>();
  private clock = 0;

  private get(cx: number, cy: number): DecalChunk {
    const k = cx + ',' + cy;
    let c = this.chunks.get(k);
    if (!c) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = CHUNK_M * CHUNK_PX;
      const ctx = canvas.getContext('2d')!;
      ctx.translate(-cx * CHUNK_M * CHUNK_PX, -cy * CHUNK_M * CHUNK_PX);
      ctx.scale(CHUNK_PX, CHUNK_PX);
      ctx.translate(-cx * CHUNK_M, -cy * CHUNK_M);
      c = { cx, cy, canvas, ctx, used: this.clock };
      this.chunks.set(k, c);
      if (this.chunks.size > CHUNK_CAP) this.evictOldest();
    }
    c.used = ++this.clock;
    return c;
  }

  private evictOldest() {
    let oldestK = '', oldestT = Infinity;
    for (const [k, c] of this.chunks) if (c.used < oldestT) (oldestT = c.used), (oldestK = k);
    if (oldestK) this.chunks.delete(oldestK);
  }

  /** run `paint` against the local (world-unit) ctx of the chunk containing (x,y) */
  paint(x: number, y: number, paint: (ctx: CanvasRenderingContext2D) => void) {
    const c = this.get(Math.floor(x / CHUNK_M), Math.floor(y / CHUNK_M));
    paint(c.ctx);
  }

  draw(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
    const cx0 = Math.floor(x0 / CHUNK_M), cx1 = Math.floor(x1 / CHUNK_M);
    const cy0 = Math.floor(y0 / CHUNK_M), cy1 = Math.floor(y1 / CHUNK_M);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = this.chunks.get(cx + ',' + cy);
        if (!c) continue;
        c.used = ++this.clock;
        ctx.drawImage(c.canvas, cx * CHUNK_M, cy * CHUNK_M, CHUNK_M, CHUNK_M);
      }
  }
}

// ---------------------------------------------------------- cached soft sprites
// Smoke/fire/dust particles are drawn as pre-rendered radial-gradient sprites
// (drawImage) instead of arcs, for softer look with no per-frame gradient cost.
const spriteCache = new Map<string, HTMLCanvasElement>();
function softSprite(rgb: string): HTMLCanvasElement {
  let c = spriteCache.get(rgb);
  if (c) return c;
  const S = 64;
  c = document.createElement('canvas');
  c.width = c.height = S;
  const sctx = c.getContext('2d')!;
  const g = sctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, `rgba(${rgb},1)`);
  g.addColorStop(0.6, `rgba(${rgb},0.55)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  sctx.fillStyle = g;
  sctx.fillRect(0, 0, S, S);
  spriteCache.set(rgb, c);
  return c;
}

export class Fx {
  particles: Particle[] = [];
  tracers: Tracer[] = [];
  lightEvents: LightEvent[] = [];
  private lastSkid = new Map<Vehicle, [number, number, number, number]>();
  private decals = new DecalBaker();
  /** wrecked cars still smouldering: vehicle -> seconds left (~20s) */
  private burning = new Map<Vehicle, number>();

  /** muzzle flash, shell casing, tracers and wall/car sparks of one shot */
  shot(x: number, y: number, a: number, ends: number[], sparks: number) {
    this.muzzleFlash(x + Math.cos(a) * 0.05, y + Math.sin(a) * 0.05, a);
    this.shellCasing(x - Math.cos(a) * 0.7, y - Math.sin(a) * 0.7, a);
    for (let i = 0; i + 1 < ends.length; i += 2) {
      this.tracers.push({ x, y, x2: ends[i], y2: ends[i + 1], life: 0.06 });
      if (sparks & (1 << (i / 2))) this.spark(ends[i], ends[i + 1]);
    }
  }

  /** the fireball, shockwave, debris and scorch mark of an explosion; `source` keeps burning for ~20 s */
  explosion(x: number, y: number, color: string | null, source: Vehicle | null) {
    this.bakeScorch(x, y, 5.5);
    // expanding shockwave rings
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.55, max: 0.55, size: 0.5, grow: 26, color: 'rgba(255,220,150,0.85)', alphaMax: 1, top: true, kind: 'ring' });
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.35, max: 0.35, size: 0.2, grow: 36, color: 'rgba(255,255,255,0.7)', alphaMax: 1, top: true, kind: 'ring' });
    for (let i = 0; i < 44; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(2, 15);
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.4, 1), max: 1, size: rand(0.9, 2.4), grow: 2.4,
        color: pickFire(), alphaMax: 0.42, top: true, kind: 'fire',
      });
    }
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(4, 17);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.6, 1.4), max: 1.4, size: rand(0.06, 0.14), grow: -0.05, color: '#ffb74d', alphaMax: 1, top: true, kind: 'spark' });
    }
    const chunkColor = color ?? pick(['#2a2a2a', '#3a332c', '#1c1c1c']);
    for (let i = 0; i < 9; i++) this.chunk(x, y, chunkColor);
    for (let i = 0; i < 20; i++) this.smoke(x + rand(-2, 2), y + rand(-2, 2), rand(1.8, 3.2));
    this.lightEvents.push({ x, y, r: 26, color: '#ff8a2f', intensity: 1.6, glow: 30, life: 0.45 });
    if (source) this.burning.set(source, 20);
  }

  /** irregular, permanently baked scorch mark */
  private bakeScorch(x: number, y: number, size: number) {
    this.decals.paint(x, y, (ctx) => {
      ctx.fillStyle = 'rgba(10,9,8,0.62)';
      drawBlob(ctx, x, y, size, blobShape());
      ctx.fillStyle = 'rgba(10,9,8,0.35)';
      drawBlob(ctx, x, y, size * 1.6, blobShape());
    });
  }

  blood(x: number, y: number, size: number) {
    const bx = x + rand(-0.3, 0.3), by = y + rand(-0.3, 0.3);
    const s = size * rand(0.6, 1.2);
    this.decals.paint(bx, by, (ctx) => {
      ctx.fillStyle = 'rgba(110,0,0,0.6)';
      drawBlob(ctx, bx, by, s, blobShape());
    });
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2, sp = rand(0.5, 3.5) * size;
      this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.25, max: 0.25, size: rand(0.05, 0.12) * size, grow: 0, color: '#8a0000', alphaMax: 1, top: false, kind: 'blood' });
    }
  }

  spark(x: number, y: number) {
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(3, 9);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.15, max: 0.15, size: 0.15, grow: 0, color: '#ffe082', alphaMax: 1, top: false, kind: 'spark' });
    }
  }

  /** metal sparks from car-car collisions (call this from a collision handler if one exists elsewhere) */
  metalSpark(x: number, y: number) {
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(4, 12);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.12, 0.25), max: 0.25, size: 0.13, grow: 0, color: '#fff3c4', alphaMax: 1, top: false, kind: 'spark' });
    }
  }

  /** pale blue windscreen/window glass shards, e.g. from a hard car-car hit */
  glass(x: number, y: number) {
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(2, 7);
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.3, 0.6), max: 0.6, size: rand(0.06, 0.14), grow: 0,
        color: '#bfe6ff', alphaMax: 1, top: true, kind: 'glass', rot: Math.random() * Math.PI * 2, vr: rand(-12, 12),
      });
    }
  }

  /** brass shell casing ejected sideways from a gun */
  shellCasing(x: number, y: number, angle: number) {
    const side = angle + Math.PI / 2 * pick([-1, 1]) + rand(-0.25, 0.25);
    this.particles.push({
      x, y, vx: Math.cos(side) * rand(2, 4), vy: Math.sin(side) * rand(2, 4), life: rand(0.6, 1), max: 1, size: 0.055, grow: 0,
      color: '#c9a227', alphaMax: 1, top: false, kind: 'shell', rot: Math.random() * Math.PI * 2, vr: rand(-16, 16),
    });
  }

  smoke(x: number, y: number, size = 1, color = '90,90,90') {
    this.particles.push({
      x, y, vx: rand(-0.5, 0.5) + 1.2, vy: rand(-0.5, 0.5) - 0.6, life: rand(1, 2), max: 2, size: 0.6 * size, grow: 1.2 * size,
      color, alphaMax: 0.45, top: true, kind: 'smoke',
    });
  }

  /** light grey tyre smoke, e.g. from a handbrake turn */
  tireSmoke(x: number, y: number) {
    this.particles.push({
      x: x + rand(-0.2, 0.2), y: y + rand(-0.2, 0.2), vx: rand(-0.4, 0.4), vy: rand(-0.4, 0.4), life: rand(0.5, 1), max: 1,
      size: rand(0.2, 0.4), grow: 0.7, color: '205,205,205', alphaMax: 0.35, top: false, kind: 'smoke',
    });
  }

  /** dust kicked up driving offroad */
  dust(x: number, y: number) {
    this.particles.push({
      x: x + rand(-0.3, 0.3), y: y + rand(-0.3, 0.3), vx: rand(-0.6, 0.6), vy: rand(-0.6, 0.6), life: rand(0.4, 0.8), max: 0.8,
      size: rand(0.2, 0.4), grow: 0.9, color: '176,148,96', alphaMax: 0.4, top: false, kind: 'smoke',
    });
  }

  /** exhaust puff from an accelerating car (only worth spawning near the camera) */
  exhaustPuff(x: number, y: number, angle: number) {
    const a = angle + Math.PI;
    this.particles.push({
      x, y, vx: Math.cos(a) * rand(0.5, 1.2), vy: Math.sin(a) * rand(0.5, 1.2), life: rand(0.4, 0.7), max: 0.7,
      size: rand(0.12, 0.22), grow: 0.5, color: '120,120,120', alphaMax: 0.3, top: true, kind: 'smoke',
    });
  }

  flame(x: number, y: number) {
    this.particles.push({ x: x + rand(-0.6, 0.6), y: y + rand(-0.6, 0.6), vx: rand(-0.5, 0.5), vy: rand(-1.5, -0.3), life: 0.5, max: 0.5, size: rand(0.5, 1.1), grow: -0.5, color: pickFire(), alphaMax: 0.42, top: true, kind: 'fire' });
  }

  debris(x: number, y: number) {
    const a = Math.random() * Math.PI * 2, s = rand(2, 9);
    this.particles.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.6, 1.3), max: 1.3, size: rand(0.1, 0.25), grow: 0,
      color: pick(['#2a2a2a', '#3a332c', '#1c1c1c']), alphaMax: 1, top: true, kind: 'debris', rot: Math.random() * Math.PI * 2, vr: rand(-8, 8),
    });
  }

  /** rotating car-panel chunk thrown by an explosion; slides on friction and settles */
  chunk(x: number, y: number, color: string) {
    const a = Math.random() * Math.PI * 2, s = rand(5, 16);
    this.particles.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(1.3, 2.3), max: 2.3, size: rand(0.18, 0.42), grow: 0,
      color, alphaMax: 1, top: true, kind: 'chunk', rot: Math.random() * Math.PI * 2, vr: rand(-11, 11),
    });
  }

  /** star-shaped muzzle flash at a gun tip, 1-2 frames */
  muzzleFlash(x: number, y: number, angle: number) {
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.045, max: 0.045, size: 0.35, grow: 0, color: '#fff6c8', alphaMax: 1, top: true, kind: 'muzzle', rot: angle });
    this.lightEvents.push({ x, y, r: 5, color: '#fff1c8', intensity: 1.2, glow: 2.2, life: 0.05 });
  }

  /** water impact splash, e.g. a car driving into the river */
  splash(x: number, y: number) {
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(1, 5);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1, life: rand(0.3, 0.6), max: 0.6, size: rand(0.1, 0.25), grow: 0.6, color: 'rgba(210,230,240,0.55)', alphaMax: 1, top: true, kind: 'splash' });
    }
  }

  skid(v: Vehicle) {
    const c = Math.cos(v.angle), s = Math.sin(v.angle);
    const bx = v.x - c * v.spec.length * 0.35, by = v.y - s * v.spec.length * 0.35;
    const ox = -s * v.spec.width * 0.38, oy = c * v.spec.width * 0.38;
    const cur: [number, number, number, number] = [bx + ox, by + oy, bx - ox, by - oy];
    const last = this.lastSkid.get(v);
    if (last && dist(last[0], last[1], cur[0], cur[1]) < 3) {
      const fresh = 0.4 + Math.min(0.28, v.skid * 0.28); // harder skid = darker mark
      this.paintSkidSeg(last[0], last[1], cur[0], cur[1], fresh);
      this.paintSkidSeg(last[2], last[3], cur[2], cur[3], fresh);
    }
    this.lastSkid.set(v, cur);
  }

  private paintSkidSeg(x1: number, y1: number, x2: number, y2: number, alpha: number) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    this.decals.paint(mx, my, (ctx) => {
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(15,15,15,${alpha})`;
      ctx.lineWidth = 0.28;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    });
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
    for (const ev of this.lightEvents) ev.life -= dt;
    this.lightEvents = this.lightEvents.filter((ev) => ev.life > 0);
    // lingering wreck fire/smoke, tapering off over ~20s
    for (const [v, t] of this.burning) {
      const nt = t - dt;
      if (nt <= 0) {
        this.burning.delete(v);
        continue;
      }
      this.burning.set(v, nt);
      const k = nt > 14 ? 1 : nt / 14;
      if (Math.random() < dt * 3.5 * k) this.flame(v.x, v.y);
      if (Math.random() < dt * 2.2) this.smoke(v.x, v.y, rand(1, 2));
    }
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
    for (const v of this.burning.keys()) L.point(v.x, v.y, 6, '#ff7a1f', 0.5);
  }

  drawDecals(ctx: CanvasRenderingContext2D, v: { x0: number; y0: number; x1: number; y1: number }) {
    this.decals.draw(ctx, v.x0, v.y0, v.x1, v.y1);
  }

  drawParticles(ctx: CanvasRenderingContext2D, top: boolean) {
    // normal (non-additive) particles first
    for (const p of this.particles) {
      if (p.top !== top || p.kind === 'fire' || p.kind === 'smoke') continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, (p.life / p.max) * 1.5)) * p.alphaMax;
      if (p.kind === 'spark') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * 0.5;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
        ctx.stroke();
      } else if (p.kind === 'debris' || p.kind === 'chunk' || p.kind === 'glass' || p.kind === 'shell') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot ?? 0);
        ctx.fillStyle = p.color;
        const w = p.kind === 'shell' ? p.size * 0.5 : p.size;
        ctx.fillRect(-p.size, -w * 0.6, p.size * 2, w * 1.2);
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
    // soft sprites: smoke (normal blend) then fire (additive glow)
    for (const p of this.particles) {
      if (p.top !== top || p.kind !== 'smoke') continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.max)) * p.alphaMax;
      const spr = softSprite(p.color);
      const d = p.size * 4;
      ctx.drawImage(spr, p.x - d / 2, p.y - d / 2, d, d);
    }
    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      if (p.top !== top || p.kind !== 'fire') continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, (p.life / p.max) * 0.9)) * p.alphaMax;
      const spr = softSprite(fireRgb(p.color));
      const d = Math.min(p.size, 2.4) * 2.6;
      ctx.drawImage(spr, p.x - d / 2, p.y - d / 2, d, d);
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

const hexRgbCache = new Map<string, string>();
/** '#rrggbb' -> 'r,g,b' for building sprite cache keys/gradients */
function fireRgb(hex: string) {
  let v = hexRgbCache.get(hex);
  if (v) return v;
  const n = parseInt(hex.slice(1), 16);
  v = `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  hexRgbCache.set(hex, v);
  return v;
}
