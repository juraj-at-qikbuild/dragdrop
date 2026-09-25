// Canvas drawing and light emission for vehicles (client only). State and physics live in
// src/shared/entities/Vehicle.ts so the server can run them.
import type { Atmosphere } from '../world/Atmosphere';
import type { LightLayer } from '../world/Lighting';
import type { Vehicle } from '../shared/entities/Vehicle';
import { clamp } from '../shared/util/math';
import { shade } from '../shared/util/color';
import { roundRect } from './shapes';

/** Headlights, tail/brake lights, police flashers, fire. */
export function emitVehicleLights(v: Vehicle, L: LightLayer, time: number, atmos?: Atmosphere) {
  if (!atmos) return;
  const s = v.spec;
  const fx = Math.cos(v.angle), fy = Math.sin(v.angle);
  const rx = -fy, ry = fx;
  const noseX = v.x + fx * (s.length / 2 - 0.1), noseY = v.y + fy * (s.length / 2 - 0.1);
  const tailX = v.x - fx * (s.length / 2 - 0.1), tailY = v.y - fy * (s.length / 2 - 0.1);
  const hw = s.width / 2 - 0.18;

  if (v.wrecked) {
    if (v.fire > -1 && Math.random() < 0.7) {
      const fl = 0.55 + Math.random() * 0.45;
      L.point(v.x, v.y, 3.2, '#ff5a1f', fl);
      L.glow(v.x, v.y, 3.5, '#ff8a3d', fl * 0.55);
    }
    return;
  }
  if (v.fire > 0) {
    const fl = 0.6 + Math.random() * 0.4;
    L.point(v.x, v.y, 3.4, '#ff6a00', fl);
    L.glow(v.x, v.y, 3.5, '#ff7a20', fl * 0.6);
  }

  const dmg = v.dmg;
  const k = Math.max(atmos.night, atmos.rain * 0.5);
  if (k > 0.02 && dmg.front <= 0.7) {
    L.cone(noseX, noseY, v.angle, 16, 0.35, '#fff1c8', k);
    L.point(noseX + rx * hw, noseY + ry * hw, 1.8, '#fff1c8', 0.65 * k);
    L.point(noseX - rx * hw, noseY - ry * hw, 1.8, '#fff1c8', 0.65 * k);
  }

  const braking = v.ctrl.throttle < 0 && v.fwdSpeed > 0.5;
  const tailGlow = braking ? 1 : 0.35 * k;
  if (tailGlow > 0.02) {
    L.glow(tailX + rx * hw, tailY + ry * hw, braking ? 1.6 : 1, '#ff2a2a', tailGlow);
    L.glow(tailX - rx * hw, tailY - ry * hw, braking ? 1.6 : 1, '#ff2a2a', tailGlow);
  }
  if (k > 0.02) {
    L.point(tailX + rx * hw, tailY + ry * hw, 1.1, '#ff2a2a', 0.5 * k);
    L.point(tailX - rx * hw, tailY - ry * hw, 1.1, '#ff2a2a', 0.5 * k);
  }

  if (s.kind === 'police' && v.siren) {
    const on = Math.floor(time * 6) % 2 === 0;
    const c1 = on ? '#ff1744' : '#2979ff', c2 = on ? '#2979ff' : '#ff1744';
    const lx = v.x + rx * 0.22, ly = v.y + ry * 0.22;
    const rx2 = v.x - rx * 0.22, ry2 = v.y - ry * 0.22;
    L.point(lx, ly, 9, c1, 0.85);
    L.glow(lx, ly, 5, c1, 0.6);
    L.point(rx2, ry2, 9, c2, 0.85);
    L.glow(rx2, ry2, 5, c2, 0.6);
  }
}

export function drawVehicle(v: Vehicle, ctx: CanvasRenderingContext2D, time: number, atmos?: Atmosphere) {
  const s = v.spec;
  const L = s.length, W = s.width;
  ctx.save();
  ctx.translate(v.x, v.y);
  ctx.rotate(v.angle);
  if (v.sinking) {
    const k = Math.max(0.15, 1 - v.sinking / 2.5);
    ctx.globalAlpha = k;
    ctx.scale(k * 0.3 + 0.7, k * 0.3 + 0.7);
  }
  // shadow: cast along the sun direction, rotated into the car's local frame;
  // a small tight contact shadow at night instead of a long cast one.
  const night = atmos?.night ?? 0;
  let sx = 0.22, sy = 0.32, salpha = 0.3;
  if (atmos) {
    if (night > 0.72) {
      sx = 0.1; sy = 0.14; salpha = 0.28;
    } else {
      const h = 1.15;
      const wx = atmos.sun.dx * h, wy = atmos.sun.dy * h;
      const ca = Math.cos(v.angle), sa = Math.sin(v.angle);
      sx = wx * ca + wy * sa;
      sy = -wx * sa + wy * ca;
      salpha = 0.25 + 0.2 * atmos.daylight;
    }
  }
  ctx.fillStyle = `rgba(0,0,0,${salpha})`;
  roundRect(ctx, -L / 2 + sx, -W / 2 + sy, L, W, 0.4);
  ctx.fill();

  // wheels (front pair steers)
  const wheelLen = Math.min(0.5, L * 0.11), wheelWid = 0.22;
  const wx0 = L * 0.315, wy0 = W / 2 - 0.06;
  const steerAngle = v.steer * 0.5;
  drawWheel(ctx, wx0, -wy0, steerAngle, wheelLen, wheelWid);
  drawWheel(ctx, wx0, wy0, steerAngle, wheelLen, wheelWid);
  drawWheel(ctx, -wx0, -wy0, 0, wheelLen, wheelWid);
  drawWheel(ctx, -wx0, wy0, 0, wheelLen, wheelWid);

  const dmg = v.dmg;
  const body = v.wrecked ? '#2a2623' : v.color;
  ctx.save();
  roundRect(ctx, -L / 2, -W / 2, L, W, s.kind === 'bus' ? 0.35 : 0.5);
  ctx.clip();
  ctx.fillStyle = v.wrecked ? body : bodyGradient(ctx, body);
  ctx.fillRect(-L / 2 - 0.1, -W / 2 - 0.1, L + 0.2, W + 0.2);
  // panel lines: hood/trunk seams and a door crease
  if (!v.wrecked && s.kind !== 'bus') {
    ctx.strokeStyle = shade(body, -0.32);
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.moveTo(L * 0.06, -W / 2 + 0.08);
    ctx.lineTo(L * 0.06, W / 2 - 0.08);
    ctx.stroke();
  }
  // sun-dependent specular sweep: a soft diagonal highlight band across the paint
  if (!v.wrecked && atmos) {
    const ca = Math.cos(v.angle), sa = Math.sin(v.angle);
    const lx = -atmos.sun.dx * ca - atmos.sun.dy * sa; // light dir in car-local x
    const t = Math.max(-1, Math.min(1, lx)) * L * 0.3;
    const g = ctx.createLinearGradient(t - L * 0.22, -W / 2, t + L * 0.22, W / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,255,255,${0.22 + 0.16 * (atmos.daylight ?? 0.6)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-L / 2 - 0.1, -W / 2 - 0.1, L + 0.2, W + 0.2);
  }
  // per-side damage: crumpled dents + a scorch tint at the hit end
  for (const side of ['front', 'rear', 'left', 'right'] as const) {
    const d = dmg[side];
    if (!d) continue;
    ctx.save();
    let cx = 0, cy = 0, w = 0, h = 0;
    if (side === 'front') { cx = L / 2 - 0.3; cy = 0; w = 0.7; h = W - 0.2; }
    else if (side === 'rear') { cx = -L / 2 + 0.3; cy = 0; w = 0.7; h = W - 0.2; }
    else if (side === 'left') { cx = 0; cy = -W / 2 + 0.15; w = L - 0.4; h = 0.5; }
    else { cx = 0; cy = W / 2 - 0.15; w = L - 0.4; h = 0.5; }
    ctx.globalAlpha = Math.min(0.8, d);
    ctx.fillStyle = shade(body, -0.4);
    roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 0.15);
    ctx.fill();
    ctx.fillStyle = 'rgba(30,15,10,0.35)';
    ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    ctx.restore();
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 0.08;
  roundRect(ctx, -L / 2, -W / 2, L, W, s.kind === 'bus' ? 0.35 : 0.5);
  ctx.stroke();

  const glass = v.wrecked ? '#111' : '#27343f';
  if (s.kind === 'bus') {
    // DPB red/white livery: white belly band, red top/bottom, roof vents, doors
    ctx.fillStyle = v.wrecked ? '#222' : '#f2f2f2';
    ctx.fillRect(-L / 2 + 0.6, -W / 2 + 0.25, L - 1.2, W - 0.5);
    ctx.fillStyle = glass;
    ctx.fillRect(L / 2 - 0.55, -W / 2 + 0.2, 0.4, W - 0.4);
    ctx.fillStyle = v.wrecked ? '#333' : '#c9c9c9';
    for (let i = 0; i < 3; i++) ctx.fillRect(-L / 2 + 2 + i * 3.4, -0.5, 1.2, 1);
    ctx.fillStyle = body;
    ctx.fillRect(-L / 2 + 0.6, -0.12, L - 1.2, 0.24);
    if (!v.wrecked) {
      // roof vents
      ctx.fillStyle = shade(body, -0.25);
      for (let i = 0; i < 4; i++) roundRect(ctx, -L / 2 + 1.6 + i * 2.4, -0.55, 0.9, 1.1, 0.15), ctx.fill();
      // doors
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 0.05;
      for (const dx of [-L / 2 + 3.2, L / 2 - 2.6]) {
        ctx.beginPath();
        ctx.moveTo(dx, -W / 2 + 0.05);
        ctx.lineTo(dx, W / 2 - 0.05);
        ctx.stroke();
      }
      ctx.fillStyle = '#fdd835';
      ctx.font = '700 0.5px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('DPB', -L / 2 + 1.1, 0);
    }
  } else if (s.kind === 'van') {
    ctx.fillStyle = glass;
    ctx.fillRect(L / 2 - 1.35, -W / 2 + 0.2, 0.55, W - 0.4);
    ctx.fillStyle = v.wrecked ? '#333' : '#f5f5f5';
    ctx.fillRect(-L / 2 + 0.25, -W / 2 + 0.2, L - 1.8, W - 0.4);
    if (!v.wrecked) {
      // roof rack
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.05;
      ctx.strokeRect(-L / 2 + 0.5, -W / 2 + 0.35, L - 1, W - 0.7);
      ctx.fillStyle = '#c8102e';
      ctx.font = '900 0.62px Arial Black, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('KOFOLKA', -0.65, 0.02);
    }
    mirrors(ctx, L, W, body);
  } else {
    const k = s.kind === 'sport' ? 0.9 : 1;
    // windscreen with a soft reflection gradient
    const wsGrad = ctx.createLinearGradient(L * 0.2, -W / 2, L * 0.36, W / 2);
    wsGrad.addColorStop(0, shade(glass, 0.22));
    wsGrad.addColorStop(0.5, glass);
    wsGrad.addColorStop(1, shade(glass, -0.15));
    ctx.fillStyle = v.wrecked ? glass : wsGrad;
    ctx.beginPath();
    ctx.moveTo(L * 0.2, -W / 2 + 0.18);
    ctx.lineTo(L * 0.33 * k, -W / 2 + 0.3);
    ctx.lineTo(L * 0.33 * k, W / 2 - 0.3);
    ctx.lineTo(L * 0.2, W / 2 - 0.18);
    ctx.closePath();
    ctx.fill();
    if (!v.wrecked) {
      ctx.strokeStyle = 'rgba(255,255,255,0.32)';
      ctx.lineWidth = 0.05;
      ctx.beginPath();
      ctx.moveTo(L * 0.23, -W / 2 + 0.26);
      ctx.lineTo(L * 0.29 * k, -0.02);
      ctx.stroke();
    }
    if (dmg.front > 0.35 && !v.wrecked) {
      // cracked glass: a small spiderweb where the impact hit
      ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.7, dmg.front)})`;
      ctx.lineWidth = 0.02;
      const cx = L * 0.27, cy = 0;
      ctx.beginPath();
      for (let a = 0; a < 6; a++) {
        const ang = (a / 6) * Math.PI * 2;
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(ang) * 0.16, cy + Math.sin(ang) * 0.12);
      }
      ctx.stroke();
    }
    // rear window
    ctx.beginPath();
    ctx.moveTo(-L * 0.26, -W / 2 + 0.2);
    ctx.lineTo(-L * 0.36, -W / 2 + 0.32);
    ctx.lineTo(-L * 0.36, W / 2 - 0.32);
    ctx.lineTo(-L * 0.26, W / 2 - 0.2);
    ctx.closePath();
    ctx.fill();
    // roof
    ctx.fillStyle = v.wrecked ? '#1c1a18' : shade(body, s.kind === 'police' ? -0.05 : -0.12);
    roundRect(ctx, -L * 0.26, -W / 2 + 0.2, L * 0.46, W - 0.4, 0.25);
    ctx.fill();
    if (s.kind === 'police' && !v.wrecked) {
      ctx.fillStyle = '#1a3f9c';
      ctx.fillRect(-L / 2 + 0.2, -W / 2, L - 0.4, 0.22);
      ctx.fillRect(-L / 2 + 0.2, W / 2 - 0.22, L - 0.4, 0.22);
      const on = v.siren && Math.floor(time * 6) % 2 === 0;
      ctx.fillStyle = v.siren ? (on ? '#ff1744' : '#2979ff') : '#90a4ae';
      ctx.fillRect(-0.18, -W / 2 + 0.28, 0.36, (W - 0.56) / 2);
      ctx.fillStyle = v.siren ? (on ? '#2979ff' : '#ff1744') : '#90a4ae';
      ctx.fillRect(-0.18, 0, 0.36, (W - 0.56) / 2);
    }
    if (s.kind === 'taxi' && !v.wrecked) {
      ctx.fillStyle = '#111';
      ctx.fillRect(-0.3, -0.45, 0.55, 0.9);
      ctx.fillStyle = '#fdd835';
      ctx.font = '700 0.28px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.save();
      ctx.rotate(Math.PI / 2);
      ctx.fillText('TAXI', 0, 0.1);
      ctx.restore();
    }
    if (s.kind === 'sport' && !v.wrecked) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(-L / 2, -0.25, L, 0.14);
      ctx.fillRect(-L / 2, 0.11, L, 0.14);
      // rear spoiler
      ctx.fillStyle = shade(body, -0.3);
      ctx.fillRect(-L / 2 - 0.05, -W / 2 + 0.06, 0.12, W - 0.12);
      ctx.fillRect(-L / 2 + 0.02, -W / 2 + 0.08, 0.05, W - 0.16);
    }
    mirrors(ctx, L, W, s.kind === 'sport' ? shade(body, -0.2) : body);
  }
  // damage: scuffs from lost health, cracked windscreen when badly hurt
  const dmgFrac = clamp(1 - v.health / s.health, 0, 1);
  if (v.wrecked) {
    ctx.fillStyle = 'rgba(20,16,14,0.45)';
    for (let i = 0; i < 6; i++) {
      const o = DMG_OFFSETS[i];
      ctx.beginPath();
      ctx.ellipse(o[0] * L * 0.42, o[1] * W * 0.42, o[2] * 0.5, o[2] * 0.32, o[0], 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (dmgFrac > 0.12) {
    const n = Math.min(DMG_OFFSETS.length, 1 + Math.floor(dmgFrac * 6));
    ctx.fillStyle = 'rgba(20,16,14,0.28)';
    for (let i = 0; i < n; i++) {
      const o = DMG_OFFSETS[i];
      ctx.beginPath();
      ctx.ellipse(o[0] * L * 0.42, o[1] * W * 0.42, o[2] * 0.4, o[2] * 0.26, o[0], 0, Math.PI * 2);
      ctx.fill();
    }
    if (dmgFrac > 0.45 && s.kind !== 'bus' && s.kind !== 'van') {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 0.03;
      ctx.beginPath();
      ctx.moveTo(L * 0.22, -0.1);
      ctx.lineTo(L * 0.28, 0.05);
      ctx.lineTo(L * 0.24, 0.2);
      ctx.moveTo(L * 0.26, -0.15);
      ctx.lineTo(L * 0.3, -0.02);
      ctx.stroke();
    }
  }
  // lights (dead/dark if that end took heavy damage)
  if (!v.wrecked) {
    ctx.fillStyle = dmg.front > 0.7 ? '#3a352c' : '#fff6c4';
    ctx.fillRect(L / 2 - 0.16, -W / 2 + 0.12, 0.14, 0.38);
    ctx.fillRect(L / 2 - 0.16, W / 2 - 0.5, 0.14, 0.38);
    const braking = v.ctrl.throttle < 0 && v.fwdSpeed > 0.5;
    ctx.fillStyle = dmg.rear > 0.7 ? '#3a2c2c' : braking ? '#ff1f1f' : '#9b1111';
    ctx.fillRect(-L / 2 + 0.02, -W / 2 + 0.12, 0.14, 0.34);
    ctx.fillRect(-L / 2 + 0.02, W / 2 - 0.46, 0.14, 0.34);
    // missing bumper on a badly-hit end
    if (dmg.front > 0.7) { ctx.fillStyle = '#15130f'; ctx.fillRect(L / 2 - 0.1, -W / 2 + 0.35, 0.25, W - 0.7); }
    if (dmg.rear > 0.7) { ctx.fillStyle = '#15130f'; ctx.fillRect(-L / 2 - 0.1, -W / 2 + 0.35, 0.25, W - 0.7); }
  }
  // exhaust flame when boosting
  if (v.boosting && !v.wrecked) {
    const flick = 0.7 + Math.random() * 0.3;
    const fx0 = -L / 2 - 0.05;
    const g = ctx.createLinearGradient(fx0, 0, fx0 - 0.9 * flick, 0);
    g.addColorStop(0, `rgba(255,220,120,${0.9 * flick})`);
    g.addColorStop(0.5, `rgba(255,120,30,${0.7 * flick})`);
    g.addColorStop(1, 'rgba(255,60,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(fx0, -0.16);
    ctx.lineTo(fx0 - 0.9 * flick, 0);
    ctx.lineTo(fx0, 0.16);
    ctx.closePath();
    ctx.fill();
  }
  if (v.mission && !v.wrecked) {
    ctx.strokeStyle = `rgba(255,214,0,${0.5 + 0.5 * Math.sin(time * 6)})`;
    ctx.lineWidth = 0.25;
    roundRect(ctx, -L / 2 - 0.4, -W / 2 - 0.4, L + 0.8, W + 0.8, 0.6);
    ctx.stroke();
  }
  ctx.restore();
}

/** fractional (x, y, size) offsets for damage scuffs, deterministic across frames */
const DMG_OFFSETS: [number, number, number][] = [
  [0.35, -0.55, 0.5], [-0.5, 0.5, 0.42], [0.6, 0.4, 0.4], [-0.65, -0.45, 0.45], [0.05, 0.15, 0.55], [0.5, -0.1, 0.38],
];

function drawWheel(ctx: CanvasRenderingContext2D, x: number, y: number, ang: number, len: number, wid: number) {
  ctx.save();
  ctx.translate(x, y);
  if (ang) ctx.rotate(ang);
  ctx.fillStyle = '#161616';
  roundRect(ctx, -len / 2, -wid / 2, len, wid, 0.06);
  ctx.fill();
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(-len / 2 + 0.05, -0.03, len - 0.1, 0.06);
  ctx.restore();
}

function mirrors(ctx: CanvasRenderingContext2D, L: number, W: number, color: string) {
  ctx.fillStyle = shade(color, -0.25);
  ctx.fillRect(L * 0.14, -W / 2 - 0.06, 0.16, 0.1);
  ctx.fillRect(L * 0.14, W / 2 - 0.04, 0.16, 0.1);
}

const bodyGradCache = new Map<string, CanvasGradient>();
/** cached vertical gradient (across the car's width) giving a subtle specular ridge down the centreline */
function bodyGradient(ctx: CanvasRenderingContext2D, color: string) {
  let g = bodyGradCache.get(color);
  if (g) return g;
  g = ctx.createLinearGradient(0, -1.35, 0, 1.35);
  g.addColorStop(0, shade(color, -0.26));
  g.addColorStop(0.42, shade(color, 0.14));
  g.addColorStop(0.58, shade(color, 0.14));
  g.addColorStop(1, shade(color, -0.26));
  bodyGradCache.set(color, g);
  return g;
}
