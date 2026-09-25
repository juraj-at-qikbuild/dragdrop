import type { View } from './Renderer';
import type { Atmosphere } from './Atmosphere';
import type { Audio } from '../audio/Audio';
import { rand } from '../shared/util/math';

const RAIN_CAP = 350;
const NEAR_SHARE = 0.55; // fraction of drops in the near (fast) layer
const SPLASH_CAP = 60;

interface Drop {
  x: number; // 0..1 across the screen tile
  y: number; // 0..1 down the screen tile
  len: number; // 0..1 of screen height
  layer: 0 | 1;
}

interface Splash {
  x: number;
  y: number;
  t: number;
  life: number;
}

/**
 * Rain: screen-space streaks (2 parallax layers), world-space ground
 * splashes, a cool desaturating overlay and rare lightning in heavy rain.
 * Reads `atmos.rain` / `atmos.wet`; nothing here mutates Atmosphere.
 */
export class Weather {
  private drops: Drop[] = [];
  private splashes: Splash[] = [];
  private splashTimer = 0;
  private lightning = 0; // current flash alpha, 0..1
  private lightningTimer = rand(10, 22);
  private prevCamX = 0;
  private camOffX = 0; // accumulated camera travel, for streak parallax
  private inited = false;

  private ensureDrops() {
    if (this.drops.length) return;
    for (let i = 0; i < RAIN_CAP; i++) {
      this.drops.push({ x: Math.random(), y: Math.random(), len: rand(0.02, 0.05), layer: i < RAIN_CAP * NEAR_SHARE ? 0 : 1 });
    }
  }

  update(dt: number, atmos: Atmosphere, v: View, quality: number, audio: Audio) {
    if (!this.inited) {
      this.prevCamX = v.camX;
      this.inited = true;
    }
    this.camOffX += v.camX - this.prevCamX;
    this.prevCamX = v.camX;

    audio.rain(atmos.rain);

    if (this.lightning > 0) this.lightning = Math.max(0, this.lightning - dt * 2.4);
    if (atmos.rain > 0.8) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = rand(9, 24);
        this.lightning = 1;
        audio.thunder();
      }
    } else {
      this.lightningTimer = Math.max(this.lightningTimer, 6);
    }

    // ground splash rings, spawned around the view
    if (atmos.rain > 0.12) {
      this.ensureDrops();
      const cap = quality ? SPLASH_CAP : SPLASH_CAP * 0.5;
      this.splashTimer -= dt;
      if (this.splashTimer <= 0 && this.splashes.length < cap) {
        this.splashTimer = 0.05 + 0.18 * (1 - atmos.rain);
        const n = quality ? 2 : 1;
        for (let i = 0; i < n; i++) {
          this.splashes.push({ x: rand(v.x0, v.x1), y: rand(v.y0, v.y1), t: 0, life: rand(0.55, 0.95) });
        }
      }
    }
    for (const s of this.splashes) s.t += dt;
    if (this.splashes.length) this.splashes = this.splashes.filter((s) => s.t < s.life);
  }

  /** World-space ground splash rings; call while the world transform is active. */
  drawWorld(ctx: CanvasRenderingContext2D, atmos: Atmosphere) {
    if (atmos.rain <= 0.05 || !this.splashes.length) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(205,220,235,0.45)';
    ctx.lineWidth = 0.05;
    for (const s of this.splashes) {
      const k = s.t / s.life;
      const r = 0.12 + k * 0.55;
      ctx.globalAlpha = (1 - k) * 0.5 * Math.min(1, atmos.rain * 1.5);
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, r, r * 0.62, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Screen-space rain streaks + cool overlay + lightning flash. CSS pixel space. */
  drawScreen(ctx: CanvasRenderingContext2D, w: number, h: number, atmos: Atmosphere, time: number, quality: number) {
    if (atmos.rain > 0.02) {
      this.ensureDrops();
      const cap = Math.min(RAIN_CAP, Math.round(RAIN_CAP * atmos.rain * (quality ? 1 : 0.55)));
      const slant = 0.16;
      ctx.save();
      for (let layer = 0; layer < 2; layer++) {
        const speed = layer === 0 ? 1150 : 780;
        const parallax = layer === 0 ? 0.9 : 0.35;
        const tile = h * 1.25;
        ctx.beginPath();
        for (let i = 0; i < cap; i++) {
          const d = this.drops[i];
          if (d.layer !== layer) continue;
          let y = (d.y * tile + time * speed) % tile;
          if (y < 0) y += tile;
          let x = (d.x * w + slant * y - this.camOffX * parallax) % w;
          x = ((x % w) + w) % w;
          const len = d.len * h * (layer === 0 ? 1.4 : 0.95);
          ctx.moveTo(x, y);
          ctx.lineTo(x - slant * len, y - len);
        }
        ctx.strokeStyle = layer === 0 ? 'rgba(200,222,238,0.35)' : 'rgba(190,210,228,0.22)';
        ctx.lineWidth = layer === 0 ? 1.4 : 1;
        ctx.globalAlpha = Math.min(1, atmos.rain * 1.15);
        ctx.stroke();
      }
      ctx.restore();

      // cool, slightly desaturating overlay
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgba(60,75,95,${(0.12 * atmos.rain).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    if (this.lightning > 0.01) {
      ctx.save();
      ctx.fillStyle = `rgba(255,255,255,${(this.lightning * 0.5).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }
}
