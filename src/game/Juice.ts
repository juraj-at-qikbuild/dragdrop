// Game feel: camera shake/punch, hit-stop & slow-mo, floating world text, and the
// style/chaos combo (near misses, drifts, takedowns) that feeds nitro & cash.
import type { Game } from './Game';
import type { Vehicle } from '../entities/Vehicle';
import { clamp, dist, lerp } from '../util/math';

interface FloatText {
  x: number; y: number; vy: number; life: number; max: number;
  text: string; color: string; size: number;
}

const TEXT_CAP = 40;
const COMBO_WINDOW = 4;

export class Juice {
  // camera
  trauma = 0;
  private kx = 0;
  private ky = 0;
  zoomPunch = 0;
  private leadX = 0;
  private leadY = 0;
  private boostZoom = 0;
  // time control
  private hitstop = 0; // seconds of real time left fully frozen
  private slowT = 0; // seconds of slow-mo left
  private slowFactor = 1;
  // floating text
  private texts: FloatText[] = [];
  // combo/style
  combo = { mult: 1, timer: 0, label: '' };
  private comboCash = 0;
  private driftDur = new Map<Vehicle, number>();
  private nearMissCd = new Map<Vehicle, number>();

  constructor(private game: Game) {}

  // ------------------------------------------------------------- camera api
  /** directional impulse, e.g. from an impact: kick(-nx, -ny, strength). */
  kick(dx: number, dy: number, strength: number) {
    const l = Math.hypot(dx, dy) || 1;
    this.kx += (dx / l) * strength;
    this.ky += (dy / l) * strength;
  }

  addTrauma(t: number) {
    this.trauma = clamp(this.trauma + t, 0, 1);
  }

  /** eased speed look-ahead: smoother than snapping straight to velocity*k */
  leadOffset(v: Vehicle | null, dt: number): { x: number; y: number } {
    const wx = v ? v.vx * 0.75 : 0, wy = v ? v.vy * 0.75 : 0;
    const k = Math.min(1, dt * 2.5);
    this.leadX = lerp(this.leadX, wx, k);
    this.leadY = lerp(this.leadY, wy, k);
    return { x: this.leadX, y: this.leadY };
  }

  /** extra camera zoom multiplier: slight zoom-out on nitro boost, punch-in on impacts */
  zoomFactor(v: Vehicle | null, dt: number): number {
    this.boostZoom = lerp(this.boostZoom, v?.boosting ? 1 : 0, Math.min(1, dt * 2));
    return 1 - this.boostZoom * 0.1 + this.zoomPunch * 0.16;
  }

  punchZoom(amount: number) {
    this.zoomPunch = Math.max(this.zoomPunch, amount);
  }

  /** smooth value noise: sum of a few sines, roughly -1..1 */
  private noise(t: number, seed: number) {
    return (Math.sin(t * 11.3 + seed) + 0.6 * Math.sin(t * 23.7 + seed * 1.7) + 0.3 * Math.sin(t * 41.1 + seed * 2.9)) / 1.9;
  }

  /** screen-space shake offset (pixels, pre-dpr) for this frame; call once per draw. */
  shakeOffset(): { dx: number; dy: number } {
    const t = this.game.time;
    const amp = this.trauma * this.trauma * 22;
    return { dx: this.kx + this.noise(t, 1.7) * amp, dy: this.ky + this.noise(t, 9.2) * amp };
  }

  // --------------------------------------------------------------- time api
  hitstopMs(ms: number) {
    this.hitstop = Math.max(this.hitstop, ms / 1000);
  }

  /** slow-mo for `sec` seconds at `factor` (e.g. 0.35). */
  triggerSlowmo(sec: number, factor = 0.35) {
    this.slowT = Math.max(this.slowT, sec);
    this.slowFactor = factor;
    this.game.postFx?.setSlowmo(1);
  }

  /** multiplier to apply to real dt for the simulation this frame. */
  timeScale(dtReal: number): number {
    if (this.hitstop > 0) {
      this.hitstop -= dtReal;
      return 0;
    }
    if (this.slowT > 0) {
      this.slowT -= dtReal;
      if (this.slowT <= 0) this.game.postFx?.setSlowmo(0);
      return this.slowFactor;
    }
    return 1;
  }

  // -------------------------------------------------------- floating text
  spawnText(x: number, y: number, text: string, color = '#fff') {
    if (this.texts.length >= TEXT_CAP) this.texts.shift();
    this.texts.push({ x, y, vy: -1.4, life: 1.6, max: 1.6, text, color, size: 0 });
  }

  private updateTexts(dtReal: number) {
    for (const t of this.texts) {
      t.life -= dtReal;
      t.y += t.vy * dtReal;
      t.vy = lerp(t.vy, -0.5, dtReal * 2);
      t.size = Math.min(1, t.size + dtReal * 7); // quick pop-in
    }
    this.texts = this.texts.filter((t) => t.life > 0);
  }

  drawTexts(ctx: CanvasRenderingContext2D) {
    ctx.textAlign = 'center';
    ctx.lineWidth = 0.09;
    for (const t of this.texts) {
      const fade = Math.min(1, t.life / (t.max * 0.4));
      const pop = 1 + (1 - t.size) * 0.6; // overshoot on pop-in
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.scale(t.size * pop * 0.42, t.size * pop * 0.42);
      ctx.globalAlpha = fade;
      ctx.font = 'bold 1.6px sans-serif';
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(t.text, 0, 0);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------- combo/style
  /** register a style event: banks `cash` (base, scaled by the combo mult when it expires). */
  event(label: string, cash: number, worldX?: number, worldY?: number) {
    const c = this.combo;
    c.mult = Math.min(5, c.mult + 1);
    c.timer = COMBO_WINDOW;
    c.label = label;
    this.comboCash += cash;
    if (worldX !== undefined && worldY !== undefined) this.spawnText(worldX, worldY, label, '#ffd740');
  }

  private updateCombo(dtReal: number) {
    if (this.combo.timer <= 0) return;
    this.combo.timer -= dtReal;
    if (this.combo.timer <= 0) {
      if (this.comboCash > 0) {
        const payout = Math.round(this.comboCash * this.combo.mult);
        this.game.addMoney(payout);
        this.game.message('', `Combo x${this.combo.mult} +${payout}€`, 2, '#ffd740');
      }
      this.combo.mult = 1;
      this.combo.label = '';
      this.comboCash = 0;
    }
  }

  /** sustained drift & near-miss scoring; cheap O(vehicles) scan, once per frame. */
  private updateStyle(dt: number) {
    const g = this.game;
    const pv = g.player.vehicle;
    if (!pv || pv.wrecked) return;
    // sustained drift
    if (pv.skid > 0.4 && pv.speed > 6) {
      const d = (this.driftDur.get(pv) ?? 0) + dt;
      this.driftDur.set(pv, d);
      if (d > 0.6 && Math.random() < dt * 2) {
        pv.addNitro(dt * 0.15);
        if (Math.random() < dt) this.event(`DRIFT ×${(d * pv.speed * 0.05).toFixed(1)}`, Math.round(d * pv.speed), pv.x, pv.y - 2);
      }
    } else this.driftDur.delete(pv);
    // near misses vs other moving vehicles
    if (pv.speed > 12) {
      for (const v of g.vehicles) {
        if (v === pv || v.wrecked) continue;
        const cd = this.nearMissCd.get(v) ?? 0;
        if (cd > 0) {
          this.nearMissCd.set(v, cd - dt);
          continue;
        }
        const d = dist(pv.x, pv.y, v.x, v.y);
        const gap = d - pv.radius - v.radius;
        if (gap > 0 && gap < 1.2 && v.speed > 1) {
          this.nearMissCd.set(v, 1.5);
          pv.addNitro(0.06);
          this.event('NEAR MISS', 20, (pv.x + v.x) / 2, (pv.y + v.y) / 2 - 2);
        }
      }
    }
  }

  /** call once per frame from Game.update, after the sim step. dtReal drives UI/combo, unaffected by hit-stop. */
  tick(dtReal: number, dtSim: number) {
    this.trauma = Math.max(0, this.trauma - dtReal * 1.8);
    this.kx = lerp(this.kx, 0, Math.min(1, dtReal * 9));
    this.ky = lerp(this.ky, 0, Math.min(1, dtReal * 9));
    this.zoomPunch = Math.max(0, this.zoomPunch - dtReal * 2.2);
    this.updateTexts(dtReal);
    this.updateCombo(dtReal);
    this.updateStyle(dtSim);
  }

  // ------------------------------------------------------------ event hooks
  /** a hard vehicle impact: shake, hit-stop, and (near the player) a postFx pulse. */
  crashImpact(v: Vehicle, impact: number, nx: number, ny: number) {
    const g = this.game;
    if (!v.isPlayer && dist(v.x, v.y, g.player.x, g.player.y) > 45) return;
    this.addTrauma(Math.min(1, impact / 30));
    this.kick(nx, ny, Math.min(14, impact * 0.4));
    if (impact > 12) {
      this.hitstopMs(clamp(40 + impact * 2, 40, 90));
      this.punchZoom(Math.min(0.35, impact / 40));
    }
    const scr = g.worldToScreen(v.x, v.y);
    g.postFx?.pulse({ aberration: Math.min(1, impact / 24) });
    g.postFx?.shockwave(scr.x * g.dpr, scr.y * g.dpr, Math.min(1, impact / 25));
  }

  takedown(x: number, y: number) {
    this.addTrauma(0.5);
    this.event('TAKEDOWN!', 60, x, y - 2);
  }

  kill(x: number, y: number, label: string, cash: number) {
    this.event(label, cash, x, y - 2);
  }

  cashText(x: number, y: number, amount: number) {
    this.spawnText(x, y - 1, `+€${amount}`, '#69f0ae');
  }

  explosionNearPlayer(x: number, y: number) {
    const g = this.game;
    const d = dist(x, y, g.player.x, g.player.y);
    this.addTrauma(clamp(1.1 - d / 30, 0, 1));
    this.kick((g.player.x - x) || 0.01, (g.player.y - y) || 0.01, clamp(16 - d * 0.3, 0, 16));
    this.hitstopMs(d < 15 ? 80 : 40);
    if (d < 25) this.triggerSlowmo(0.7, 0.35);
    const scr = g.worldToScreen(x, y);
    g.postFx?.shockwave(scr.x * g.dpr, scr.y * g.dpr, clamp(1.3 - d / 25, 0, 1));
  }
}
