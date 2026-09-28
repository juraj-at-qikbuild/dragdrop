// Visual effects: particles, baked decals (skids, confetti, scorch marks), wet marks that dry, jets
// and light flashes. Client only. The simulation reports what happened through SimEvents (see
// ClientEvents), and EntityFx adds the per-frame vehicle effects (tyre smoke, exhaust, flames).
// Nobody gets hurt (docs/plans/non-violent.md): the toys squirt water, blow bubbles and fire
// confetti, and a hit leaves someone wet, soapy or covered in paper. A car still blows up in a
// fireball, and whoever stood too close comes away sooty.
import type { LightLayer } from '../world/Lighting';
import type { Vehicle } from '../shared/entities/Vehicle';
import type { WeaponId } from '../shared/entities/Ped';
import type { Mess } from '../shared/sim/Combat';
import { dist, rand, pick } from '../shared/util/math';

type PKind = 'smoke' | 'fire' | 'spark' | 'debris' | 'splash' | 'ring' | 'glass' | 'chunk' | 'bubble' | 'confetti' | 'feather' | 'star';

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

/** a toy's jet, for a moment: water, or the faint trail a stream of bubbles leaves */
interface Tracer {
  x: number;
  y: number;
  x2: number;
  y2: number;
  life: number;
  max: number;
  color: string;
  width: number;
}

/** a wet or soapy mark on the ground that dries out */
interface WetMark {
  x: number;
  y: number;
  r: number;
  life: number;
  max: number;
  color: string;
  shape: number[];
}

/** bright paper colours for confetti */
const CONFETTI = ['#ff5252', '#ffeb3b', '#69f0ae', '#40c4ff', '#ff4081', '#b388ff', '#ffab40'];
/** wet marks kept at once (the oldest dries first) */
const WET_CAP = 90;

// -------------------------------------------------------------- decal chunks
// Skid marks, confetti and scorch marks are baked once into small per-region offscreen
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
  /** wet and soapy marks drying out */
  private wets: WetMark[] = [];
  /** wrecked cars still smouldering: vehicle -> seconds left (~20s) */
  private burning = new Map<Vehicle, number>();
  /** thrown toys in the air (sim/Toys.ts): seconds so far of `d` */
  private flying: Toss[] = [];
  /** soap bombs' slippery patches */
  private slicks: { x: number; y: number; r: number; t: number; max: number; shape: number[] }[] = [];

  /** One shot from a toy: a water jet, a stream of bubbles or a burst of confetti along each
   *  pellet's path, and where one ended on a wall or a car (bit set in `sparks`) a splash, a pop or
   *  paper fluttering down. `pour`: the helicopter's bucket instead. */
  shot(x: number, y: number, a: number, ends: number[], sparks: number, w: WeaponId = 'pistol', pour = false) {
    const ca = Math.cos(a), sa = Math.sin(a);
    if (pour) {
      // the helicopter tipping its water bucket: a thick pour and a big splash where it lands
      for (let i = 0; i + 1 < ends.length; i += 2) {
        this.tracers.push({ x, y, x2: ends[i], y2: ends[i + 1], life: 0.22, max: 0.22, color: 'rgba(150,210,255,0.75)', width: 0.4 });
        this.drops(ends[i], ends[i + 1], 10, 4);
        this.wet(ends[i], ends[i + 1], 0.8, 'rgba(40,70,110,0.32)', 14);
      }
      return;
    }
    this.nozzle(x + ca * 0.05, y + sa * 0.05, a, w);
    for (let i = 0; i + 1 < ends.length; i += 2) {
      const ex = ends[i], ey = ends[i + 1];
      const hit = !!(sparks & (1 << (i / 2)));
      if (w !== 'pistol' && w !== 'uzi' && w !== 'shotgun') this.shelfShot(w, x, y, a, ex, ey, hit);
      else if (w === 'uzi') {
        this.tracers.push({ x, y, x2: ex, y2: ey, life: 0.08, max: 0.08, color: 'rgba(230,200,255,0.45)', width: 0.05 });
        for (let k = 0; k < 3; k++) {
          const t = Math.random();
          this.bubble(x + (ex - x) * t, y + (ey - y) * t, ca * rand(0.5, 2), sa * rand(0.5, 2), rand(0.1, 0.22));
        }
        if (hit) this.pop(ex, ey);
      } else if (w === 'shotgun') {
        for (let k = 0; k < 4; k++) {
          const t = rand(0.15, 1);
          this.confetti(x + (ex - x) * t, y + (ey - y) * t, Math.cos(a) * rand(1, 5), Math.sin(a) * rand(1, 5));
        }
        if (hit) this.bakeConfetti(ex, ey, 0.5, 3);
      } else {
        this.tracers.push({ x, y, x2: ex, y2: ey, life: 0.12, max: 0.12, color: 'rgba(170,225,255,0.9)', width: 0.16 });
        for (let k = 0; k < 3; k++) {
          const t = rand(0.2, 1);
          this.drop(x + (ex - x) * t, y + (ey - y) * t, ca * rand(1, 4), sa * rand(1, 4));
        }
        this.drops(ex, ey, hit ? 6 : 3);
        if (hit) this.wet(ex, ey, 0.35, 'rgba(40,70,110,0.32)', 8);
      }
    }
  }

  /** what comes out of the toy's front: a spray of droplets, a bubble, a puff of paper */
  private nozzle(x: number, y: number, a: number, w: WeaponId) {
    if (w === 'hammer' || w === 'pea' || w === 'perfume' || w === 'blower' || w === 'foam') return;
    if (w === 'kofola') for (let i = 0; i < 3; i++) this.fizz(x, y, Math.cos(a + rand(-0.5, 0.5)) * rand(2, 5), Math.sin(a + rand(-0.5, 0.5)) * rand(2, 5));
    else if (w === 'uzi') this.bubble(x, y, Math.cos(a) * 1.5, Math.sin(a) * 1.5, 0.12);
    else if (w === 'shotgun') for (let i = 0; i < 6; i++) this.confetti(x, y, Math.cos(a + rand(-0.6, 0.6)) * rand(3, 8), Math.sin(a + rand(-0.6, 0.6)) * rand(3, 8));
    else for (let i = 0; i < 3; i++) this.drop(x, y, Math.cos(a + rand(-0.4, 0.4)) * rand(2, 5), Math.sin(a + rand(-0.4, 0.4)) * rand(2, 5));
  }

  /** a soap bubble drifting off (and up the screen a little), bursting at the end of its life */
  bubble(x: number, y: number, vx: number, vy: number, size: number) {
    this.particles.push({ x, y, vx, vy: vy - rand(0.2, 0.8), life: rand(0.6, 1.4), max: 1.4, size, grow: 0.05, color: pick(['#b3e5fc', '#f8bbd0', '#e1bee7', '#c8e6c9']), alphaMax: 0.9, top: true, kind: 'bubble' });
  }

  /** the wave a car's wheel throws out of a puddle toward `a` (the splash-by), `s` how hard (~0.4..1.2) */
  wave(x: number, y: number, a: number, s: number) {
    for (let i = 0; i < 12 + Math.round(s * 14); i++) {
      const b = a + rand(-0.55, 0.55), sp = rand(2, 7) * s;
      this.particles.push({ x: x + rand(-0.2, 0.2), y: y + rand(-0.2, 0.2), vx: Math.cos(b) * sp, vy: Math.sin(b) * sp - rand(0, 1.5), life: rand(0.35, 0.7), max: 0.7, size: rand(0.07, 0.16), grow: 0.25, color: 'rgba(200,230,250,0.8)', alphaMax: 1, top: true, kind: 'splash' });
    }
    this.particles.push({ x, y, vx: Math.cos(a) * 2, vy: Math.sin(a) * 2, life: 0.4, max: 0.4, size: 0.3, grow: 4, color: 'rgba(225,242,255,0.7)', alphaMax: 1, top: true, kind: 'ring' });
    this.wet(x + Math.cos(a) * 1.2, y + Math.sin(a) * 1.2, 0.9, 'rgba(40,70,110,0.28)', 12);
  }

  /** a bubble popping: a quick white ring */
  pop(x: number, y: number) {
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.18, max: 0.18, size: 0.08, grow: 1.6, color: 'rgba(255,255,255,0.9)', alphaMax: 1, top: true, kind: 'ring' });
  }

  /** a scrap of confetti, fluttering (rotating, slowing on the air) */
  confetti(x: number, y: number, vx: number, vy: number) {
    this.particles.push({ x, y, vx, vy, life: rand(0.8, 1.8), max: 1.8, size: rand(0.09, 0.15), grow: 0, color: pick(CONFETTI), alphaMax: 1, top: true, kind: 'confetti', rot: Math.random() * Math.PI * 2, vr: rand(-14, 14) });
  }

  /** a drop of water in flight */
  private drop(x: number, y: number, vx: number, vy: number) {
    this.particles.push({ x, y, vx, vy, life: rand(0.2, 0.45), max: 0.45, size: rand(0.05, 0.1), grow: 0, color: 'rgba(190,230,255,0.9)', alphaMax: 1, top: true, kind: 'splash' });
  }

  /** `n` drops thrown out from (x, y) */
  drops(x: number, y: number, n: number, speed = 3) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(0.5, speed);
      this.drop(x, y, Math.cos(a) * s, Math.sin(a) * s);
    }
  }

  /** a wet (or soapy) mark on the ground, drying out over `life` seconds */
  wet(x: number, y: number, r: number, color: string, life: number) {
    this.wets.push({ x: x + rand(-0.2, 0.2), y: y + rand(-0.2, 0.2), r: r * rand(0.8, 1.2), life, max: life, color, shape: blobShape() });
    if (this.wets.length > WET_CAP) this.wets.splice(0, this.wets.length - WET_CAP);
  }

  /** confetti left on the ground for good (well, until the street sweepers: the chunk's eviction) */
  bakeConfetti(x: number, y: number, spread: number, n: number) {
    this.decals.paint(x, y, (ctx) => {
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = pick(CONFETTI);
        ctx.save();
        ctx.translate(x + rand(-spread, spread), y + rand(-spread, spread));
        ctx.rotate(Math.random() * Math.PI);
        ctx.fillRect(-0.09, -0.05, 0.18, 0.1);
        ctx.restore();
      }
    });
  }

  /** Someone got hit by a toy, knocked down or splashed: what flies off them and what's left on the
   *  ground, by what it was (`mess`) and how big a hit (`size` ~0.3..1). Nothing red, and the wet
   *  marks dry. */
  soak(x: number, y: number, size: number, mess: Mess = 'water') {
    switch (mess) {
      case 'water':
        this.drops(x, y, 4 + Math.round(size * 8), 2 + size * 3);
        this.wet(x, y, 0.3 + size * 0.5, 'rgba(40,70,110,0.32)', 18 + size * 12);
        break;
      case 'bubbles':
        for (let i = 0; i < 3 + Math.round(size * 7); i++) this.bubble(x + rand(-0.3, 0.3), y + rand(-0.3, 0.3), rand(-0.8, 0.8), rand(-0.8, 0.3), rand(0.06, 0.16));
        this.wet(x, y, 0.25 + size * 0.45, 'rgba(255,255,255,0.4)', 12 + size * 10);
        break;
      case 'confetti':
        for (let i = 0; i < 4 + Math.round(size * 10); i++) this.confetti(x, y, rand(-3, 3), rand(-3, 3));
        this.bakeConfetti(x, y, 0.3 + size * 0.4, 2 + Math.round(size * 6));
        break;
      case 'soot':
        // a puff of soot off them, and a few embers
        for (let i = 0; i < 3 + Math.round(size * 5); i++) this.smoke(x + rand(-0.4, 0.4), y + rand(-0.4, 0.4), rand(0.4, 0.8) * (0.5 + size), '45,42,40');
        for (let i = 0; i < 2 + Math.round(size * 4); i++) {
          const a = Math.random() * Math.PI * 2, s = rand(1, 4);
          this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1, life: rand(0.3, 0.7), max: 0.7, size: 0.08, grow: 0, color: '#ffab40', alphaMax: 1, top: true, kind: 'spark' });
        }
        break;
      case 'bonk':
        for (let i = 0; i < 3; i++) this.dust(x, y);
        this.stars(x, y, 3);
        break;
      case 'kofola':
        for (let i = 0; i < 3 + Math.round(size * 6); i++) this.fizz(x, y, rand(-2, 2), rand(-2, 1));
        this.wet(x, y, 0.25 + size * 0.4, 'rgba(90,40,15,0.35)', 16 + size * 10);
        break;
      case 'perfume':
        for (let i = 0; i < 2 + Math.round(size * 3); i++) this.smoke(x + rand(-0.4, 0.4), y + rand(-0.4, 0.4), rand(0.4, 0.8), '255,170,215');
        break;
      case 'pea':
        this.pea(x, y, rand(-1.5, 1.5), rand(-2, -0.5));
        break;
      case 'leaves':
        this.leaves(x, y, 3 + Math.round(size * 6), 3);
        break;
      case 'foam':
        for (let i = 0; i < 2 + Math.round(size * 3); i++) this.smoke(x + rand(-0.3, 0.3), y + rand(-0.3, 0.3), rand(0.3, 0.6), '248,250,252');
        this.wet(x, y, 0.3 + size * 0.4, 'rgba(255,255,255,0.45)', 12 + size * 8);
        break;
      case 'egg':
        for (let i = 0; i < 5; i++) {
          const a = Math.random() * Math.PI * 2, sp = rand(0.5, 2.5);
          this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.3, 0.6), max: 0.6, size: rand(0.06, 0.11), grow: 0, color: pick(['#ffca28', '#fff8e1', '#ffe082']), alphaMax: 1, top: true, kind: 'splash' });
        }
        this.wet(x, y, 0.3 + size * 0.3, 'rgba(255,202,40,0.4)', 20);
        break;
      case 'pigeon':
        this.feathers(x, y, 3);
        this.wet(x, y, 0.2 + size * 0.2, 'rgba(245,245,240,0.6)', 20);
        break;
      default: // 'tickle': a flurry of little stars
        this.stars(x, y, 2 + Math.round(size * 3));
    }
  }

  /** little golden stars, as when someone sees stars (a bonk) or giggles (a tickle) */
  stars(x: number, y: number, n: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(0.6, 2);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.8, life: rand(0.5, 0.9), max: 0.9, size: rand(0.07, 0.12), grow: 0, color: '#ffe082', alphaMax: 1, top: true, kind: 'star', rot: Math.random() * Math.PI, vr: rand(-6, 6) });
    }
  }

  /** a drop of fizzing Kofola */
  private fizz(x: number, y: number, vx: number, vy: number) {
    this.particles.push({ x, y, vx, vy, life: rand(0.25, 0.5), max: 0.5, size: rand(0.05, 0.1), grow: 0, color: pick(['rgba(92,38,12,0.9)', 'rgba(140,70,30,0.85)', 'rgba(230,200,160,0.8)']), alphaMax: 1, top: true, kind: 'splash' });
  }

  /** a pea bouncing off */
  private pea(x: number, y: number, vx: number, vy: number) {
    this.particles.push({ x, y, vx, vy, life: 0.7, max: 0.7, size: 0.07, grow: 0, color: '#7cb342', alphaMax: 1, top: true, kind: 'splash' });
  }

  /** leaves swirling off (the blower), rocking like feathers */
  leaves(x: number, y: number, n: number, speed: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(0.5, speed);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.8, 1.6), max: 1.6, size: rand(0.1, 0.16), grow: 0, color: pick(['#8d6e2f', '#c0862b', '#a1887f', '#7c8b2a', '#d4a02b']), alphaMax: 1, top: true, kind: 'feather', rot: Math.random() * Math.PI * 2, vr: rand(-8, 8) });
    }
  }

  /** the second shelf's squirts and swings (Combat.ts WEAPONS): a squeak and stars, a jet of Kofola,
   *  a cloud of perfume, a pea's flight, a gust with leaves in it, a jet of foam */
  private shelfShot(w: WeaponId, x: number, y: number, a: number, ex: number, ey: number, hit: boolean) {
    const ca = Math.cos(a), sa = Math.sin(a);
    switch (w) {
      case 'hammer':
        // a squeak where the swing lands
        this.particles.push({ x: ex, y: ey, vx: 0, vy: 0, life: 0.16, max: 0.16, size: 0.15, grow: 3, color: 'rgba(255,82,82,0.8)', alphaMax: 1, top: true, kind: 'ring' });
        if (hit) this.stars(ex, ey, 2);
        break;
      case 'kofola':
        this.tracers.push({ x, y, x2: ex, y2: ey, life: 0.1, max: 0.1, color: 'rgba(110,50,20,0.8)', width: 0.12 });
        for (let k = 0; k < 2; k++) {
          const t = rand(0.3, 1);
          this.fizz(x + (ex - x) * t, y + (ey - y) * t, ca * rand(0.5, 2), sa * rand(0.5, 2));
        }
        if (hit) this.wet(ex, ey, 0.3, 'rgba(90,40,15,0.3)', 10);
        break;
      case 'perfume':
        for (let k = 0; k < 2; k++) {
          const t = rand(0.2, 1);
          this.particles.push({ x: x + (ex - x) * t, y: y + (ey - y) * t, vx: ca * rand(0.5, 1.5), vy: sa * rand(0.5, 1.5), life: rand(0.6, 1.1), max: 1.1, size: rand(0.25, 0.45), grow: 0.6, color: '255,170,215', alphaMax: 0.45, top: true, kind: 'smoke' });
        }
        break;
      case 'pea':
        this.tracers.push({ x, y, x2: ex, y2: ey, life: 0.06, max: 0.06, color: 'rgba(124,179,66,0.5)', width: 0.04 });
        this.pea(ex, ey, -ca * rand(0.5, 1.5), -sa * rand(0.5, 1.5));
        break;
      case 'blower':
        this.tracers.push({ x, y, x2: ex, y2: ey, life: 0.07, max: 0.07, color: 'rgba(230,240,230,0.25)', width: 0.35 });
        if (Math.random() < 0.5) {
          const t = rand(0.2, 1);
          this.leaves(x + (ex - x) * t, y + (ey - y) * t, 1, 1);
        }
        break;
      case 'foam':
        this.tracers.push({ x, y, x2: ex, y2: ey, life: 0.12, max: 0.12, color: 'rgba(250,250,255,0.85)', width: 0.22 });
        this.particles.push({ x: ex, y: ey, vx: rand(-0.4, 0.4), vy: rand(-0.4, 0.4), life: rand(0.8, 1.4), max: 1.4, size: rand(0.25, 0.4), grow: 0.3, color: '248,250,252', alphaMax: 0.85, top: true, kind: 'smoke' });
        if (hit) this.wet(ex, ey, 0.35, 'rgba(255,255,255,0.4)', 10);
        break;
    }
  }

  /** a thrown toy's flight (sim/Toys.ts), from (x, y) to (tx, ty) in `d` s */
  toss(w: WeaponId, x: number, y: number, tx: number, ty: number, d: number) {
    this.flying.push({ w, x, y, tx, ty, t: 0, d: Math.max(0.1, d) });
  }

  /** where a thrown toy came down: soap bubbling up, egg yolk, a clank, a bucket's splash, a pigeon */
  landed(w: WeaponId, x: number, y: number, hit: boolean) {
    switch (w) {
      case 'soap':
        for (let i = 0; i < 14; i++) this.bubble(x + rand(-1, 1), y + rand(-1, 1), rand(-1.5, 1.5), rand(-1.5, 1), rand(0.08, 0.2));
        break;
      case 'egg':
        this.soak(x, y, 0.6, 'egg');
        break;
      case 'clamp':
        this.metalSpark(x, y);
        if (!hit) this.dust(x, y);
        break;
      case 'bucket':
        this.drops(x, y, 26, 6);
        this.particles.push({ x, y, vx: 0, vy: 0, life: 0.45, max: 0.45, size: 0.4, grow: 7, color: 'rgba(225,242,255,0.8)', alphaMax: 1, top: true, kind: 'ring' });
        this.wet(x, y, 2.4, 'rgba(40,70,110,0.32)', 22);
        break;
      case 'pigeon':
        this.feathers(x, y, 6);
        if (hit) this.soak(x, y, 0.6, 'pigeon');
        break;
    }
  }

  /** a soap bomb's slippery patch, for `t` s */
  slick(x: number, y: number, r: number, t: number) {
    this.slicks.push({ x, y, r, t, max: t, shape: blobShape() });
  }

  /** foam over a car whose fire it put out */
  foamPuff(x: number, y: number) {
    for (let i = 0; i < 10; i++) this.particles.push({ x: x + rand(-1.5, 1.5), y: y + rand(-1, 1), vx: rand(-0.5, 0.5), vy: rand(-0.5, 0.5), life: rand(1, 2), max: 2, size: rand(0.4, 0.8), grow: 0.3, color: '248,250,252', alphaMax: 0.9, top: true, kind: 'smoke' });
    this.wet(x, y, 2, 'rgba(255,255,255,0.45)', 16);
  }

  /** a market stall's goods flung the way the car went (MOJE LOKŠE!): lokše, langoše, sausages,
   *  cups of punč */
  food(x: number, y: number, kind: 'lokse' | 'langos' | 'klobasa' | 'punc', dir: number) {
    const color = kind === 'lokse' ? ['#f3e3c3', '#e8d2a6'] : kind === 'langos' ? ['#f0c35a', '#e2a83f'] : kind === 'klobasa' ? ['#a1452f', '#8a3a26'] : ['#fafafa', '#c2185b'];
    for (let i = 0; i < 14; i++) {
      const a = dir + rand(-0.9, 0.9), sp = rand(3, 11);
      this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.8, 1.6), max: 1.6, size: rand(0.1, 0.18), grow: 0, color: pick(color), alphaMax: 1, top: true, kind: 'chunk', rot: Math.random() * Math.PI * 2, vr: rand(-10, 10) });
    }
  }

  /** feathers, from a flock of pigeons taking off (FRRR!) */
  feathers(x: number, y: number, n: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(0.3, 1.6);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(1, 2.2), max: 2.2, size: rand(0.06, 0.1), grow: 0, color: pick(['#eceff1', '#b0bec5', '#cfd8dc']), alphaMax: 1, top: true, kind: 'feather', rot: Math.random() * Math.PI * 2, vr: rand(-4, 4) });
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

  flame(x: number, y: number) {
    this.particles.push({ x: x + rand(-0.6, 0.6), y: y + rand(-0.6, 0.6), vx: rand(-0.5, 0.5), vy: rand(-1.5, -0.3), life: 0.5, max: 0.5, size: rand(0.5, 1.1), grow: -0.5, color: pickFire(), alphaMax: 0.42, top: true, kind: 'fire' });
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

  /** a knocked-over fire hydrant gushing: call every frame while it runs */
  geyser(x: number, y: number) {
    for (let i = 0; i < 2; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(0.5, 3);
      this.particles.push({ x: x + rand(-0.15, 0.15), y: y + rand(-0.15, 0.15), vx: Math.cos(a) * s, vy: Math.sin(a) * s - 2, life: rand(0.4, 0.9), max: 0.9, size: rand(0.12, 0.3), grow: 0.8, color: 'rgba(200,225,240,0.6)', alphaMax: 1, top: true, kind: 'splash' });
    }
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
    if (this.flying.length) {
      for (const f of this.flying) f.t += dt;
      this.flying = this.flying.filter((f) => f.t < f.d);
    }
    if (this.slicks.length) {
      for (const s of this.slicks) {
        s.t -= dt;
        if (Math.random() < dt * s.r * 0.6) this.bubble(s.x + rand(-s.r, s.r) * 0.7, s.y + rand(-s.r, s.r) * 0.7, rand(-0.2, 0.2), rand(-0.3, 0), rand(0.06, 0.14));
      }
      this.slicks = this.slicks.filter((s) => s.t > 0);
    }
    for (const w of this.wets) w.life -= dt;
    if (this.wets.length && this.wets[0].life <= 0) this.wets = this.wets.filter((w) => w.life > 0);
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

  /** Fires and explosions. */
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

  /** the baked marks (skids, confetti), then the wet ones, fading as they dry */
  drawDecals(ctx: CanvasRenderingContext2D, v: { x0: number; y0: number; x1: number; y1: number }) {
    this.decals.draw(ctx, v.x0, v.y0, v.x1, v.y1);
    for (const s of this.slicks) {
      if (s.x < v.x0 - s.r || s.x > v.x1 + s.r || s.y < v.y0 - s.r || s.y > v.y1 + s.r) continue;
      const k = Math.max(0, Math.min(1, s.t / 2, (s.max - s.t) * 4));
      ctx.globalAlpha = 0.55 * k;
      ctx.fillStyle = 'rgba(236,230,255,0.9)';
      drawBlob(ctx, s.x, s.y, s.r, s.shape);
      ctx.globalAlpha = 0.35 * k;
      ctx.fillStyle = 'rgba(255,190,230,0.9)';
      drawBlob(ctx, s.x + 0.3, s.y - 0.2, s.r * 0.6, s.shape);
    }
    for (const w of this.wets) {
      if (w.x < v.x0 - w.r || w.x > v.x1 + w.r || w.y < v.y0 - w.r || w.y > v.y1 + w.r) continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, (w.life / w.max) * 2.5));
      ctx.fillStyle = w.color;
      drawBlob(ctx, w.x, w.y, w.r, w.shape);
    }
    ctx.globalAlpha = 1;
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
      } else if (p.kind === 'debris' || p.kind === 'chunk' || p.kind === 'glass') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot ?? 0);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size, -p.size * 0.6, p.size * 2, p.size * 1.2);
        ctx.restore();
      } else if (p.kind === 'confetti' || p.kind === 'feather') {
        // paper spinning in the air (its width follows the spin), a feather rocking
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot ?? 0);
        ctx.fillStyle = p.color;
        if (p.kind === 'confetti') {
          const w = Math.max(0.2, Math.abs(Math.cos((p.rot ?? 0) * 1.7)));
          ctx.fillRect(-p.size * w, -p.size * 0.6, p.size * 2 * w, p.size * 1.2);
        } else {
          ctx.beginPath();
          ctx.ellipse(0, 0, p.size * 1.6, p.size * 0.5, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      } else if (p.kind === 'bubble') {
        // a soap bubble: a thin tinted rim and a highlight; it pops (a quick grow) as it goes
        const k = p.life / p.max;
        const r = p.size * (k < 0.08 ? 1 + (0.08 - k) * 8 : 1);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(0.012, r * 0.14);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.arc(p.x - r * 0.35, p.y - r * 0.35, r * 0.22, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'star') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot ?? 0);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = (i * Math.PI) / 5, r = i % 2 ? p.size * 0.45 : p.size;
          ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fill();
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
    // soft sprites: smoke and suds (normal blend) then fire (additive glow)
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
    for (const f of this.flying) drawToss(ctx, f);
    // the toys' jets: water, and a stream of bubbles' faint trail
    ctx.lineCap = 'round';
    for (const t of this.tracers) {
      ctx.globalAlpha = Math.max(0, Math.min(1, (t.life / t.max) * 1.6));
      ctx.strokeStyle = t.color;
      ctx.lineWidth = t.width;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x2, t.y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}


const PARTICLE_CAP = 600;

/** a thrown toy in the air (sim/Toys.ts) */
interface Toss {
  w: WeaponId;
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** seconds so far of `d` */
  t: number;
  d: number;
}

/** A thrown toy in the air: an arc (its height drawn as a lift up the screen, over a shadow that stays
 *  on the ground), but the pigeon, which flies straight and flaps. */
function drawToss(ctx: CanvasRenderingContext2D, f: Toss) {
  const k = f.t / f.d;
  const x = f.x + (f.tx - f.x) * k, y = f.y + (f.ty - f.y) * k;
  const len = Math.hypot(f.tx - f.x, f.ty - f.y);
  const h = f.w === 'pigeon' ? 1.2 : Math.min(4, 0.8 + len * 0.18) * 4 * k * (1 - k);
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(x, y, 0.3, 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.translate(x, y - h);
  const spin = f.t * 9;
  switch (f.w) {
    case 'soap':
      ctx.fillStyle = '#f8bbd0';
      ctx.beginPath();
      ctx.arc(0, 0, 0.26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      ctx.arc(-0.08, -0.08, 0.08, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'egg':
      ctx.rotate(spin);
      ctx.fillStyle = '#fff8e1';
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.17, 0.23, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'clamp':
      ctx.rotate(spin);
      ctx.strokeStyle = '#fdd835';
      ctx.lineWidth = 0.14;
      ctx.beginPath();
      ctx.arc(0, 0, 0.28, 0.4, Math.PI * 2 - 0.4);
      ctx.stroke();
      break;
    case 'bucket':
      ctx.rotate(Math.sin(spin * 0.5) * 0.5);
      ctx.fillStyle = '#42a5f5';
      ctx.fillRect(-0.25, -0.22, 0.5, 0.44);
      ctx.fillStyle = 'rgba(190,230,255,0.9)';
      ctx.fillRect(-0.22, -0.22, 0.44, 0.1);
      break;
    case 'pigeon': {
      ctx.rotate(Math.atan2(f.ty - f.y, f.tx - f.x));
      const flap = Math.sin(f.t * 30);
      ctx.fillStyle = '#b0bec5';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(-0.02, s * (0.2 + flap * 0.08), 0.14, 0.24 + flap * 0.06, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#90a4ae';
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.3, 0.13, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#546e7a';
      ctx.beginPath();
      ctx.arc(0.28, 0, 0.08, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}

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
