// Speech bubbles over people's heads (client only): what they just said (SimEvents.say), for a
// couple of seconds, following them as they move, drawn in world space at a constant on-screen
// size like the name tags.
import type { View } from '../world/Renderer';
import { lineText } from '../shared/sim/phrases';

interface Bubble {
  id: number;
  text: string;
  t: number;
  x: number;
  y: number;
}

/** how long a bubble stays up (s) */
const LIFE = 2.8;
/** at most this many at once (the newest win) */
const MAX = 10;

export class Bubbles {
  private list: Bubble[] = [];

  add(id: number, x: number, y: number, line: number) {
    const text = lineText(line);
    if (!text) return;
    // one bubble per person: a new line replaces the last
    this.list = this.list.filter((b) => b.id !== id);
    this.list.push({ id, text, t: 0, x, y });
    if (this.list.length > MAX) this.list.shift();
  }

  /** age the bubbles and move them along with whoever said them (`pos` null: gone, stays put) */
  update(dt: number, pos: (id: number) => { x: number; y: number } | null) {
    for (const b of this.list) {
      b.t += dt;
      const p = pos(b.id);
      if (p) (b.x = p.x), (b.y = p.y);
    }
    if (this.list.some((b) => b.t >= LIFE)) this.list = this.list.filter((b) => b.t < LIFE);
  }

  draw(ctx: CanvasRenderingContext2D, v: View) {
    if (!this.list.length) return;
    const fs = 12.5 / v.scale;
    ctx.save();
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const b of this.list) {
      if (b.x < v.x0 - 10 || b.x > v.x1 + 10 || b.y < v.y0 - 10 || b.y > v.y1 + 10) continue;
      // pop in, fade out
      const a = Math.min(1, b.t / 0.12, (LIFE - b.t) / 0.4);
      const pop = b.t < 0.12 ? 0.85 + (b.t / 0.12) * 0.15 : 1;
      const w = ctx.measureText(b.text).width + fs * 1.1, h = fs * 1.7;
      const x = b.x, y = b.y - 0.9 - fs * 1.9;
      ctx.globalAlpha = a;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(pop, pop);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      bubble(ctx, -w / 2 + fs * 0.12, -h / 2 + fs * 0.14, w, h, fs);
      ctx.fill();
      ctx.fillStyle = '#fbfaf6';
      bubble(ctx, -w / 2, -h / 2, w, h, fs);
      ctx.fill();
      ctx.strokeStyle = 'rgba(30,30,36,0.55)';
      ctx.lineWidth = fs * 0.09;
      ctx.stroke();
      ctx.fillStyle = '#1d1f24';
      ctx.fillText(b.text, 0, fs * 0.04);
      ctx.restore();
    }
    ctx.restore();
  }
}

/** a rounded box with a little tail at the bottom left, pointing down at the speaker */
function bubble(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fs: number) {
  const r = h * 0.45, tx = x + Math.min(w * 0.3, fs * 1.4);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.lineTo(tx + fs * 0.55, y + h);
  ctx.lineTo(tx - fs * 0.15, y + h + fs * 0.75);
  ctx.lineTo(tx, y + h);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
