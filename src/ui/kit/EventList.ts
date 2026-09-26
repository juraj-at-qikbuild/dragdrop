// A compact stack of active-event rows (icon, label, an mm:ss countdown, a value like "$1 200"), for
// world-event / job / race summaries in the HUD. Meant for the right side near the minimap (see
// `drawMini`'s placement in Hud.ts); `x, y` is the block's anchor corner per `align`.
// Plan: docs/plans/social-events.md
import { outlined } from '../Hud';
import { mapMarker, type MapIcon } from '../MapView';

const BODY = `'Inter', system-ui, sans-serif`;
const ROW_H = 22;
/** a row's height, for callers that reserve room for the list */
export const EVENT_ROW_H = ROW_H;
const ICON_R = 8;
const GAP = 6;

export interface EventRow {
  icon: MapIcon;
  label: string;
  /** a countdown, shown as mm:ss */
  secs?: number;
  /** a formatted amount ("$1 200") or other trailing detail */
  value?: string;
  color: string;
  /** flashes gently to draw the eye (e.g. a bounty about to expire) */
  pulse?: boolean;
}

/** Draws `rows` stacked from (x, y) downward and returns the total height, so callers can stack
 *  another block right below it. `align: 'right'` anchors each row's icon at `x` and grows the text
 *  leftward (for the HUD's right edge); `'left'` anchors the icon at `x` and grows rightward. */
export function drawEventList(ctx: CanvasRenderingContext2D, x: number, y: number, rows: EventRow[], align: 'left' | 'right'): number {
  if (!rows.length) return 0;
  const dir = align === 'left' ? 1 : -1;
  ctx.save();
  ctx.font = `700 12px ${BODY}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  rows.forEach((row, i) => {
    const cy = y + i * ROW_H + ROW_H / 2;
    ctx.globalAlpha = row.pulse ? 0.55 + 0.45 * Math.sin((performance.now() / 1000) * 7) : 1;
    const ix = x + dir * ICON_R;
    mapMarker(ctx, ix, cy, ICON_R, row.icon);
    const tx = ix + dir * (ICON_R + GAP);
    const parts = [row.label];
    if (row.secs !== undefined) parts.push(fmtTime(row.secs));
    if (row.value !== undefined) parts.push(row.value);
    outlined(ctx, parts.join('  ·  '), tx, cy, row.color, 3);
  });
  ctx.restore();
  return rows.length * ROW_H;
}

function fmtTime(s: number): string {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
