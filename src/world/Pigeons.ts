// Pigeons (docs/plans/non-violent.md): flocks pecking about the city's squares, off in a clatter of wings
// and feathers when a car comes through, someone runs at them or something goes off nearby, and back a
// while later. Only for the looks: each client keeps its own (nothing depends on them, no points).
import type { World } from '../shared/world/World';
import type { View } from './Renderer';
import { hash01 } from '../shared/util/math';

/** the squares with a flock (landmark ids) */
const SQUARES = ['main', 'hviezdoslav', 'franciscan', 'primate', 'snpsquare', 'kamenne', 'eurovea', 'hodzovo', 'manderlak', 'reduta'];
/** only flocks this close to the camera are updated (m) */
const NEAR = 140;
/** seconds away once scared off, before they come back */
const AWAY_MIN = 25, AWAY_MAX = 40;

const enum S {
  Ground,
  Off,
  Away,
  Landing,
}

interface Bird {
  hx: number;
  hy: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** height, 0 (on the ground) .. 1 (up over the roofs) */
  h: number;
  state: S;
  t: number;
  a: number;
  seed: number;
}

interface Flock {
  x: number;
  y: number;
  birds: Bird[];
  away: number;
}

export class Pigeons {
  readonly flocks: Flock[] = [];
  /** a flock took off at (x, y), `n` birds (the client's effects: feathers, the flutter) */
  onScare?: (x: number, y: number, n: number) => void;

  constructor(world: World) {
    SQUARES.forEach((id, fi) => {
      const l = world.landmarks.get(id);
      if (!l) return;
      const s = world.walkableNear(l.x, l.y);
      if (world.insideBuilding(s.x, s.y) || world.inWater(s.x, s.y, 0) || world.onBridge(s.x, s.y)) return;
      const birds: Bird[] = [];
      const n = 9 + Math.floor(hash01(fi, 1) * 8);
      for (let k = 0; birds.length < n && k < n * 4; k++) {
        const a = hash01(fi * 31 + k, 2) * Math.PI * 2, r = 0.6 + hash01(fi * 31 + k, 3) * 3.4;
        const hx = s.x + Math.cos(a) * r, hy = s.y + Math.sin(a) * r;
        if (world.collideCircle(hx, hy, 0.2, 0) || world.inWater(hx, hy, 0)) continue;
        birds.push({ hx, hy, x: hx, y: hy, vx: 0, vy: 0, h: 0, state: S.Ground, t: 0, a: hash01(fi, k) * Math.PI * 2, seed: fi * 100 + k });
      }
      if (birds.length) this.flocks.push({ x: s.x, y: s.y, birds, away: 0 });
    });
  }

  /** something startled them at (x, y): every flock within `r` takes off */
  scare(x: number, y: number, r: number) {
    for (const f of this.flocks) if (Math.hypot(f.x - x, f.y - y) < r) this.takeOff(f, x, y);
  }

  private takeOff(f: Flock, fromX: number, fromY: number) {
    let n = 0;
    for (const b of f.birds) {
      if (b.state !== S.Ground && b.state !== S.Landing) continue;
      const a = Math.atan2(b.y - fromY, b.x - fromX) + (hash01(b.seed, Math.round(b.x * 10)) - 0.5) * 1.6;
      const sp = 5 + hash01(b.seed, 9) * 4;
      b.vx = Math.cos(a) * sp;
      b.vy = Math.sin(a) * sp;
      b.a = a;
      b.state = S.Off;
      b.t = 1.4 + hash01(b.seed, 11) * 0.6;
      n++;
    }
    if (!n) return;
    f.away = AWAY_MIN + Math.random() * (AWAY_MAX - AWAY_MIN);
    this.onScare?.(f.x, f.y, n);
  }

  /** Scared by a car coming through (over 3 m/s within 7 m), a player running at them (within 4 m),
   *  someone fleeing right by them; pecking about, flying off, coming back. */
  update(dt: number, focus: { x: number; y: number }, cars: Iterable<{ x: number; y: number; vx: number; vy: number; level: number }>, peds: Iterable<{ x: number; y: number; vx: number; vy: number; playerId: number; state: string; vehicle: unknown; level: number }>) {
    for (const f of this.flocks) {
      if (Math.abs(f.x - focus.x) > NEAR || Math.abs(f.y - focus.y) > NEAR) continue;
      const settled = f.birds.some((b) => b.state === S.Ground || b.state === S.Landing);
      if (settled) {
        for (const c of cars) {
          if (c.level === 0 && Math.abs(c.x - f.x) < 9 && Math.abs(c.y - f.y) < 9 && Math.hypot(c.vx, c.vy) > 3 && Math.hypot(c.x - f.x, c.y - f.y) < 7) {
            this.takeOff(f, c.x, c.y);
            break;
          }
        }
        for (const p of peds) {
          if (p.vehicle || p.level !== 0 || Math.abs(p.x - f.x) > 6 || Math.abs(p.y - f.y) > 6) continue;
          const d = Math.hypot(p.x - f.x, p.y - f.y), sp = Math.hypot(p.vx, p.vy);
          if ((p.playerId && sp > 3.5 && d < 4) || (p.state === 'flee' && d < 3)) {
            this.takeOff(f, p.x, p.y);
            break;
          }
        }
      }
      if (f.away > 0) f.away -= dt;
      for (const b of f.birds) this.stepBird(f, b, dt);
    }
  }

  private stepBird(f: Flock, b: Bird, dt: number) {
    switch (b.state) {
      case S.Ground:
        // pecking about, now and then a hop
        if (Math.random() < dt * 0.6) {
          const a = Math.random() * Math.PI * 2;
          b.x = b.hx + Math.cos(a) * 0.25;
          b.y = b.hy + Math.sin(a) * 0.25;
          b.a = a;
        }
        break;
      case S.Off:
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.h = Math.min(1, b.h + dt * 0.9);
        if ((b.t -= dt) <= 0) b.state = S.Away;
        break;
      case S.Away:
        if (f.away <= 0) {
          // back in from far off, gliding down to where they were
          const a = hash01(b.seed, 13) * Math.PI * 2;
          b.x = b.hx + Math.cos(a) * 18;
          b.y = b.hy + Math.sin(a) * 18;
          b.h = 1;
          b.a = a + Math.PI;
          b.state = S.Landing;
          b.t = 0;
        }
        break;
      case S.Landing: {
        const k = Math.min(1, dt / Math.max(0.05, 2.2 - b.t));
        b.t += dt;
        b.x += (b.hx - b.x) * k;
        b.y += (b.hy - b.y) * k;
        b.h = Math.max(0, b.h - dt * 0.5);
        if (b.t >= 2.2) (b.state = S.Ground), (b.h = 0), (b.x = b.hx), (b.y = b.hy);
        break;
      }
    }
  }

  /** the birds on the ground (`air` false: drawn with the street) or in the air (true: over the
   *  people and the cars); none after dark (roosting) */
  draw(ctx: CanvasRenderingContext2D, v: View, time: number, night: number, air: boolean) {
    if (night > 0.75) return;
    for (const f of this.flocks) {
      if (f.x < v.x0 - 30 || f.x > v.x1 + 30 || f.y < v.y0 - 30 || f.y > v.y1 + 30) continue;
      for (const b of f.birds) {
        if (b.state === S.Away || (air ? b.h < 0.05 : b.h >= 0.05)) continue;
        drawBird(ctx, b, time);
      }
    }
  }
}

function drawBird(ctx: CanvasRenderingContext2D, b: Bird, time: number) {
  const k = (1 + b.h * 0.8) * 1.25;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.a);
  ctx.scale(k, k);
  if (b.h > 0.05) {
    // wings flapping
    const flap = Math.sin(time * 24 + b.seed) * 0.5 + 0.5;
    ctx.fillStyle = '#90a4ae';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(0.02, 0);
      ctx.lineTo(-0.06, s * (0.14 + flap * 0.16));
      ctx.lineTo(-0.14, s * 0.04);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.fillStyle = '#9e9e9e';
  ctx.beginPath();
  ctx.ellipse(0, 0, 0.13, 0.075, 0, 0, Math.PI * 2);
  ctx.fill();
  // the head, bobbing as it pecks, with its green-violet neck
  const peck = b.h < 0.05 ? Math.max(0, Math.sin(time * 5 + b.seed)) * 0.04 : 0;
  ctx.fillStyle = '#6a8a7a';
  ctx.beginPath();
  ctx.arc(0.08 + peck, 0, 0.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#546e7a';
  ctx.beginPath();
  ctx.arc(0.12 + peck, 0, 0.04, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
