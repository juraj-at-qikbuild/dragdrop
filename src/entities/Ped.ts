import type { Atmosphere } from '../world/Atmosphere';
import type { World } from '../world/World';
import type { Link } from '../world/Graph';
import type { Vehicle } from './Vehicle';
import { pick } from '../util/math';
import { shade } from './Vehicle';

export type PedKind = 'player' | 'civ' | 'cop';
export type PedState = 'walk' | 'flee' | 'dead' | 'chase' | 'idle';

const SHIRTS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#f4511e', '#00897b', '#6d4c41', '#eceff1', '#212121', '#3949ab', '#c2185b'];
const HAIR = ['#2b1d14', '#4a3222', '#8d6e63', '#d7b377', '#1a1a1a', '#9e9e9e', '#b5651d'];
const SKIN = ['#f1c9a5', '#e0ac85', '#c68863', '#8d5a3b', '#f5d6ba'];

export type WeaponId = 'fist' | 'pistol' | 'uzi' | 'shotgun';

export class Ped {
  x: number;
  y: number;
  angle = 0;
  vx = 0;
  vy = 0;
  r = 0.34;
  health = 100;
  kind: PedKind;
  state: PedState = 'walk';
  shirt: string;
  hair: string;
  skin: string;
  walkPhase = Math.random() * 10;
  vehicle: Vehicle | null = null;
  weapon: WeaponId = 'fist';
  cooldown = 0;
  timer = 0;
  fleeFrom = { x: 0, y: 0 };
  deadTime = 0;
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
    this.shirt = kind === 'cop' ? '#1a3f9c' : kind === 'player' ? '#f5f5f5' : pick(SHIRTS);
    this.hair = kind === 'cop' ? '#10205a' : kind === 'player' ? '#3b2717' : pick(HAIR);
    this.skin = kind === 'player' ? '#f1c9a5' : pick(SKIN);
    if (kind === 'cop') {
      this.weapon = 'pistol';
      this.speed = 4.2;
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

  draw(ctx: CanvasRenderingContext2D, atmos?: Atmosphere) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);
    ctx.scale(1.45, 1.45);
    if (this.dead) {
      // blood pool grows over the first ~2s, then stays
      const grow = Math.min(1, this.deadTime / 2);
      ctx.fillStyle = 'rgba(120,0,0,0.7)';
      ctx.beginPath();
      ctx.ellipse(0.1, 0.05, 0.25 + 0.55 * grow, 0.18 + 0.42 * grow, 0.4, 0, Math.PI * 2);
      ctx.fill();
      // sprawled body
      ctx.fillStyle = shade(this.shirt, -0.15);
      ctx.beginPath();
      ctx.ellipse(-0.05, 0, 0.34, 0.19, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.fillRect(-0.42, -0.09, 0.22, 0.09);
      ctx.fillRect(-0.42, 0.02, 0.22, 0.09);
      ctx.fillStyle = this.skin;
      ctx.fillRect(0.22, -0.09, 0.2, 0.08);
      ctx.beginPath();
      ctx.arc(0.44, 0, 0.16, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.02;
      ctx.stroke();
      ctx.restore();
      return;
    }
    const speed = Math.hypot(this.vx, this.vy);
    const moving = Math.min(1, speed);
    const swing = Math.sin(this.walkPhase) * 0.22 * moving;
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
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(shx, shy, 0.3, 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    // legs/feet (visible stride when moving)
    ctx.fillStyle = '#222';
    ctx.fillRect(swing, -0.2, 0.2, 0.12);
    ctx.fillRect(-swing, 0.08, 0.2, 0.12);
    if (moving > 0.15) {
      ctx.fillStyle = '#111';
      ctx.fillRect(swing + (swing >= 0 ? 0.14 : -0.02), -0.2, 0.08, 0.12);
      ctx.fillRect(-swing + (-swing >= 0 ? 0.14 : -0.02), 0.08, 0.08, 0.12);
    }
    // arms
    ctx.fillStyle = this.skin;
    ctx.fillRect(-swing * 0.8 - 0.05, -0.36, 0.2, 0.1);
    const armed = this.weapon !== 'fist' && this.kind !== 'civ';
    if (armed) {
      ctx.fillRect(0.05, 0.14, 0.34, 0.1);
      ctx.fillStyle = '#111';
      ctx.fillRect(0.34, 0.12, this.weapon === 'uzi' ? 0.3 : this.weapon === 'shotgun' ? 0.55 : 0.2, 0.08);
    } else ctx.fillRect(swing * 0.8 - 0.05, 0.26, 0.2, 0.1);
    // torso: rounded shoulders with a subtle gradient + darker edge
    ctx.fillStyle = torsoGradient(ctx, this.shirt);
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.19, 0.33, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = shade(this.shirt, -0.35);
    ctx.lineWidth = 0.025;
    ctx.stroke();
    if (this.kind === 'player') {
      // leather jacket highlight seam
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 0.03;
      ctx.beginPath();
      ctx.moveTo(0, -0.28);
      ctx.lineTo(0, 0.28);
      ctx.stroke();
    }
    if (this.kind === 'cop') {
      // dark navy belt/vest strap
      ctx.fillStyle = '#0c1a45';
      ctx.fillRect(-0.19, -0.06, 0.38, 0.12);
    }
    // head + hair, thin outline for readability at small zoom
    ctx.fillStyle = this.skin;
    ctx.beginPath();
    ctx.arc(0.06, 0, 0.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = this.hair;
    ctx.beginPath();
    ctx.arc(0.02, 0, 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 0.02;
    ctx.stroke();
    if (this.kind === 'cop') {
      // cap with visor
      ctx.fillStyle = '#0c1a45';
      ctx.beginPath();
      ctx.arc(0.02, 0, 0.15, -Math.PI * 0.75, Math.PI * 0.75);
      ctx.fill();
      ctx.fillStyle = '#08122f';
      ctx.fillRect(0.1, -0.14, 0.1, 0.28);
    }
    ctx.restore();
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
