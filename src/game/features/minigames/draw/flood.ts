// Povodeň's own drawing (games/flood.ts): what its marks can't show. The Danube climbing the promenade
// toward the mobile wall — a band of water from the river's edge to the waterline, wider and lighter as
// the level rises — and the wall itself: its standing sections grey, the panels set in its gaps orange,
// the open gaps between red posts, blinking red as a peak comes; the street behind a breach under
// water; and the panel in the player's hands. On the map, the wall's line. It all comes from the
// state's `x`: `w` each gap's ends (west to east, so inland is to their left), `s` the gaps' states (0
// open, 1 a panel in, 2 a tourist in it, 3 open and the river's been through, 4 a panel in again after
// that: the street behind stays flooded), `lv` how far the river has climbed toward the wall (0..1),
// `hv` the level on the meter (0..1), `d` the wall's distance from the water's edge (m), `c` a panel
// carried, `pk` a peak is near, `dp` the stack of panels (x, y, a).
import type { MiniState } from '../../../../shared/sim/rules/minigames/types';
import type { View } from '../../../../world/Renderer';
import type { Game } from '../../../Game';
import type { MiniDrawer } from './index';
import { miniLeft } from '../../../SimHost';

/** the water runs on this far past the wall's ends (m), fading out */
const EXT = 30;
/** the wall's stubs past its first and last gap (m) */
const STUB = 8;
/** the flooded street behind a breach reaches this far inland (m; the game's zone) */
const BREACH_DEPTH = 24;
/** the open gaps blink this long before a peak (s) */
const WARN_S = 15;

interface Wall {
  pts: number[];
  n: number;
  st: string;
  lv: number;
  hv: number;
  d: number;
  carry: boolean;
}

function wallOf(s: MiniState): Wall | null {
  const x = s.x, w = x?.w;
  if (!x || !Array.isArray(w) || w.length < 8) return null;
  return { pts: w, n: Math.floor(w.length / 4), st: String(x.s ?? ''), lv: Number(x.lv) || 0, hv: Number(x.hv) || 0, d: Number(x.d) || 14, carry: x.c === 1 };
}

/** a panel is in gap i; the river has come through it (the street behind is flooded) */
const closedAt = (W: Wall, i: number) => W.st[i] === '1' || W.st[i] === '4';
const floodedAt = (W: Wall, i: number) => W.st[i] === '3' || W.st[i] === '4';

/** gap i: its ends, the way it runs (u) and inland (n) */
function gapAt(W: Wall, i: number) {
  const p = W.pts, ax = p[i * 4], ay = p[i * 4 + 1], bx = p[i * 4 + 2], by = p[i * 4 + 3];
  const l = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / l, uy = (by - ay) / l;
  return { ax, ay, bx, by, ux, uy, nx: uy, ny: -ux };
}

/** the wall's line, gap by gap, and a little past its ends: flat [x, y, nx, ny] per point */
function lineOf(W: Wall, ext: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < W.n; i++) {
    const g = gapAt(W, i);
    if (i === 0) out.push(g.ax - g.ux * ext, g.ay - g.uy * ext, g.nx, g.ny);
    out.push(g.ax, g.ay, g.nx, g.ny, g.bx, g.by, g.nx, g.ny);
    if (i === W.n - 1) out.push(g.bx + g.ux * ext, g.by + g.uy * ext, g.nx, g.ny);
  }
  return out;
}

/** the line moved `off` metres toward the river (appended to the current path) */
function traceOff(ctx: CanvasRenderingContext2D, line: number[], off: number, reverse: boolean, first: boolean, wiggle?: (j: number) => number) {
  const n = line.length / 4;
  for (let k = 0; k < n; k++) {
    const j = (reverse ? n - 1 - k : k) * 4;
    const o = off + (wiggle ? wiggle(j) : 0);
    const x = line[j] - line[j + 2] * o, y = line[j + 1] - line[j + 3] * o;
    if (k === 0 && first) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}

function drawWater(ctx: CanvasRenderingContext2D, W: Wall, t: number) {
  const line = lineOf(W, EXT);
  const wl = W.d * (1 - Math.min(1, Math.max(0, W.lv)));
  const x0 = line[0], y0 = line[1], x1 = line[line.length - 4], y1 = line[line.length - 3];
  const total = Math.hypot(x1 - x0, y1 - y0) || 1, fade = Math.min(0.45, EXT / total);
  // deep and dark while it's low, lighter (the churned-up, muddy flood) as it climbs
  const light = 34 + W.hv * 24, alpha = 0.55 + W.hv * 0.2;
  const grad = ctx.createLinearGradient(x0, y0, x1, y1);
  grad.addColorStop(0, `hsla(203, 62%, ${light}%, 0)`);
  grad.addColorStop(fade, `hsla(203, 62%, ${light}%, ${alpha})`);
  grad.addColorStop(1 - fade, `hsla(203, 62%, ${light}%, ${alpha})`);
  grad.addColorStop(1, `hsla(203, 62%, ${light}%, 0)`);
  ctx.beginPath();
  // from just past the river's edge (the drawn river takes over there) up to the waterline
  traceOff(ctx, line, W.d + 1, false, true);
  traceOff(ctx, line, wl, true, false);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  // the waterline's foam, lapping
  ctx.beginPath();
  traceOff(ctx, line, wl, false, true, (j) => Math.sin(t * 2.2 + j * 0.37) * 0.3);
  ctx.strokeStyle = grad;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.strokeStyle = `rgba(235,248,255,${0.35 + 0.15 * Math.sin(t * 3)})`;
  ctx.lineWidth = 0.18;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawWall(ctx: CanvasRenderingContext2D, W: Wall, t: number, warn: boolean) {
  ctx.save();
  ctx.lineCap = 'butt';
  // the flooded street behind a breach
  for (let i = 0; i < W.n; i++) {
    if (!floodedAt(W, i)) continue;
    const g = gapAt(W, i);
    ctx.beginPath();
    ctx.moveTo(g.ax, g.ay);
    ctx.lineTo(g.bx, g.by);
    ctx.lineTo(g.bx + g.nx * BREACH_DEPTH, g.by + g.ny * BREACH_DEPTH);
    ctx.lineTo(g.ax + g.nx * BREACH_DEPTH, g.ay + g.ny * BREACH_DEPTH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(64,160,220,0.32)';
    ctx.fill();
  }
  // the standing sections, between the gaps and a stub past each end: a shadow, the wall, its top
  const sections: number[][] = [];
  const g0 = gapAt(W, 0), gl = gapAt(W, W.n - 1);
  sections.push([g0.ax - g0.ux * STUB, g0.ay - g0.uy * STUB, g0.ax, g0.ay]);
  for (let i = 0; i + 1 < W.n; i++) {
    const a = gapAt(W, i), b = gapAt(W, i + 1);
    sections.push([a.bx, a.by, b.ax, b.ay]);
  }
  sections.push([gl.bx, gl.by, gl.bx + gl.ux * STUB, gl.by + gl.uy * STUB]);
  const stroke = (color: string, width: number, dx = 0, dy = 0) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const [ax, ay, bx, by] of sections) {
      ctx.moveTo(ax + dx, ay + dy);
      ctx.lineTo(bx + dx, by + dy);
    }
    ctx.stroke();
  };
  stroke('rgba(0,0,0,0.35)', 0.75, g0.nx * 0.18, g0.ny * 0.18);
  stroke('#8f989d', 0.55);
  stroke('#c3cacd', 0.18);
  // the gaps: a panel in (orange, its beams), or open between red posts
  const blink = 0.5 + 0.5 * Math.sin(t * 9);
  for (let i = 0; i < W.n; i++) {
    const g = gapAt(W, i), st = W.st[i];
    if (closedAt(W, i)) {
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(g.ax + g.nx * 0.18, g.ay + g.ny * 0.18);
      ctx.lineTo(g.bx + g.nx * 0.18, g.by + g.ny * 0.18);
      ctx.stroke();
      ctx.strokeStyle = '#ff9800';
      ctx.lineWidth = 0.45;
      ctx.beginPath();
      ctx.moveTo(g.ax, g.ay);
      ctx.lineTo(g.bx, g.by);
      ctx.stroke();
      // the beams' seams
      ctx.strokeStyle = 'rgba(120,60,0,0.55)';
      ctx.lineWidth = 0.05;
      ctx.beginPath();
      for (let k = 1; k < 6; k++) {
        const f = k / 6, x = g.ax + (g.bx - g.ax) * f, y = g.ay + (g.by - g.ay) * f;
        ctx.moveTo(x - g.nx * 0.22, y - g.ny * 0.22);
        ctx.lineTo(x + g.nx * 0.22, y + g.ny * 0.22);
      }
      ctx.stroke();
    } else if (warn) {
      // a peak is coming and it's still open
      ctx.strokeStyle = `rgba(255,40,40,${0.25 + 0.55 * blink})`;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(g.ax, g.ay);
      ctx.lineTo(g.bx, g.by);
      ctx.stroke();
    }
    // the posts at its ends
    const post = closedAt(W, i) ? '#455a64' : st === '2' ? '#ff4f9a' : '#e53935';
    for (const [x, y] of [[g.ax, g.ay], [g.bx, g.by]]) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(x - 0.3 + g.nx * 0.15, y - 0.3 + g.ny * 0.15, 0.6, 0.6);
      ctx.fillStyle = post;
      ctx.fillRect(x - 0.28, y - 0.28, 0.56, 0.56);
    }
  }
  ctx.restore();
}

/** the stack of panels the van unloaded: a few orange beams on a pallet */
function drawStack(ctx: CanvasRenderingContext2D, dp: unknown) {
  if (!Array.isArray(dp) || dp.length < 3) return;
  const [x, y, a] = dp as number[];
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(-1.15, -0.75, 2.5, 1.7);
  ctx.fillStyle = '#a1887f';
  ctx.fillRect(-1.25, -0.85, 2.5, 1.7);
  for (let k = 0; k < 4; k++) {
    const oy = -0.7 + k * 0.4;
    ctx.fillStyle = k % 2 ? '#fb8c00' : '#ffa726';
    ctx.fillRect(-1.15, oy, 2.3, 0.32);
    ctx.strokeStyle = 'rgba(120,60,0,0.6)';
    ctx.lineWidth = 0.04;
    ctx.strokeRect(-1.15, oy, 2.3, 0.32);
  }
  ctx.restore();
}

/** the panel in the player's hands, across their front */
function drawCarried(ctx: CanvasRenderingContext2D, g: Game) {
  const me = g.player;
  if (!me || me.vehicle) return;
  ctx.save();
  ctx.translate(me.x + Math.cos(me.angle) * 0.3, me.y + Math.sin(me.angle) * 0.3);
  ctx.rotate(me.angle + Math.PI / 2);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(-0.85, -0.1, 1.7, 0.34);
  ctx.fillStyle = '#ff9800';
  ctx.fillRect(-0.8, -0.16, 1.6, 0.3);
  ctx.strokeStyle = '#b35c00';
  ctx.lineWidth = 0.05;
  ctx.strokeRect(-0.8, -0.16, 1.6, 0.3);
  ctx.restore();
}

export const FLOOD_DRAW: MiniDrawer = {
  world(ctx, s, v: View, g) {
    const W = wallOf(s);
    if (!W) return;
    // anything of it in view (the band reaches the wall's depth toward the river, a breach's inland)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < W.pts.length; i += 2) {
      x0 = Math.min(x0, W.pts[i]);
      x1 = Math.max(x1, W.pts[i]);
      y0 = Math.min(y0, W.pts[i + 1]);
      y1 = Math.max(y1, W.pts[i + 1]);
    }
    const pad = EXT + W.d + BREACH_DEPTH;
    if (x1 < v.x0 - pad || x0 > v.x1 + pad || y1 < v.y0 - pad || y0 > v.y1 + pad) {
      if (W.carry) drawCarried(ctx, g);
      return;
    }
    // the game says when a peak is near (`pk`); the countdown it rides on keeps the blinking going
    // between its states
    const warn = s.phase === 'live' && s.x?.pk === 1 && miniLeft(g.host.live) < WARN_S;
    drawWater(ctx, W, g.time);
    drawWall(ctx, W, g.time, warn);
    drawStack(ctx, s.x?.dp);
    if (W.carry) drawCarried(ctx, g);
  },

  map(ctx, s, toScreen, full) {
    const W = wallOf(s);
    if (!W) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(200,210,215,0.95)';
    ctx.lineWidth = full ? 3 : 2;
    ctx.beginPath();
    for (let i = 0; i < W.n; i++) {
      const g = gapAt(W, i);
      const [ax, ay] = toScreen(g.ax, g.ay), [bx, by] = toScreen(g.bx, g.by);
      i ? ctx.lineTo(ax, ay) : ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();
    // the panels set, orange on it
    ctx.strokeStyle = '#ff9800';
    ctx.lineWidth = full ? 4 : 2.5;
    ctx.beginPath();
    for (let i = 0; i < W.n; i++) {
      if (!closedAt(W, i)) continue;
      const g = gapAt(W, i);
      const [ax, ay] = toScreen(g.ax, g.ay), [bx, by] = toScreen(g.bx, g.by);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();
    ctx.restore();
  },
};
