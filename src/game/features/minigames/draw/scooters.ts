// Kolobežky všade's own drawing (games/scooters.ts): the fridge, standing where it waits (`x.fx`,
// `x.fy`) or upright on the deck of the scooter carrying it (`x.fv`, the vehicle's id), swaying as
// it goes, like the one in this summer's viral clip. A white box leaning away from the camera like
// the buildings do.
import type { Game } from '../../../Game';
import type { View } from '../../../../world/Renderer';
import type { MiniDrawer } from './index';

/** the fridge's footprint (m) and height: a big one, as in the clip */
const W = 0.72, D = 0.7, H = 1.8;

function fridge(ctx: CanvasRenderingContext2D, g: Game, v: View, x: number, y: number, a: number, sway: number) {
  const [ox, oy] = g.renderer.roofOffset(x, y, H, v);
  // the top swings a little from side to side while it rides
  const sx = ox - Math.sin(a) * sway, sy = oy + Math.cos(a) * sway;
  const c = Math.cos(a), s = Math.sin(a);
  const corner = (u: number, w: number, dx = 0, dy = 0): [number, number] => [x + c * u - s * w + dx, y + s * u + c * w + dy];
  const base = [corner(-D / 2, -W / 2), corner(D / 2, -W / 2), corner(D / 2, W / 2), corner(-D / 2, W / 2)];
  const top = [corner(-D / 2, -W / 2, sx, sy), corner(D / 2, -W / 2, sx, sy), corner(D / 2, W / 2, sx, sy), corner(-D / 2, W / 2, sx, sy)];
  ctx.save();
  // its shadow, then the sides (the hull between the foot and the top), then the top
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  base.forEach(([px, py], k) => (k ? ctx.lineTo(px + 0.25, py + 0.3) : ctx.moveTo(px + 0.25, py + 0.3)));
  ctx.fill();
  ctx.fillStyle = '#d7dde0';
  ctx.strokeStyle = 'rgba(40,44,48,0.8)';
  ctx.lineWidth = 0.04;
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = base[k], [bx, by] = base[(k + 1) % 4], [cx, cy] = top[(k + 1) % 4], [dx, dy] = top[k];
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(cx, cy);
    ctx.lineTo(dx, dy);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = '#f7f9fa';
  ctx.beginPath();
  top.forEach(([px, py], k) => (k ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // the door's handle, on the front edge of the top
  const [h0x, h0y] = corner(D / 2 - 0.06, -W / 2 + 0.1, sx, sy), [h1x, h1y] = corner(D / 2 - 0.06, W / 2 - 0.25, sx, sy);
  ctx.strokeStyle = '#90a4ae';
  ctx.lineWidth = 0.06;
  ctx.beginPath();
  ctx.moveTo(h0x, h0y);
  ctx.lineTo(h1x, h1y);
  ctx.stroke();
  ctx.restore();
}

export const SCOOTERS_DRAW: MiniDrawer = {
  // on the map a scooter's or a dock's icon alone is lost among the Old Town's (and a dock's 🅿️
  // looks like any car park's): a disc under each, the scooter's in the colour of its countdown,
  // the docks' blue
  map(ctx, s, toScreen, _full, size, g) {
    const r = Math.max(5.5, size * 1.2);
    ctx.save();
    for (const m of s.marks ?? []) {
      if (m.icon !== '🛴' && m.icon !== '🅿️') continue;
      const car = m.e ? g.host.vehicleById(m.e) : null;
      const [x, y] = toScreen(car?.x ?? m.x, car?.y ?? m.y);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = m.color ?? '#34d186';
      ctx.globalAlpha = m.icon === '🛴' ? 0.85 : 0.6;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = m.icon === '🛴' ? 'rgba(0,0,0,0.75)' : '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  },

  world(ctx, s, v, g) {
    const x = s.x;
    if (!x) return;
    if (typeof x.fv === 'number') {
      const car = g.host.vehicleById(x.fv);
      if (!car) return;
      // on the deck in front of the rider
      const fx = car.x + Math.cos(car.angle) * 0.2, fy = car.y + Math.sin(car.angle) * 0.2;
      fridge(ctx, g, v, fx, fy, car.angle, Math.sin(g.time * 3.1) * 0.12 * Math.min(1, car.speed / 2));
    } else if (typeof x.fx === 'number' && typeof x.fy === 'number') fridge(ctx, g, v, x.fx, x.fy, 0.4, 0);
  },
};
