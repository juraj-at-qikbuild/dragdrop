// Name tags over other players, drawn in world space at a constant on-screen size (like the landmark
// labels): nickname plus one star per wanted level, red-tinted while they're wanted. Social features
// (party, voice, downed…) hook in through `addNametagDecorator` rather than editing this file.
// Plan: docs/plans/social-events.md
import type { View } from '../world/Renderer';

export interface TagSource {
  tagFor(playerId: number): { nick: string; wanted: number; partyId: number; flags: number } | null;
}

/** prefix: shown before the nick (e.g. "[FERO]"); pillColor overrides the name tag's background;
 *  icons are small glyphs appended after the wanted stars (e.g. '🎙', '✚'). */
export interface NametagDecoration {
  prefix?: string;
  prefixColor?: string;
  pillColor?: string;
  icons?: string[];
}

type Decorator = (playerId: number, tag: { nick: string; wanted: number; partyId: number; flags: number }) => NametagDecoration | null;

const decorators: Decorator[] = [];

/** Registers a nametag decorator; every one runs for every tagged player each frame and their
 *  results are merged (a later decorator's prefix/prefixColor/pillColor wins over an earlier one's,
 *  icons from all of them append together). With none registered, nametags draw exactly as before. */
export function addNametagDecorator(fn: Decorator) {
  decorators.push(fn);
}

function decorate(playerId: number, tag: { nick: string; wanted: number; partyId: number; flags: number }): NametagDecoration | null {
  if (!decorators.length) return null;
  let out: NametagDecoration | null = null;
  for (const fn of decorators) {
    const d = fn(playerId, tag);
    if (!d) continue;
    out ??= {};
    if (d.prefix !== undefined) out.prefix = d.prefix;
    if (d.prefixColor !== undefined) out.prefixColor = d.prefixColor;
    if (d.pillColor !== undefined) out.pillColor = d.pillColor;
    if (d.icons?.length) out.icons = [...(out.icons ?? []), ...d.icons];
  }
  return out;
}

interface Tagged {
  x: number;
  y: number;
  playerId: number;
  /** -1 in a tunnel */
  level: number;
  vehicle: { x: number; y: number; radius: number } | null;
}

/** `underground`: the viewer is in a tunnel. Players in a tunnel are tagged only for viewers who
 *  are in one too (and players on the surface only for viewers on it), as only they can see them. */
export function drawNametags(ctx: CanvasRenderingContext2D, src: TagSource, peds: readonly Tagged[], v: View, meId: number, underground = false) {
  const fs = 12 / v.scale;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${fs}px system-ui, sans-serif`;
  for (const p of peds) {
    if (!p.playerId || p.playerId === meId || (p.level === -1) !== underground) continue;
    const car = p.vehicle;
    const x = car ? car.x : p.x;
    const y = (car ? car.y - car.radius * 0.8 : p.y - 0.9) - fs * 1.1;
    if (x < v.x0 - 10 || x > v.x1 + 10 || y < v.y0 - 10 || y > v.y1 + 10) continue;
    const tag = src.tagFor(p.playerId);
    if (!tag) continue;
    const deco = decorate(p.playerId, tag);
    const stars = tag.wanted > 0 ? ' ' + '★'.repeat(Math.min(5, tag.wanted)) : '';
    const prefix = deco?.prefix ? deco.prefix + ' ' : '';
    const icons = deco?.icons?.length ? ' ' + deco.icons.join('') : '';
    // left-to-right segments so each can take its own colour; with no decorator this is exactly the
    // original nick + stars layout, just measured/drawn segment by segment instead of as one string.
    const segs: [string, string][] = [[prefix, deco?.prefixColor ?? '#ffd740'], [tag.nick, '#ffffff'], [stars, '#ffd740'], [icons, '#ffffff']];
    const w = segs.reduce((sum, [t]) => sum + (t ? ctx.measureText(t).width : 0), 0);
    const h = fs * 1.45;
    ctx.fillStyle = deco?.pillColor ?? (tag.wanted > 0 ? 'rgba(90,10,14,0.72)' : 'rgba(10,12,16,0.6)');
    pill(ctx, x - w / 2 - fs * 0.45, y - h / 2, w + fs * 0.9, h, h / 2);
    ctx.fill();
    let cx = x - w / 2;
    for (const [t, color] of segs) {
      if (!t) continue;
      ctx.fillStyle = color;
      ctx.fillText(t, cx, y + fs * 0.04);
      cx += ctx.measureText(t).width;
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
