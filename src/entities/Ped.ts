import type { Atmosphere } from '../world/Atmosphere';
import type { World } from '../world/World';
import type { Link } from '../world/Graph';
import type { Vehicle } from './Vehicle';
import { pick } from '../util/math';
import { shade } from './Vehicle';
import { SpriteCache } from '../render/SpriteCache';

export type PedKind = 'player' | 'civ' | 'cop';
export type PedState = 'walk' | 'flee' | 'dead' | 'chase' | 'idle';
export type Archetype = 'player' | 'cop' | 'suit' | 'tourist' | 'jogger' | 'elderly' | 'student' | 'worker' | 'casual' | 'dress';
export type HairStyle = 'short' | 'long' | 'bun' | 'bald' | 'cap' | 'hat' | 'scarf' | 'helmet';

const SHIRTS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#f4511e', '#00897b', '#6d4c41', '#eceff1', '#212121', '#3949ab', '#c2185b'];
const HAIR = ['#2b1d14', '#4a3222', '#8d6e63', '#d7b377', '#1a1a1a', '#9e9e9e', '#b5651d'];
const SKIN = ['#f1c9a5', '#e0ac85', '#c68863', '#8d5a3b', '#f5d6ba'];
const GREY_HAIR = ['#c9c9c9', '#dcdcdc', '#a9a29b'];
const PANTS = ['#263238', '#37474f', '#2b3a67', '#4e342e', '#455a64', '#212121', '#5d4037'];
const BRIGHT = ['#00bcd4', '#ff4081', '#ffca28', '#7cb342', '#ff7043', '#ab47bc'];
const DRESS = ['#c2185b', '#8e24aa', '#d81b60', '#00897b', '#f4511e', '#3949ab', '#e53935'];

/** weighted archetype pool for civilians */
const ARCHETYPES: Archetype[] = ['casual', 'casual', 'casual', 'dress', 'dress', 'suit', 'tourist', 'jogger', 'elderly', 'student', 'worker'];
const HAIRSTYLES: HairStyle[] = ['short', 'short', 'long', 'bun', 'bald', 'cap'];

export type WeaponId = 'fist' | 'pistol' | 'uzi' | 'shotgun';

let nextId = 1;
function hashRand(seed: number, salt: number) {
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export class Ped {
  id = nextId++;
  x: number;
  y: number;
  angle = 0;
  vx = 0;
  vy = 0;
  r = 0.34;
  health = 100;
  armor = 0;
  kind: PedKind;
  state: PedState = 'walk';
  shirt: string;
  pants: string;
  hair: string = pick(HAIR);
  skin: string;
  hairStyle: HairStyle = 'short';
  archetype: Archetype = 'casual';
  /** mutable appearance tag; other systems may set e.g. 'swat' on a cop */
  outfit = 'casual';
  build = 1;
  walkPhase = Math.random() * 10;
  vehicle: Vehicle | null = null;
  /** bridge deck level: 0 ground/underneath, 1 on the deck (see World.updateLevel) */
  level: 0 | 1 = 0;
  weapon: WeaponId = 'fist';
  cooldown = 0;
  timer = 0;
  fleeFrom = { x: 0, y: 0 };
  deadTime = 0;
  /** true while surrendering / being arrested-at-gunpoint */
  handsUp = false;
  /** seconds remaining of a white hit-flash; decayed in draw() */
  hitFlash = 0;
  private lastDrawMs = 0;
  // navigation on the pedestrian graph
  link: Link | null = null;
  pts: number[] = [];
  idx = 0;
  side = Math.random() < 0.5 ? 1 : -1;
  speed = 1.2 + Math.random() * 0.5;
  money = Math.round(5 + Math.random() * 40);
  bustTimer = 0;
  shotAt = 0;

  constructor(kind: PedKind, x: number, y: number) {
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.build = 0.92 + hashRand(this.id, 9) * 0.22;
    if (kind === 'player') {
      this.archetype = 'player';
      this.outfit = 'player';
      this.shirt = '#4a3220'; // leather jacket
      this.pants = '#26262a';
      this.hair = '#2a1c10';
      this.hairStyle = 'short';
      this.skin = '#f1c9a5';
    } else if (kind === 'cop') {
      this.archetype = 'cop';
      this.outfit = 'police';
      this.shirt = '#1a3f9c';
      this.pants = '#0c1a45';
      this.hair = '#10205a';
      this.hairStyle = 'cap';
      this.skin = pick(SKIN);
      this.weapon = 'pistol';
      this.speed = 4.2;
    } else {
      const a = pick(ARCHETYPES);
      this.archetype = a;
      this.outfit = a;
      this.skin = pick(SKIN);
      this.hairStyle = pick(HAIRSTYLES);
      switch (a) {
        case 'suit':
          this.shirt = pick(['#1f2430', '#263238', '#37474f', '#2b2b2b']);
          this.pants = shade(this.shirt, -0.2);
          this.hairStyle = pick(['short', 'bald', 'short']);
          break;
        case 'tourist':
          this.shirt = pick(BRIGHT);
          this.pants = '#c9b48a';
          this.hairStyle = pick(['hat', 'cap', 'short', 'long']);
          break;
        case 'jogger':
          this.shirt = pick(BRIGHT);
          this.pants = '#212121';
          this.hairStyle = pick(['short', 'bun', 'long']);
          this.speed *= 1.15;
          break;
        case 'elderly':
          this.shirt = pick(['#78716c', '#8d8577', '#6b7a5e', '#5c6b73']);
          this.pants = '#616161';
          this.hair = pick(GREY_HAIR);
          this.hairStyle = pick(['short', 'bald', 'scarf']);
          this.speed *= 0.7;
          break;
        case 'student':
          this.shirt = pick(['#3949ab', '#00897b', '#6d4c41', '#455a64', '#c2185b']);
          this.pants = '#2b3a67';
          this.hairStyle = pick(['long', 'short', 'cap']);
          break;
        case 'worker':
          this.shirt = '#ff6f00';
          this.pants = '#37474f';
          this.hairStyle = 'helmet';
          break;
        case 'dress':
          this.shirt = pick(DRESS);
          this.pants = this.shirt;
          this.hairStyle = pick(['long', 'bun', 'short', 'scarf']);
          break;
        default:
          this.shirt = pick(SHIRTS);
          this.pants = pick(PANTS);
      }
    }
  }

  get dead() {
    return this.state === 'dead';
  }

  /** Move with velocity and resolve collisions against buildings. */
  move(dt: number, world: World, vx: number, vy: number) {
    this.vx = vx;
    this.vy = vy;
    this.x += vx * dt;
    this.y += vy * dt;
    const hit = world.collideCircle(this.x, this.y, this.r);
    if (hit) {
      this.x += hit.nx * hit.depth;
      this.y += hit.ny * hit.depth;
    }
    const sp = Math.hypot(vx, vy);
    if (sp > 0.1) {
      this.walkPhase += sp * dt * 3.2;
      const target = Math.atan2(vy, vx);
      let d = target - this.angle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.angle += d * Math.min(1, dt * 14);
    }
    return !!hit;
  }

  kill(fromX: number, fromY: number, force = 4) {
    if (this.dead) return;
    this.state = 'dead';
    this.health = 0;
    const d = Math.hypot(this.x - fromX, this.y - fromY) || 1;
    this.vx = ((this.x - fromX) / d) * force;
    this.vy = ((this.y - fromY) / d) * force;
    this.deadTime = 0;
  }

  /** Flash white briefly (call from combat code on a successful hit). */
  hit() {
    this.hitFlash = 0.14;
  }

  draw(ctx: CanvasRenderingContext2D, atmos?: Atmosphere) {
    // decay the hit-flash timer using real elapsed time between draws
    const now = performance.now();
    const dtMs = this.lastDrawMs ? now - this.lastDrawMs : 0;
    this.lastDrawMs = now;
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dtMs / 1000);

    ctx.save();
    ctx.translate(this.x, this.y);
    const b = this.build;
    if (this.dead) {
      const rot = (hashRand(this.id, 1) - 0.5) * 2.4;
      ctx.rotate(this.angle + rot);
      ctx.scale(1.45 * b, 1.45 * b);
      // blood pool grows over the first ~2s, then stays
      const grow = Math.min(1, this.deadTime / 2);
      ctx.fillStyle = 'rgba(120,0,0,0.7)';
      ctx.beginPath();
      ctx.ellipse(0.1, 0.05, 0.25 + 0.55 * grow, 0.18 + 0.42 * grow, 0.4, 0, Math.PI * 2);
      ctx.fill();
      // sprawled torso
      ctx.fillStyle = shade(this.shirt, -0.15);
      ctx.beginPath();
      ctx.ellipse(-0.05, 0, 0.34, 0.19, 0, 0, Math.PI * 2);
      ctx.fill();
      // splayed limbs, stable per-ped random angles
      const legCol = shade(this.pants, -0.1);
      drawLimb(ctx, -0.14, -0.1, (hashRand(this.id, 4) - 0.5) * 1.3 + 0.35, 0.32, 0.1, legCol);
      drawLimb(ctx, -0.14, 0.1, (hashRand(this.id, 5) - 0.5) * 1.3 - 0.35, 0.32, 0.1, legCol);
      drawLimb(ctx, 0.12, -0.12, (hashRand(this.id, 2) - 0.5) * 1.8, 0.28, 0.09, this.skin);
      drawLimb(ctx, 0.12, 0.12, (hashRand(this.id, 3) - 0.5) * 1.8 + Math.PI * 0.15, 0.28, 0.09, this.skin);
      ctx.fillStyle = this.skin;
      ctx.beginPath();
      ctx.arc(0.44, 0, 0.16, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.02;
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.rotate(this.angle);
    ctx.scale(1.45, 1.45);
    const speed = Math.hypot(this.vx, this.vy);
    const moving = Math.min(1, speed);
    const running = speed > 2.2;
    const strideMul = running ? 1.35 : 1;
    // shadow, offset along the sun
    let shx = 0.08, shy = 0.1;
    if (atmos) {
      const night = atmos.night;
      if (night > 0.72) { shx = 0.04; shy = 0.05; }
      else {
        const h = 0.85, ca = Math.cos(this.angle), sa = Math.sin(this.angle);
        const wx = atmos.sun.dx * h, wy = atmos.sun.dy * h;
        shx = (wx * ca + wy * sa) / 1.45;
        shy = (-wx * sa + wy * ca) / 1.45;
      }
    }
    // contact shadow under the feet, plus a softer cast shadow stretched from them along the sun
    ctx.fillStyle = 'rgba(0,0,0,0.26)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.26 * b, 0.32 * b, 0, 0, Math.PI * 2);
    ctx.fill();
    const slen = Math.min(0.9, Math.hypot(shx, shy));
    if (slen > 0.08) {
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.beginPath();
      ctx.ellipse(shx / Math.hypot(shx, shy) * slen / 2, shy / Math.hypot(shx, shy) * slen / 2, slen / 2 + 0.15, 0.22 * b, Math.atan2(shy, shx), 0, Math.PI * 2);
      ctx.fill();
    }

    const armed = this.weapon !== 'fist' && this.kind !== 'civ';
    const punchT = this.weapon === 'fist' && this.cooldown > 0 ? Math.min(1, this.cooldown / 0.45) : 0;
    // civilians (unarmed, not mid-gesture) are the bulk of the crowd: render via the sprite cache
    const cacheable = !armed && !this.handsUp && punchT <= 0 && this.hitFlash <= 0;
    if (cacheable) {
      const swingQ = moving > 0.15 ? Math.round((this.walkPhase % (Math.PI * 2)) * 6 / Math.PI) : 0;
      const buildQ = Math.round(b * 20);
      const key = `ped|${this.archetype}|${this.shirt}|${this.pants}|${this.hair}|${this.hairStyle}|${this.skin}|${buildQ}|${swingQ}|${moving > 0.15 ? (running ? 2 : 1) : 0}`;
      SpriteCache.draw(ctx, key, 1.3, (c) => {
        const swingPhase = swingQ * Math.PI / 6;
        const swing = moving > 0.15 ? Math.sin(swingPhase) * 0.22 * strideMul : 0;
        drawBody(c, this, swing, moving > 0.15, buildQ / 20, atmos);
      });
    } else {
      const swing = Math.sin(this.walkPhase) * 0.22 * moving * strideMul;
      drawBody(ctx, this, swing, moving > 0.15, b, atmos);
      if (this.handsUp) {
        ctx.fillStyle = this.skin;
        ctx.fillRect(-0.06, -0.62, 0.14, 0.28);
        ctx.fillRect(-0.06, 0.34, 0.14, 0.28);
      } else if (punchT > 0) {
        const ext = 0.34 + 0.16 * (1 - punchT);
        ctx.fillStyle = this.skin;
        ctx.fillRect(0.05, -0.06, ext, 0.1);
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.arc(0.05 + ext, -0.01, 0.06, 0, Math.PI * 2);
        ctx.fill();
      } else if (armed) {
        ctx.fillStyle = this.skin;
        ctx.fillRect(0.05, -0.06, 0.3, 0.1);
        ctx.fillStyle = '#111';
        if (this.weapon === 'pistol') {
          ctx.fillRect(0.32, -0.05, 0.2, 0.08);
        } else {
          // uzi/shotgun: both arms forward, gripping
          ctx.fillRect(-0.02, -0.06, 0.36, 0.1);
          ctx.fillRect(0.34, -0.06, this.weapon === 'shotgun' ? 0.5 : 0.28, 0.09);
        }
      }
    }
    if (this.hitFlash > 0) {
      ctx.globalAlpha = Math.min(0.85, this.hitFlash / 0.14);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.4, 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
}

function drawLimb(ctx: CanvasRenderingContext2D, px: number, py: number, ang: number, len: number, wid: number, color: string) {
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(ang);
  ctx.fillStyle = color;
  ctx.fillRect(0, -wid / 2, len, wid);
  ctx.restore();
}

/** Draws the unarmed body: legs, arms at rest, torso, head, hair, archetype accessories.
 * Used both directly (armed peds) and inside SpriteCache (unarmed crowd). */
function drawBody(ctx: CanvasRenderingContext2D, p: Ped, swing: number, moving: boolean, b: number, atmos?: Atmosphere) {
  ctx.save();
  ctx.scale(b, b);
  // legs/feet (visible stride when moving)
  ctx.fillStyle = p.pants;
  const skirt = p.archetype === 'dress';
  if (!skirt) {
    ctx.fillRect(swing, -0.2, 0.2, 0.12);
    ctx.fillRect(-swing, 0.08, 0.2, 0.12);
  }
  ctx.fillStyle = '#181818';
  if (moving && !skirt) {
    ctx.fillRect(swing + (swing >= 0 ? 0.14 : -0.02), -0.2, 0.08, 0.12);
    ctx.fillRect(-swing + (-swing >= 0 ? 0.14 : -0.02), 0.08, 0.08, 0.12);
  } else if (skirt) {
    ctx.fillRect(swing * 0.5, -0.16, 0.08, 0.1);
    ctx.fillRect(-swing * 0.5, 0.06, 0.08, 0.1);
  }
  // arms at sides, swinging counter-phase to legs
  ctx.fillStyle = p.skin;
  ctx.fillRect(-swing * 0.8 - 0.05, -0.36, 0.2, 0.1);
  ctx.fillRect(swing * 0.8 - 0.05, 0.26, 0.2, 0.1);
  // torso: rounded shoulders with a subtle gradient + darker edge, shaded toward the sun
  ctx.fillStyle = torsoGradient(ctx, p.shirt);
  ctx.beginPath();
  ctx.ellipse(0, 0, 0.19, 0.33, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = shade(p.shirt, -0.35);
  ctx.lineWidth = 0.025;
  ctx.stroke();
  if (skirt) {
    // dress: shirt-colour skirt flares out over the upper legs
    ctx.fillStyle = shade(p.shirt, -0.08);
    ctx.beginPath();
    ctx.moveTo(-0.1, -0.22);
    ctx.quadraticCurveTo(-0.3, 0, -0.14, 0.3);
    ctx.lineTo(0.02, 0.3);
    ctx.lineTo(0.05, -0.22);
    ctx.closePath();
    ctx.fill();
  }
  if (p.archetype === 'player') {
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.moveTo(0, -0.28);
    ctx.lineTo(0, 0.28);
    ctx.stroke();
  }
  if (p.kind === 'cop') {
    const swat = p.outfit === 'swat';
    if (swat) {
      // black tactical vest covering most of the torso
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.17, 0.29, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 0.015;
      ctx.beginPath();
      ctx.moveTo(0, -0.26);
      ctx.lineTo(0, 0.26);
      ctx.stroke();
    }
    ctx.fillStyle = swat ? '#0d0d0d' : '#0c1a45';
    ctx.fillRect(-0.19, -0.06, 0.38, 0.12);
    ctx.fillStyle = '#c9a227';
    ctx.fillRect(0.06, -0.04, 0.05, 0.05); // badge
  }
  if (p.archetype === 'worker') {
    // hi-vis vest with reflective stripes
    ctx.fillStyle = '#ff8f00';
    ctx.fillRect(-0.19, -0.26, 0.38, 0.5);
    ctx.fillStyle = '#fff59d';
    ctx.fillRect(-0.19, -0.08, 0.38, 0.05);
    ctx.fillRect(-0.19, 0.08, 0.38, 0.05);
  }
  if (p.archetype === 'suit') {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 0.015;
    ctx.beginPath();
    ctx.moveTo(-0.03, -0.3);
    ctx.lineTo(-0.03, 0.3);
    ctx.moveTo(0.03, -0.3);
    ctx.lineTo(0.03, 0.3);
    ctx.stroke();
    // briefcase carried on the trailing hand
    ctx.fillStyle = '#1c1c1c';
    ctx.fillRect(-0.2, 0.3, 0.16, 0.13);
  }
  if (p.archetype === 'tourist') {
    ctx.fillStyle = shade(p.shirt, -0.35);
    ctx.beginPath();
    ctx.ellipse(-0.2, 0, 0.14, 0.2, 0, 0, Math.PI * 2);
    ctx.fill(); // backpack behind
    ctx.fillStyle = '#222';
    ctx.fillRect(-0.02, -0.05, 0.12, 0.1); // camera
  }
  if (p.archetype === 'student') {
    ctx.fillStyle = shade(p.shirt, -0.3);
    ctx.beginPath();
    ctx.ellipse(-0.18, 0, 0.11, 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (p.archetype === 'elderly') {
    ctx.strokeStyle = '#7a5a3a';
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.moveTo(0.16, 0.3);
    ctx.lineTo(0.24, 0.5);
    ctx.stroke();
  }
  // head + hair, thin outline for readability at small zoom
  ctx.fillStyle = p.skin;
  ctx.beginPath();
  ctx.arc(0.06, 0, 0.14, 0, Math.PI * 2);
  ctx.fill();
  drawHair(ctx, p);
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 0.02;
  ctx.beginPath();
  ctx.arc(0.06, 0, 0.14, 0, Math.PI * 2);
  ctx.stroke();
  // subtle night rim-light on the sun/moon-facing edge
  const night = atmos?.night ?? 0;
  if (night > 0.35) {
    ctx.strokeStyle = `rgba(180,200,255,${(night - 0.35) * 0.35})`;
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.19, 0.33, 0, -0.6, 0.6);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHair(ctx: CanvasRenderingContext2D, p: Ped) {
  const style = p.hairStyle;
  if (p.kind === 'cop' && p.outfit === 'swat') {
    // swat helmet: dark dome + visor band
    ctx.fillStyle = '#0d0d0d';
    ctx.beginPath();
    ctx.arc(0.02, 0, 0.165, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(0.1, -0.15, 0.09, 0.3);
    return;
  }
  if (style === 'bald') return;
  ctx.fillStyle = p.hair;
  if (style === 'cap') {
    ctx.beginPath();
    ctx.arc(0.02, 0, 0.15, -Math.PI * 0.75, Math.PI * 0.75);
    ctx.fill();
    ctx.fillStyle = shade(p.hair, -0.2);
    ctx.fillRect(0.1, -0.14, 0.1, 0.28);
    return;
  }
  if (style === 'helmet') {
    ctx.fillStyle = '#ffd600';
    ctx.beginPath();
    ctx.arc(0.02, 0, 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.arc(0.02, 0, 0.16, -0.3, 0.3);
    ctx.stroke();
    return;
  }
  if (style === 'hat') {
    ctx.fillStyle = '#e8dcc0';
    ctx.beginPath();
    ctx.ellipse(0.02, 0, 0.22, 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#c9b98a';
    ctx.beginPath();
    ctx.arc(0.02, 0, 0.13, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (style === 'scarf') {
    ctx.fillStyle = shade(p.shirt, 0.1);
    ctx.beginPath();
    ctx.arc(0.02, 0, 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = shade(p.shirt, -0.15);
    ctx.fillRect(-0.14, 0.02, 0.1, 0.14); // trailing knot
    return;
  }
  // short / long / bun: base coverage circle
  ctx.beginPath();
  ctx.arc(0.02, 0, 0.15, 0, Math.PI * 2);
  ctx.fill();
  if (style === 'long') {
    ctx.beginPath();
    ctx.ellipse(-0.1, 0, 0.1, 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (style === 'bun') {
    ctx.beginPath();
    ctx.arc(-0.16, 0, 0.06, 0, Math.PI * 2);
    ctx.fill();
  }
}

const torsoGradCache = new Map<string, CanvasGradient>();
function torsoGradient(ctx: CanvasRenderingContext2D, color: string) {
  let g = torsoGradCache.get(color);
  if (g) return g;
  g = ctx.createLinearGradient(-0.19, 0, 0.19, 0);
  g.addColorStop(0, shade(color, -0.18));
  g.addColorStop(0.5, shade(color, 0.1));
  g.addColorStop(1, shade(color, -0.18));
  torsoGradCache.set(color, g);
  return g;
}
