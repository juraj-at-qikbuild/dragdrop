import type { View } from './Renderer';
import type { Atmosphere } from './Atmosphere';

const SPRITE = 64;

/**
 * Screen-space light map. Each frame it is cleared to the ambient colour, lights
 * are added on top ('lighter'), and the result is multiplied over the world.
 * Strong lights can additionally request a `glow`, which is drawn additively on
 * the main canvas so bright sources bloom even in daylight.
 *
 * All public drawing methods take WORLD coordinates in metres.
 */
export class LightLayer {
  readonly canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private sprites = new Map<string, HTMLCanvasElement>();
  private cones = new Map<string, HTMLCanvasElement>();
  private glows: { x: number; y: number; r: number; color: string; a: number }[] = [];
  /** fraction of the screen resolution the light map is rendered at */
  res = 0.5;
  /** false when nothing needs to be composited this frame */
  active = false;
  /** 0..1 how dark it is; emitters can use it to fade in lamps */
  night = 0;
  private v!: View;

  /** Start a frame. `w`, `h` are CSS pixels of the viewport. */
  begin(v: View, w: number, h: number, atmos: Atmosphere) {
    this.v = v;
    this.night = atmos.night;
    this.glows.length = 0;
    this.active = atmos.tinted;
    const cw = Math.max(1, Math.round(w * this.res)), ch = Math.max(1, Math.round(h * this.res));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.fillStyle = atmos.ambientCss();
    c.fillRect(0, 0, cw, ch);
    const s = v.scale * this.res;
    c.setTransform(s, 0, 0, s, cw / 2 - v.camX * s, ch / 2 - v.camY * s);
    c.globalCompositeOperation = 'lighter';
  }

  /** is a world point (with radius) on screen? */
  visible(x: number, y: number, r: number) {
    const v = this.v;
    return x + r > v.x0 && x - r < v.x1 && y + r > v.y0 && y - r < v.y1;
  }

  /** Round soft light. `color` is any CSS colour, intensity 0..1+. */
  point(x: number, y: number, r: number, color: string, intensity = 1) {
    if (intensity <= 0.01 || !this.visible(x, y, r)) return;
    const c = this.ctx;
    c.globalAlpha = Math.min(1, intensity);
    c.drawImage(this.sprite(color), x - r, y - r, r * 2, r * 2);
    if (intensity > 1) {
      c.globalAlpha = Math.min(1, intensity - 1);
      c.drawImage(this.sprite(color), x - r * 0.6, y - r * 0.6, r * 1.2, r * 1.2);
    }
  }

  /** Cone of light (headlights). Starts at x,y and points along `angle`. */
  cone(x: number, y: number, angle: number, len: number, spread: number, color: string, intensity = 1) {
    if (intensity <= 0.01 || !this.visible(x, y, len)) return;
    const c = this.ctx;
    c.save();
    c.globalAlpha = Math.min(1, intensity);
    c.translate(x, y);
    c.rotate(angle);
    c.scale(len, len * Math.tan(spread) * 2);
    c.drawImage(this.coneSprite(color), 0, -0.5, 1, 1);
    c.restore();
  }

  /** Additive bloom drawn straight onto the main canvas (visible by day too). */
  glow(x: number, y: number, r: number, color: string, a = 0.6) {
    if (a <= 0.01 || !this.visible(x, y, r)) return;
    this.glows.push({ x, y, r, color, a });
  }

  /**
   * Multiply the light map over the world. `ctx` must currently hold the world
   * transform; it is restored afterwards.
   */
  composite(ctx: CanvasRenderingContext2D, dpr: number, w: number, h: number) {
    ctx.save();
    if (this.active) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(this.canvas, 0, 0, w, h);
    }
    ctx.restore();
    if (this.glows.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const g of this.glows) {
        ctx.globalAlpha = Math.min(1, g.a);
        ctx.drawImage(this.sprite(g.color), g.x - g.r, g.y - g.r, g.r * 2, g.r * 2);
      }
      ctx.restore();
    }
  }

  private sprite(color: string) {
    let s = this.sprites.get(color);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = s.height = SPRITE;
    const c = s.getContext('2d')!;
    const g = c.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
    g.addColorStop(0, color);
    g.addColorStop(0.35, withAlpha(color, 0.55));
    g.addColorStop(1, withAlpha(color, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, SPRITE, SPRITE);
    this.sprites.set(color, s);
    return s;
  }

  private coneSprite(color: string) {
    let s = this.cones.get(color);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = s.height = SPRITE * 2;
    const c = s.getContext('2d')!;
    const S = SPRITE * 2;
    const g = c.createRadialGradient(0, S / 2, 0, 0, S / 2, S);
    g.addColorStop(0, color);
    g.addColorStop(0.5, withAlpha(color, 0.45));
    g.addColorStop(1, withAlpha(color, 0));
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(0, S / 2 - S * 0.04);
    c.lineTo(S, 0);
    c.lineTo(S, S);
    c.lineTo(0, S / 2 + S * 0.04);
    c.closePath();
    c.filter = 'blur(4px)';
    c.fill();
    this.cones.set(color, s);
    return s;
  }
}

/** Anything that contributes lights each frame. */
export interface LightEmitter {
  emitLights(L: LightLayer): void;
}

const alphaCache = new Map<string, string>();
/** '#rrggbb' or 'rgb(r,g,b)' → rgba with the given alpha */
export function withAlpha(color: string, a: number) {
  const key = color + a;
  let r = alphaCache.get(key);
  if (r) return r;
  let rr = 255, gg = 255, bb = 255;
  if (color.startsWith('#')) {
    const n = parseInt(color.length === 4 ? color.replace(/#(.)(.)(.)/, '$1$1$2$2$3$3') : color.slice(1, 7), 16);
    (rr = n >> 16), (gg = (n >> 8) & 255), (bb = n & 255);
  } else {
    const m = color.match(/[\d.]+/g);
    if (m) (rr = +m[0]), (gg = +m[1]), (bb = +m[2]);
  }
  r = `rgba(${rr},${gg},${bb},${a})`;
  alphaCache.set(key, r);
  return r;
}
