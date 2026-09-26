// A queue of city-wide announcements ("HORÚCA KOFOLKA" / "Dodávka plná peňazí pri Eurovei!"), shown
// one at a time, top-centre, sliding and fading in and out. `game.banners` is the single instance
// (see Game.ts): `update(dt)` every frame, `draw` after the features' `drawHud`.
// Plan: docs/plans/social-events.md
import { roundRect } from '../../render/shapes';
import { outlined } from '../Hud';
import { mapMarker, type MapIcon } from '../MapView';
import { bandHeight, type HudLayout } from '../layout';

const HEAD = `'Rajdhani', 'Arial Black', Impact, sans-serif`;
const BODY = `'Inter', system-ui, sans-serif`;
const GOLD = '#ffd600';
/** seconds to slide/fade in, and again to slide/fade out */
const SLIDE = 0.35;

export interface BannerOpts {
  title: string;
  text?: string;
  color?: string;
  icon?: MapIcon;
  /** seconds shown at full opacity, excluding the slide in/out (default 4) */
  time?: number;
  /** a banner already showing is replaced right away by one with a strictly higher priority (default
   *  0); the pre-empted banner goes back to the front of the queue and plays later, from the start. */
  priority?: number;
}

interface Item {
  title: string;
  text: string;
  color: string;
  icon?: MapIcon;
  time: number;
  priority: number;
}

type Phase = 'in' | 'hold' | 'out';

/** y just below the top-right HUD panel (Hud.ts's money/stars/clock box): where this banner slot
 *  starts, so it never overlaps that panel (on a touch screen: the gap beside it, see layout.ts). */
export function bandTop(L: HudLayout): number {
  return L.band.top;
}

/** bottom of the banner slot at a banner's tallest (title + up to two lines of body text): where
 *  other persistent top-centre panels (Jobs objective, Race challenge/timer) should start instead,
 *  so they stack below a banner rather than fighting it for the same band. */
export function bandBottom(L: HudLayout): number {
  return bandTop(L) + bandHeight(L.small);
}

export class Banners {
  private queue: Item[] = [];
  private cur: Item | null = null;
  private phase: Phase = 'in';
  private t = 0;

  push(opts: BannerOpts) {
    const item: Item = { title: opts.title, text: opts.text ?? '', color: opts.color ?? GOLD, icon: opts.icon, time: opts.time ?? 4, priority: opts.priority ?? 0 };
    if (this.cur && item.priority > this.cur.priority) {
      this.queue.unshift(this.cur); // pre-empted, not dropped: it resumes later, from the start
      this.cur = item;
      this.phase = 'in';
      this.t = 0;
      return;
    }
    this.queue.push(item);
    if (!this.cur) this.advance();
  }

  private advance() {
    this.cur = this.queue.shift() ?? null;
    this.phase = 'in';
    this.t = 0;
  }

  /** the banner on screen right now, or null */
  get current(): Readonly<Item> | null {
    return this.cur;
  }
  /** how many more are queued behind it */
  get pending() {
    return this.queue.length;
  }

  update(dt: number) {
    if (!this.cur) return;
    this.t += dt;
    if (this.phase === 'in' && this.t >= SLIDE) (this.phase = 'hold'), (this.t = 0);
    else if (this.phase === 'hold' && this.t >= this.cur.time) (this.phase = 'out'), (this.t = 0);
    else if (this.phase === 'out' && this.t >= SLIDE) this.advance();
  }

  draw(ctx: CanvasRenderingContext2D, L: HudLayout) {
    const b = this.cur;
    if (!b) return;
    const k = this.phase === 'in' ? ease(this.t / SLIDE) : this.phase === 'out' ? 1 - ease(this.t / SLIDE) : 1;
    if (k <= 0) return;
    const viewW = L.W;
    const small = L.small;
    ctx.save();
    ctx.font = `700 ${small ? 15 : 18}px ${HEAD}`;
    const bodyFont = `600 ${small ? 12 : 13}px ${BODY}`;
    ctx.font = bodyFont;
    const w = Math.min(viewW - 32, small ? 300 : 440, L.band.w);
    const iconSize = b.icon ? (small ? 16 : 20) : 0;
    const textW = w - 28 - (iconSize ? iconSize * 2 + 8 : 0);
    const lines = b.text ? wrap(ctx, b.text, textW) : [];
    const h = (small ? 30 : 36) + lines.length * (small ? 15 : 17);
    const x = L.band.cx - w / 2;
    // below the top HUD panel (Hud.ts's money/stars/clock box), so it never overlaps it
    const y0 = bandTop(L);
    const y = y0 - (1 - k) * (h + 24);
    ctx.globalAlpha = k;
    roundRect(ctx, x, y, w, h, Math.min(12, h / 2));
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, 'rgba(32,34,42,0.86)');
    grad.addColorStop(1, 'rgba(10,11,15,0.9)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 1.5;
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, Math.min(11, h / 2 - 1));
    ctx.stroke();
    let tx = x + 14;
    if (b.icon) {
      mapMarker(ctx, x + 14 + iconSize / 2, y + h / 2, iconSize / 2, b.icon);
      tx += iconSize + 10;
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `700 ${small ? 15 : 18}px ${HEAD}`;
    outlined(ctx, b.title, tx, y + (small ? 6 : 8), '#fff', 3);
    ctx.font = bodyFont;
    lines.forEach((l, i) => outlined(ctx, l, tx, y + (small ? 24 : 28) + i * (small ? 15 : 17), '#cfd8dc', 2.5));
    ctx.restore();
  }
}

function ease(t: number) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}
