// The market stalls (client only; src/shared/world/Stalls.ts, docs/plans/non-violent.md: MOJE LOKŠE!):
// a wooden counter under a striped awning, the goods on it and the stallholder behind it; knocked over,
// the counter on its side and the food all over the pavement.
import type { Stalls, StallKind } from '../shared/world/Stalls';
import type { View } from '../world/Renderer';
import { hash01 } from '../shared/util/math';

/** each kind's awning colours and its goods */
const LOOK: Record<StallKind, { stripe: string; food: string; crust: string }> = {
  lokse: { stripe: '#c62828', food: '#f3e3c3', crust: '#b8864b' },
  langos: { stripe: '#2e7d32', food: '#f0c35a', crust: '#c7872a' },
  klobasa: { stripe: '#6d4c41', food: '#a1452f', crust: '#6d2a1c' },
  punc: { stripe: '#6a1b9a', food: '#c2185b', crust: '#fafafa' },
};

export function drawStalls(ctx: CanvasRenderingContext2D, stalls: Stalls, v: View, time: number) {
  for (let i = 0; i < stalls.n; i++) {
    const x = stalls.x[i], y = stalls.y[i];
    if (x < v.x0 - 6 || x > v.x1 + 6 || y < v.y0 - 6 || y > v.y1 + 6) continue;
    const look = LOOK[stalls.kind[i]];
    ctx.save();
    ctx.translate(x, y);
    if (stalls.broken[i] > 0) drawBroken(ctx, look, stalls.fling[i], stalls.a[i], i);
    else drawStanding(ctx, look, stalls.a[i], time, i);
    ctx.restore();
  }
}

type Look = (typeof LOOK)[StallKind];

function drawStanding(ctx: CanvasRenderingContext2D, look: Look, a: number, time: number, i: number) {
  ctx.rotate(a);
  // (facing +x: the street; the stallholder stands behind, at -x)
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(-0.95, -1.15, 2.1, 2.5);
  // the stallholder, bobbing a little, in an apron
  const bob = Math.sin(time * 2 + i) * 0.04;
  ctx.fillStyle = '#eceff1';
  ctx.beginPath();
  ctx.ellipse(-0.75 + bob, 0, 0.26, 0.36, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e0ac85';
  ctx.beginPath();
  ctx.arc(-0.7 + bob, 0, 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fafafa';
  ctx.beginPath();
  ctx.arc(-0.74 + bob, 0, 0.12, 0, Math.PI * 2);
  ctx.fill();
  // the counter
  ctx.fillStyle = '#8d6e63';
  ctx.fillRect(-0.45, -1.1, 0.9, 2.2);
  ctx.strokeStyle = '#4e342e';
  ctx.lineWidth = 0.06;
  ctx.strokeRect(-0.45, -1.1, 0.9, 2.2);
  // the goods on it
  for (let k = 0; k < 5; k++) food(ctx, look, -0.15 + (k % 2) * 0.3, -0.8 + k * 0.4, hash01(i * 7 + k, 3) * 3);
  // the awning over the front edge, striped
  for (let k = 0; k < 6; k++) {
    ctx.fillStyle = k % 2 ? '#fafafa' : look.stripe;
    ctx.fillRect(0.3, -1.25 + k * 0.42, 0.55, 0.42);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 0.04;
  ctx.strokeRect(0.3, -1.25, 0.55, 2.52);
}

function drawBroken(ctx: CanvasRenderingContext2D, look: Look, fling: number, a: number, i: number) {
  // the food all over the pavement, flung the way the car went
  for (let k = 0; k < 9; k++) {
    const d = 0.8 + hash01(i * 13 + k, 5) * 2.6, s = (hash01(i * 17 + k, 7) - 0.5) * 1.6;
    food(ctx, look, Math.cos(fling + s) * d, Math.sin(fling + s) * d, k);
  }
  // the counter on its side, knocked round, and the awning tipped over beside it
  ctx.save();
  ctx.translate(Math.cos(fling) * 0.9, Math.sin(fling) * 0.9);
  ctx.rotate(a + 0.9);
  ctx.fillStyle = '#6d4c41';
  ctx.fillRect(-0.35, -1.1, 0.7, 2.2);
  ctx.strokeStyle = '#3e2723';
  ctx.lineWidth = 0.06;
  ctx.strokeRect(-0.35, -1.1, 0.7, 2.2);
  for (let k = 0; k < 6; k++) {
    ctx.fillStyle = k % 2 ? '#fafafa' : look.stripe;
    ctx.fillRect(0.5, -1.25 + k * 0.42, 0.4, 0.42);
  }
  ctx.restore();
}

/** one of the goods: a lokša, a langoš, a sausage or a cup of punč */
function food(ctx: CanvasRenderingContext2D, look: Look, x: number, y: number, r: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(r);
  ctx.fillStyle = look.food;
  if (look === LOOK.klobasa) {
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.16, 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (look === LOOK.punc) {
    ctx.fillStyle = look.crust;
    ctx.beginPath();
    ctx.arc(0, 0, 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = look.food;
    ctx.beginPath();
    ctx.arc(0, 0, 0.055, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, 0.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = look.crust;
    ctx.beginPath();
    ctx.arc(0.04, -0.03, 0.035, 0, Math.PI * 2);
    ctx.arc(-0.05, 0.04, 0.03, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
