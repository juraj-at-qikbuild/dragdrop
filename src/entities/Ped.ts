import type { World } from '../world/World';
import type { Link } from '../world/Graph';
import type { Vehicle } from './Vehicle';
import { pick } from '../util/math';

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

  draw(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);
    ctx.scale(1.45, 1.45);
    if (this.dead) {
      ctx.fillStyle = 'rgba(130,0,0,0.75)';
      ctx.beginPath();
      ctx.ellipse(0.1, 0.05, 0.75, 0.55, 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = this.shirt;
      ctx.fillRect(-0.45, -0.28, 0.75, 0.56);
      ctx.fillStyle = this.skin;
      ctx.beginPath();
      ctx.arc(0.45, 0, 0.17, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    const swing = Math.sin(this.walkPhase) * 0.22 * Math.min(1, Math.hypot(this.vx, this.vy));
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0.08, 0.1, 0.3, 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    // legs/feet
    ctx.fillStyle = '#222';
    ctx.fillRect(swing, -0.2, 0.2, 0.12);
    ctx.fillRect(-swing, 0.08, 0.2, 0.12);
    // arms
    ctx.fillStyle = this.skin;
    ctx.fillRect(-swing * 0.8 - 0.05, -0.36, 0.2, 0.1);
    if (this.weapon !== 'fist' && (this.kind !== 'civ')) {
      ctx.fillRect(0.05, 0.14, 0.34, 0.1);
      ctx.fillStyle = '#111';
      ctx.fillRect(0.34, 0.12, this.weapon === 'uzi' ? 0.3 : this.weapon === 'shotgun' ? 0.55 : 0.2, 0.08);
    } else ctx.fillRect(swing * 0.8 - 0.05, 0.26, 0.2, 0.1);
    // torso
    ctx.fillStyle = this.shirt;
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.18, 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    // head
    ctx.fillStyle = this.hair;
    ctx.beginPath();
    ctx.arc(0.02, 0, 0.15, 0, Math.PI * 2);
    ctx.fill();
    if (this.kind === 'cop') {
      ctx.fillStyle = '#0c1a45';
      ctx.fillRect(0.08, -0.13, 0.12, 0.26);
    }
    ctx.restore();
  }
}
