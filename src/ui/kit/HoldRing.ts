// A circular hold/progress ring (reviving a downed player, accepting a race challenge…), in the
// Hud.ts visual idiom: a dim track, a bright arc for the progress, an outlined label under it.
// Plan: docs/plans/social-events.md
import { outlined } from '../Hud';

const TWO_PI = Math.PI * 2;
const BODY = `'Inter', system-ui, sans-serif`;

/** Screen space (CSS px). `progress` is 0..1, drawn clockwise from the top. */
export function drawHoldRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, progress: number, color: string, label?: string) {
  const p = Math.max(0, Math.min(1, progress));
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, r * 0.22);
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TWO_PI);
  ctx.stroke();
  if (p > 0) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + TWO_PI * p);
    ctx.stroke();
  }
  ctx.restore();
  if (!label) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = `700 ${Math.max(10, r * 0.5)}px ${BODY}`;
  outlined(ctx, label, x, y + r + 4, '#fff', 3);
  ctx.restore();
}

/** World space: `rMetres` is a real distance (it scales with the camera, like the thing it marks),
 *  while the stroke stays a constant size on screen via the `k / scale` idiom (src/render/nametags.ts). */
export function worldRing(ctx: CanvasRenderingContext2D, x: number, y: number, rMetres: number, progress: number, color: string, scale: number) {
  const p = Math.max(0, Math.min(1, progress));
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = 3 / scale;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.arc(x, y, rMetres, 0, TWO_PI);
  ctx.stroke();
  if (p > 0) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, rMetres, -Math.PI / 2, -Math.PI / 2 + TWO_PI * p);
    ctx.stroke();
  }
  ctx.restore();
}
