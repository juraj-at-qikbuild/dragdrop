// Name tags over other players, drawn in world space at a constant on-screen size (like the landmark
// labels): nickname plus one star per wanted level, red-tinted while they're wanted.
import type { View } from '../world/Renderer';

export interface TagSource {
  tagFor(playerId: number): { nick: string; wanted: number } | null;
}

interface Tagged {
  x: number;
  y: number;
  playerId: number;
  vehicle: { x: number; y: number; radius: number } | null;
}

export function drawNametags(ctx: CanvasRenderingContext2D, src: TagSource, peds: readonly Tagged[], v: View, meId: number) {
  const fs = 12 / v.scale;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${fs}px system-ui, sans-serif`;
  for (const p of peds) {
    if (!p.playerId || p.playerId === meId) continue;
    const car = p.vehicle;
    const x = car ? car.x : p.x;
    const y = (car ? car.y - car.radius * 0.8 : p.y - 0.9) - fs * 1.1;
    if (x < v.x0 - 10 || x > v.x1 + 10 || y < v.y0 - 10 || y > v.y1 + 10) continue;
    const tag = src.tagFor(p.playerId);
    if (!tag) continue;
    const stars = tag.wanted > 0 ? ' ' + '★'.repeat(Math.min(5, tag.wanted)) : '';
    const label = tag.nick + stars;
    const w = ctx.measureText(label).width;
    const h = fs * 1.45;
    ctx.fillStyle = tag.wanted > 0 ? 'rgba(90,10,14,0.72)' : 'rgba(10,12,16,0.6)';
    pill(ctx, x - w / 2 - fs * 0.45, y - h / 2, w + fs * 0.9, h, h / 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(tag.nick, x - (stars ? ctx.measureText(stars).width / 2 : 0), y + fs * 0.04);
    if (stars) {
      ctx.fillStyle = '#ffd740';
      ctx.fillText(stars, x + w / 2 - ctx.measureText(stars).width / 2, y + fs * 0.04);
    }
  }
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
