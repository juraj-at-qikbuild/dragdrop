import type { Game } from '../game/Game';
import type { Atmosphere } from '../world/Atmosphere';
import type { LightLayer } from '../world/Lighting';
import { clamp, dist, lerp } from '../shared/util/math';

/** Police helicopter: follows the player with lag at altitude, searchlight at night,
 *  fires bursts at 5 stars. Drawn top-down with its shadow cast on the ground. */
export class Helicopter {
  x = 0;
  y = 0;
  altitude = 42;
  angle = 0;
  rotor = 0;
  vx = 0;
  vy = 0;
  spawned = false;
  private fireCooldown = 2;
  private navBlink = 0;

  spawn(game: Game) {
    const f = game.focus();
    this.x = f.x + 40;
    this.y = f.y - 40;
    this.spawned = true;
  }

  update(dt: number, game: Game) {
    if (!this.spawned) return;
    const f = game.focus();
    // lag behind the player: spring toward a point offset ahead of their motion
    const pv = game.player.vehicle;
    const lead = pv ? 6 : 2;
    const tx = f.x + (pv ? pv.vx : 0) * lead * 0.3, ty = f.y + (pv ? pv.vy : 0) * lead * 0.3;
    const dx = tx - this.x, dy = ty - this.y;
    const k = Math.min(1, dt * 0.8);
    this.vx = lerp(this.vx, dx * 1.1, k);
    this.vy = lerp(this.vy, dy * 1.1, k);
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    const want = Math.atan2(dy, dx);
    if (Math.hypot(dx, dy) > 2) {
      let d = want - this.angle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.angle += d * Math.min(1, dt * 2);
    }
    this.rotor += dt * 55;
    this.navBlink += dt;
    game.audio.rotor(clamp(1 - dist(this.x, this.y, f.x, f.y) / 90, 0, 1));

    // 5 stars: fire bursts at the player when roughly overhead and in range
    const stars = Math.ceil(game.wanted - 0.01);
    this.fireCooldown -= dt;
    if (stars >= 5 && this.fireCooldown <= 0 && dist(this.x, this.y, f.x, f.y) < 26) {
      this.fireCooldown = 1.4 + Math.random() * 0.8;
      const a = Math.atan2(f.y - this.y, f.x - this.x);
      game.combat.fire(fakeShooter(this), a, 'uzi');
    }
  }

  /** visual lift from the ground shadow toward the body, along the sun direction: bounded so it
   *  reads well at any zoom level instead of the building roof-parallax (which blows up when the
   *  camera is zoomed in close, e.g. while the player is on foot). */
  private liftOffset(game: Game): [number, number] {
    const sun = game.atmos.sun ?? { dx: 0.4, dy: -0.6 };
    const k = Math.min(6, this.altitude * 0.14);
    return [sun.dx * k, sun.dy * k];
  }

  /** does the heli's view (or, at night, its searchlight) currently cover the player? */
  sees(game: Game): boolean {
    if (!this.spawned) return false;
    const f = game.focus();
    return dist(this.x, this.y, f.x, f.y) < 24;
  }

  draw(ctx: CanvasRenderingContext2D, game: Game, time: number) {
    if (!this.spawned) return;
    const v = game.view();
    if (this.x < v.x0 - 60 || this.x > v.x1 + 60 || this.y < v.y0 - 60 || this.y > v.y1 + 60) return;
    const [ox, oy] = this.liftOffset(game);
    const atmos = game.atmos;

    // ground shadow at the true (unlifted) position
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 2.6, 1.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // night searchlight cone on the ground, under the body
    if (atmos.night > 0.2) {
      const f = game.focus();
      const cov = dist(this.x, this.y, f.x, f.y) < 24;
      ctx.save();
      ctx.globalAlpha = 0.35 * atmos.night;
      ctx.fillStyle = cov ? '#fff9d6' : '#e6f2ff';
      ctx.beginPath();
      ctx.ellipse(this.x * 0.15 + f.x * 0.85, this.y * 0.15 + f.y * 0.85, 4.5, 4.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // body, lifted by altitude offset
    ctx.save();
    ctx.translate(this.x + ox, this.y + oy);
    ctx.rotate(this.angle);
    // tail boom
    ctx.fillStyle = '#1c2430';
    ctx.fillRect(-2.6, -0.18, 2.1, 0.36);
    ctx.beginPath();
    ctx.moveTo(-2.55, 0);
    ctx.lineTo(-2.9, -0.35);
    ctx.lineTo(-2.9, 0.35);
    ctx.closePath();
    ctx.fill();
    // tail rotor blur
    ctx.fillStyle = 'rgba(180,190,200,0.5)';
    ctx.beginPath();
    ctx.ellipse(-2.85, 0, 0.06, 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    // fuselage
    ctx.fillStyle = '#0f1620';
    ctx.beginPath();
    ctx.ellipse(0.1, 0, 1.5, 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a3f9c';
    ctx.beginPath();
    ctx.ellipse(0.1, 0, 1.1, 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
    // cockpit glass
    ctx.fillStyle = '#8fb8e0';
    ctx.beginPath();
    ctx.ellipse(0.95, 0, 0.5, 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    // skids
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 0.1;
    ctx.beginPath();
    ctx.moveTo(-0.9, -0.95);
    ctx.lineTo(0.9, -0.95);
    ctx.moveTo(-0.9, 0.95);
    ctx.lineTo(0.9, 0.95);
    ctx.stroke();
    // main rotor blur disk
    ctx.fillStyle = 'rgba(200,210,220,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 2.9, 2.9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(150,160,170,0.5)';
    ctx.lineWidth = 0.05;
    ctx.save();
    ctx.rotate(this.rotor);
    ctx.beginPath();
    ctx.moveTo(-2.9, 0);
    ctx.lineTo(2.9, 0);
    ctx.stroke();
    ctx.restore();
    // blinking nav lights
    const blink = Math.sin(this.navBlink * 6) > 0.6;
    ctx.fillStyle = blink ? '#ff1744' : 'rgba(255,23,68,0.15)';
    ctx.beginPath();
    ctx.arc(0, -0.85, 0.09, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = blink ? '#00e676' : 'rgba(0,230,118,0.15)';
    ctx.beginPath();
    ctx.arc(0, 0.85, 0.09, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  emitLights(L: LightLayer, atmos: Atmosphere, game: Game) {
    if (!this.spawned) return;
    const [ox, oy] = this.liftOffset(game);
    const bx = this.x + ox, by = this.y + oy;
    const blink = Math.sin(this.navBlink * 6) > 0.6;
    if (blink) L.point(bx, by - 0.85, 1.4, '#ff1744', 0.5);
    if (atmos.night > 0.15) {
      const f = game.focus();
      const lx = this.x * 0.15 + f.x * 0.85, ly = this.y * 0.15 + f.y * 0.85;
      const covering = dist(this.x, this.y, f.x, f.y) < 24;
      L.point(lx, ly, 5.5, covering ? '#fff6cc' : '#dfeeff', clamp(0.9 * atmos.night, 0, 1));
      L.glow(lx, ly, 6, '#fff6cc', 0.35 * atmos.night);
    }
  }
}

/** a throwaway "shooter" descriptor the combat system accepts as a Ped-shaped source */
function fakeShooter(h: Helicopter) {
  return { x: h.x, y: h.y, level: 0, kind: 'cop', vehicle: null, dead: false } as unknown as import('./Ped').Ped;
}
