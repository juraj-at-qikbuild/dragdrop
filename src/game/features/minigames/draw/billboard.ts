// Bilbordová vojna's own drawing (games/billboard.ts): the campaigns' posters on the billboards
// themselves (up on the board, where the parody ads are), on the bus shelters' roofs and round the
// advertising columns, with a moustache on the defaced ones; and on the map, each spot's campaign
// colour under its icon (the marks' icons alone look the same for both sides). The state's `x.f` is
// the spots, flat [furniture index, state, …] (0 free, 1/2 red's/blue's, 3/4 red's/blue's with a
// moustache), `x.c` the candidate red campaigns for.
import type { Game } from '../../../Game';
import type { View } from '../../../../world/Renderer';
import type { MiniState } from '../../../../shared/sim/rules/minigames/types';
import { CANDIDATES, TEAM_COLORS } from '../../../../shared/sim/rules/minigames/games/billboard';
import type { MiniDrawer } from './index';

const HEAD = `'Rajdhani', 'Arial Black', Impact, sans-serif`;

/** each spot with a poster on it: its furniture index, the campaign, moustached */
function posters(s: MiniState): { i: number; team: number; defaced: boolean }[] {
  const f = s.x?.f;
  if (!Array.isArray(f)) return [];
  const out: { i: number; team: number; defaced: boolean }[] = [];
  for (let k = 0; k + 1 < f.length; k += 2) if (f[k + 1] > 0) out.push({ i: f[k], team: (f[k + 1] - 1) % 2, defaced: f[k + 1] > 2 });
  return out;
}

/** the candidate a campaign pastes */
function candidate(s: MiniState, team: number) {
  const c = typeof s.x?.c === 'number' ? s.x.c : 0;
  return CANDIDATES[team === 0 ? c : 1 - c];
}

/** A moustache, a handlebar one, `w` wide at (x, y) (in whatever space it's drawn in; `up` is +1
 *  where y grows upwards, as on a board). */
function moustache(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, up = 1) {
  const h = w * 0.28 * up;
  ctx.fillStyle = '#111';
  ctx.beginPath();
  // each half from the middle out to its curled tip and back
  for (const side of [-1, 1]) {
    ctx.moveTo(x, y + h * 0.3);
    ctx.bezierCurveTo(x + side * w * 0.2, y + h * 0.9, x + side * w * 0.4, y + h * 0.4, x + side * w * 0.5, y + h);
    ctx.bezierCurveTo(x + side * w * 0.42, y - h * 0.2, x + side * w * 0.15, y - h * 0.5, x, y - h * 0.1);
  }
  ctx.fill();
}

/** the poster on a billboard's board: the same board StreetDetail draws, 3.6 m by 2.6 m, from 2.4
 *  m to 5 m up, leaning away from the camera like the buildings */
function onBoard(ctx: CanvasRenderingContext2D, g: Game, v: View, s: MiniState, x: number, y: number, a: number, team: number, defaced: boolean) {
  const lift = (px: number, py: number, h: number) => g.renderer.roofOffset(px, py, h, v);
  const L = 3.6, H = 2.6;
  // along the board, from the end on the viewer's left: seen from its back, the other way round, so
  // the poster never reads mirrored (a campaign pastes both sides)
  let ux = -Math.sin(a), uy = Math.cos(a);
  const toCam = (v.camX - x) * Math.cos(a) + (v.camY - y) * Math.sin(a);
  if (toCam > 0) (ux = -ux), (uy = -uy);
  const x0 = x - ux * (L / 2), y0 = y - uy * (L / 2), x1 = x + ux * (L / 2), y1 = y + uy * (L / 2);
  const [b0x, b0y] = lift(x0, y0, 2.4), [b1x, b1y] = lift(x1, y1, 2.4), [t0x, t0y] = lift(x0, y0, 5);
  const ax = x0 + b0x, ay = y0 + b0y;
  ctx.save();
  // board metres: u along it, v up it
  ctx.transform((x1 + b1x - ax) / L, (y1 + b1y - ay) / L, (x0 + t0x - ax) / H, (y0 + t0y - ay) / H, ax, ay);
  ctx.fillStyle = TEAM_COLORS[team];
  ctx.fillRect(0, 0, L, H);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 0.08;
  ctx.strokeRect(0.12, 0.12, L - 0.24, H - 0.24);
  // the candidate's smiling face on the left
  ctx.fillStyle = '#f1c9a5';
  ctx.beginPath();
  ctx.arc(0.75, 1.3, 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3b2a1c';
  ctx.beginPath();
  ctx.arc(0.75, 1.42, 0.5, 0.25, Math.PI - 0.25);
  ctx.fill();
  ctx.fillStyle = '#222';
  for (const ex of [0.58, 0.92]) ctx.fillRect(ex - 0.05, 1.3, 0.1, 0.1);
  if (defaced) moustache(ctx, 0.75, 1.08, 0.62);
  else {
    ctx.strokeStyle = '#8d3a2a';
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    ctx.arc(0.75, 1.2, 0.2, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }
  // the name and the slogan on the right (letters stand up the board, read along it)
  const c = candidate(s, team);
  const text = (t: string, cx: number, cy: number, size: number, maxW: number) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, -1);
    ctx.font = `900 ${size}px ${HEAD}`;
    const fit = Math.min(1, maxW / Math.max(0.01, ctx.measureText(t).width));
    ctx.scale(fit, fit);
    ctx.fillText(t, 0, 0);
    ctx.restore();
  };
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  text(c.short.toUpperCase(), 2.3, 1.62, 0.62, 2.1);
  text(c.slogan, 2.3, 0.85, 0.3, 2.1);
  if (defaced) {
    // and a scribble across the slogan for good measure
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 0.09;
    ctx.beginPath();
    ctx.moveTo(1.4, 0.7);
    ctx.bezierCurveTo(1.9, 1.1, 2.4, 0.5, 3.2, 1.0);
    ctx.stroke();
  }
  ctx.restore();
}

export const BILLBOARD_DRAW: MiniDrawer = {
  world(ctx, s, v, g) {
    if (v.scale < 2) return;
    const f = g.world.furniture;
    for (const { i, team, defaced } of posters(s)) {
      const x = f[i], y = f[i + 1], a = f[i + 2], kind = f[i + 3];
      if (x < v.x0 - 10 || x > v.x1 + 10 || y < v.y0 - 10 || y > v.y1 + 10) continue;
      if (kind === 5) {
        onBoard(ctx, g, v, s, x, y, a, team, defaced);
        continue;
      }
      // a bus shelter: a poster laid on its roof, 2.5 m up; an advertising column: a band round it
      const [ox, oy] = g.renderer.roofOffset(x, y, kind === 4 ? 2.55 : 2.2, v);
      ctx.save();
      ctx.translate(x + ox, y + oy);
      if (kind === 4) {
        // along the roof, the way that reads left to right on the screen
        const rot = a + Math.PI / 2;
        ctx.rotate(Math.cos(rot) < 0 ? rot + Math.PI : rot);
        ctx.fillStyle = TEAM_COLORS[team];
        ctx.fillRect(-1.3, -0.55, 2.6, 1.1);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 0.07;
        ctx.strokeRect(-1.2, -0.45, 2.4, 0.9);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `900 0.5px ${HEAD}`;
        const t = candidate(s, team).short.toUpperCase();
        const fit = Math.min(1, 2.2 / Math.max(0.01, ctx.measureText(t).width));
        ctx.scale(fit, fit);
        ctx.fillText(t, 0, 0.02);
        if (defaced) moustache(ctx, 0, 0.05, 1.3 / fit, -1);
      } else {
        ctx.strokeStyle = TEAM_COLORS[team];
        ctx.lineWidth = 0.35;
        ctx.beginPath();
        ctx.arc(0, 0, 0.62, 0, Math.PI * 2);
        ctx.stroke();
        if (defaced) moustache(ctx, 0, 0, 0.9, -1);
      }
      ctx.restore();
    }
  },

  map(ctx, s, toScreen, _full, size, g) {
    const f = g.world.furniture, sp = s.x?.f;
    if (!Array.isArray(sp)) return;
    // a disc round each icon, wider than the icon itself: the campaign's colour, grey for a free
    // spot, dark ringed in the campaign's colour for a moustached poster
    const r = Math.max(6.5, size * 1.35);
    ctx.save();
    for (let k = 0; k + 1 < sp.length; k += 2) {
      const i = sp[k], st = sp[k + 1];
      const [x, y] = toScreen(f[i], f[i + 1]);
      const color = st === 0 ? '#cfd8dc' : TEAM_COLORS[(st - 1) % 2];
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.globalAlpha = st === 0 ? 0.3 : st > 2 ? 0.8 : 0.55;
      ctx.fillStyle = st > 2 ? '#141414' : color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = st === 0 ? 1 : 2.2;
      ctx.stroke();
    }
    ctx.restore();
  },
};
