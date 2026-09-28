// Canvas drawing and light emission for vehicles (client only). State and physics live in
// src/shared/entities/Vehicle.ts so the server can run them.
import type { Atmosphere } from '../world/Atmosphere';
import type { LightLayer } from '../world/Lighting';
import { LIVERY_ARMORED, LIVERY_DERBY, LIVERY_KOFOLKA, LIVERY_NONE, type Vehicle } from '../shared/entities/Vehicle';
import { clamp } from '../shared/util/math';
import { shade } from '../shared/util/color';
import { NEONS } from '../shared/sim/shops/catalog';
import { roundRect } from './shapes';
import { drawRider } from './drawPed';

/** '#rrggbb' at alpha `a` */
function rgba(hex: string, a: number) {
  const c = parseInt(hex.slice(1), 16);
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
}

/** brake lights: players' cars only (traffic's constant light dabs on the brakes flashed red like a
 *  police car's lights) */
const braking = (v: Vehicle) => v.isPlayer && v.ctrl.throttle < 0 && v.fwdSpeed > 0.5;

/** Headlights, tail/brake lights, police flashers, fire. */
export function emitVehicleLights(v: Vehicle, L: LightLayer, time: number, atmos?: Atmosphere) {
  // (the car football's ball has no lamps)
  if (!atmos || v.spec.ball) return;
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
  // a scooter or a bike: one small lamp ahead and one red light behind
  if (s.twoWheeler) {
    if (k > 0.02) {
      L.cone(noseX, noseY, v.angle, 9, 0.3, '#fff1c8', 0.7 * k);
      L.point(tailX, tailY, 0.7, '#ff2a2a', 0.45 * k);
    }
    return;
  }
  // a boat: navigation lights after dark (red to port, green to starboard, white astern), and the
  // police boat's searchlight ahead; its flashers are a police car's (below)
  if (s.boat) {
    if (k > 0.02) {
      L.point(noseX - rx * 0.5 - fx * 0.8, noseY - ry * 0.5 - fy * 0.8, 1.2, '#ff3d3d', 0.6 * k);
      L.point(noseX + rx * 0.5 - fx * 0.8, noseY + ry * 0.5 - fy * 0.8, 1.2, '#4cff7a', 0.6 * k);
      L.point(tailX, tailY, 1, '#fff6e0', 0.5 * k);
      if (s.kind === 'policeboat') L.cone(noseX, noseY, v.angle, 26, 0.22, '#f4f9ff', 0.9 * k);
    }
  }
  // neon underglow (the Dielňa, docs/plans/gameplay.md Phase 2): lights the street around the car
  else if (v.mods.glow > 0 && k > 0.02) {
    const c = NEONS[v.mods.glow];
    L.glow(v.x, v.y, s.length * 0.7, c, 0.75 * k);
    L.point(v.x, v.y, s.length * 0.55, c, 0.5 * k);
  }
  if (k > 0.02 && dmg.front <= 0.7 && !s.boat) {
    L.cone(noseX, noseY, v.angle, 16, 0.35, '#fff1c8', k);
    L.point(noseX + rx * hw, noseY + ry * hw, 1.8, '#fff1c8', 0.65 * k);
    L.point(noseX - rx * hw, noseY - ry * hw, 1.8, '#fff1c8', 0.65 * k);
  }

  const brake = braking(v) && !s.boat;
  const tailGlow = s.boat ? 0 : brake ? 1 : 0.35 * k;
  if (tailGlow > 0.02) {
    L.glow(tailX + rx * hw, tailY + ry * hw, brake ? 1.6 : 1, '#ff2a2a', tailGlow);
    L.glow(tailX - rx * hw, tailY - ry * hw, brake ? 1.6 : 1, '#ff2a2a', tailGlow);
  }
  if (k > 0.02) {
    L.point(tailX + rx * hw, tailY + ry * hw, 1.1, '#ff2a2a', 0.5 * k);
    L.point(tailX - rx * hw, tailY - ry * hw, 1.1, '#ff2a2a', 0.5 * k);
  }

  if (v.hasSiren && v.siren) {
    const on = Math.floor(time * 6) % 2 === 0;
    // an ambulance flashes blue only
    const [ca, cb] = s.kind === 'ambulance' ? ['#2979ff', '#82b1ff'] : ['#ff1744', '#2979ff'];
    const c1 = on ? ca : cb, c2 = on ? cb : ca;
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
  if (s.ball) return drawBall(v, ctx, time, atmos);
  if (s.twoWheeler) return drawTwoWheeler(v, ctx);
  if (s.boat) return drawBoat(v, ctx, time);
  const L = s.length, W = s.width;
  ctx.save();
  ctx.translate(v.x, v.y);
  ctx.rotate(v.angle);
  if (v.sinking) {
    const k = Math.max(0.15, 1 - v.sinking / 2.5);
    ctx.globalAlpha *= k;
    ctx.scale(k * 0.3 + 0.7, k * 0.3 + 0.7);
  }
  const night = atmos?.night ?? 0;
  // a jolt or a jump (a speed bump taken fast, a kerb): the body lifts off the road and looms a
  // little larger for a moment
  const lift = v.air > 0 ? 0.35 + v.air * 2 : v.bounce > 0 ? Math.sin((v.bounce / 0.45) * Math.PI) * 0.4 * v.joltK : 0;
  // neon underglow (the Dielňa, docs/plans/gameplay.md Phase 2): a pool of colour under the car,
  // stronger after dark (when emitVehicleLights lights the street with it too)
  if (v.mods.glow > 0 && !v.wrecked) {
    const rx = L / 2 + 0.7, ry = W / 2 + 0.7;
    const c = NEONS[v.mods.glow];
    ctx.save();
    ctx.scale(1, ry / rx);
    const gr = ctx.createRadialGradient(0, 0, rx * 0.4, 0, 0, rx);
    gr.addColorStop(0, rgba(c, 0.6 + 0.3 * night));
    gr.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  if (lift > 0.01) ctx.scale(1 + lift * 0.06, 1 + lift * 0.06);

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
    ctx.globalAlpha *= Math.min(0.8, d);
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
    ctx.fillStyle = v.wrecked ? '#333' : v.swat ? shade(body, -0.12) : '#f5f5f5';
    ctx.fillRect(-L / 2 + 0.25, -W / 2 + 0.2, L - 1.8, W - 0.4);
    if (v.swat && !v.wrecked) {
      // the firefighters (the police's 5★ unit: docs/plans/non-violent.md): a ladder on the roof,
      // reflective stripes and HASIČI
      ctx.fillStyle = '#cfd8dc';
      ctx.fillRect(-L / 2 + 0.45, -0.42, L - 2.1, 0.1);
      ctx.fillRect(-L / 2 + 0.45, 0.32, L - 2.1, 0.1);
      for (let x = -L / 2 + 0.6; x < L / 2 - 1.7; x += 0.45) ctx.fillRect(x, -0.42, 0.07, 0.84);
      ctx.fillStyle = '#ffeb3b';
      ctx.fillRect(-L / 2 + 0.25, -W / 2 + 0.2, L - 1.8, 0.14);
      ctx.fillRect(-L / 2 + 0.25, W / 2 - 0.34, L - 1.8, 0.14);
      ctx.fillStyle = '#fff';
      ctx.font = '900 0.5px Arial Black, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('HASIČI', -0.65, -0.62);
    } else if (!v.wrecked) {
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
  } else if (s.kind === 'ambulance') {
    ctx.fillStyle = glass;
    ctx.fillRect(L / 2 - 1.3, -W / 2 + 0.2, 0.5, W - 0.4);
    ctx.fillStyle = v.wrecked ? '#333' : '#fafafa';
    ctx.fillRect(-L / 2 + 0.2, -W / 2 + 0.18, L - 1.65, W - 0.36);
    if (!v.wrecked) {
      // red stripes down both sides, a red cross on the roof
      ctx.fillStyle = '#e53935';
      ctx.fillRect(-L / 2 + 0.2, -W / 2, L - 0.4, 0.2);
      ctx.fillRect(-L / 2 + 0.2, W / 2 - 0.2, L - 0.4, 0.2);
      ctx.fillRect(-1.2, -0.17, 1.2, 0.34);
      ctx.fillRect(-0.77, -0.6, 0.34, 1.2);
      // the light bar over the cab
      const on = v.siren && Math.floor(time * 7) % 2 === 0;
      ctx.fillStyle = v.siren ? (on ? '#2979ff' : '#82b1ff') : '#90a4ae';
      ctx.fillRect(L / 2 - 1.72, -W / 2 + 0.28, 0.3, (W - 0.56) / 2);
      ctx.fillStyle = v.siren ? (on ? '#82b1ff' : '#2979ff') : '#90a4ae';
      ctx.fillRect(L / 2 - 1.72, 0, 0.3, (W - 0.56) / 2);
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
  // damage: scuffs from lost health, cracked windscreen when badly hurt (maxHealth overrides
  // spec.health for a raised-health mission vehicle, e.g. the armoured van)
  const dmgFrac = clamp(1 - v.health / (v.maxHealth || s.health), 0, 1);
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
    if (dmgFrac > 0.45 && s.kind !== 'bus' && s.kind !== 'van' && s.kind !== 'ambulance') {
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
    ctx.fillStyle = dmg.rear > 0.7 ? '#3a2c2c' : braking(v) ? '#ff1f1f' : '#9b1111';
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
  if (v.livery !== LIVERY_NONE && !v.wrecked) drawLivery(v, ctx);
  if (v.mission && !v.wrecked) {
    ctx.strokeStyle = `rgba(255,214,0,${0.5 + 0.5 * Math.sin(time * 6)})`;
    ctx.lineWidth = 0.25;
    roundRect(ctx, -L / 2 - 0.4, -W / 2 - 0.4, L + 0.8, W + 0.8, 0.6);
    ctx.stroke();
  }
  ctx.restore();
}

/** World-event paint jobs (LIVERY_*), drawn last so they show over the ordinary body (still inside
 *  the car's local transform: +x is the nose). Study the `van`/`police` branches above for how the
 *  roof and lettering are laid out; these just add to it. */
function drawLivery(v: Vehicle, ctx: CanvasRenderingContext2D) {
  const s = v.spec, L = s.length, W = s.width;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (v.livery === LIVERY_KOFOLKA) {
    // a gold pinstripe down both sides and a cash badge on the roof, clear of the van's "KOFOLKA" text
    ctx.fillStyle = '#ffd600';
    ctx.fillRect(-L / 2 + 0.3, -W / 2 + 0.1, L - 0.9, 0.07);
    ctx.fillRect(-L / 2 + 0.3, W / 2 - 0.17, L - 0.9, 0.07);
    ctx.beginPath();
    ctx.arc(L * 0.18, 0, 0.32, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd600';
    ctx.fill();
    ctx.strokeStyle = KOFOLKA_RED;
    ctx.lineWidth = 0.05;
    ctx.stroke();
    ctx.fillStyle = KOFOLKA_RED;
    ctx.font = `900 0.4px Arial Black, sans-serif`;
    ctx.fillText('€', L * 0.18, 0.02);
  } else if (v.livery === LIVERY_ARMORED) {
    // repaint the cargo box dark grey-green (hiding the ordinary van's cheerful branding), a shield
    // badge and "BANKOVÁ SLUŽBA" lettering
    ctx.fillStyle = ARMOR_GREEN;
    ctx.fillRect(-L / 2 + 0.25, -W / 2 + 0.2, L - 1.8, W - 0.4);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 0.04;
    ctx.beginPath();
    ctx.moveTo(-L / 2 + 0.6, -W / 2 + 0.2);
    ctx.lineTo(-L / 2 + 0.6, W / 2 - 0.2);
    ctx.stroke();
    shieldPath(ctx, -L * 0.22, 0, 0.42, 0.5);
    ctx.fillStyle = '#78909c';
    ctx.fill();
    ctx.strokeStyle = '#eceff1';
    ctx.lineWidth = 0.04;
    ctx.stroke();
    ctx.fillStyle = ARMOR_GREEN;
    ctx.font = `900 0.3px Arial Black, sans-serif`;
    ctx.fillText('$', -L * 0.22, 0.01);
    ctx.fillStyle = '#cfd8dc';
    ctx.font = `700 0.24px Arial, sans-serif`;
    ctx.fillText('BANKOVÁ', L * 0.14, -0.15);
    ctx.fillText('SLUŽBA', L * 0.14, 0.15);
  } else if (v.livery === LIVERY_DERBY) {
    // white stripes over the hood/roof and a big race number in a roundel
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(-L / 2 + 0.1, -W * 0.16, L - 0.2, W * 0.1);
    ctx.beginPath();
    ctx.arc(0, 0, 0.36, 0, Math.PI * 2);
    ctx.fillStyle = '#fafafa';
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 0.05;
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.font = `900 0.46px Arial Black, sans-serif`;
    ctx.fillText(String(1 + (v.id % 9)), 0, 0.02);
  }
  ctx.restore();
}

const KOFOLKA_RED = '#c8102e';
const ARMOR_GREEN = '#33413a';

/** a simple heraldic shield, point down, centred at (cx, cy) */
function shieldPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number) {
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, cy - h / 2);
  ctx.lineTo(cx + w / 2, cy - h / 2);
  ctx.lineTo(cx + w / 2, cy + h * 0.1);
  ctx.quadraticCurveTo(cx + w / 2, cy + h * 0.45, cx, cy + h / 2);
  ctx.quadraticCurveTo(cx - w / 2, cy + h * 0.45, cx - w / 2, cy + h * 0.1);
  ctx.closePath();
}

/** fractional (x, y, size) offsets for damage scuffs, deterministic across frames */
const DMG_OFFSETS: [number, number, number][] = [
  [0.35, -0.55, 0.5], [-0.5, 0.5, 0.42], [0.6, 0.4, 0.4], [-0.65, -0.45, 0.45], [0.05, 0.15, 0.55], [0.5, -0.1, 0.38],
];

/** A scooter or a bike from above (docs/plans/gameplay.md, Phase 3): the wheels, the deck or the
 *  frame and saddle, the handlebar turned with the steering, a lamp, and whoever rides it. A broken
 *  one lies on its side, its wheels flat to the street. */
function drawTwoWheeler(v: Vehicle, ctx: CanvasRenderingContext2D) {
  const s = v.spec, L = s.length;
  const bike = s.kind === 'bike';
  const down = v.wrecked;
  const body = down ? shade(v.color, -0.45) : v.color;
  ctx.save();
  ctx.translate(v.x, v.y);
  ctx.rotate(v.angle + (down ? 0.35 : 0));
  if (v.sinking) ctx.globalAlpha *= Math.max(0.15, 1 - v.sinking / 2.5);
  const wr = bike ? 0.34 : 0.11;
  const front = L / 2 - wr - 0.02, rear = -L / 2 + wr + 0.02;
  // the handlebar and the front wheel turn with the steering, about the head of the frame
  const head = bike ? 0.4 : L / 2 - 0.14, turn = v.steer * 0.5;
  ctx.lineCap = 'round';
  if (down) {
    // lying flat: the wheels are circles now
    ctx.strokeStyle = '#161616';
    ctx.lineWidth = bike ? 0.05 : 0.07;
    for (const x of [front, rear]) {
      ctx.beginPath();
      ctx.arc(x, bike ? 0.05 : 0.03, wr, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    drawWheel(ctx, rear, 0, 0, wr * 2, bike ? 0.05 : 0.07);
    ctx.save();
    ctx.translate(head, 0);
    ctx.rotate(turn);
    drawWheel(ctx, front - head, 0, 0, wr * 2, bike ? 0.05 : 0.07);
    ctx.restore();
  }
  if (bike) {
    // the frame from the rear hub past the saddle to the head, the cranks, the saddle
    ctx.strokeStyle = body;
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    ctx.moveTo(rear, 0);
    ctx.lineTo(-0.16, 0);
    ctx.lineTo(head, 0);
    ctx.stroke();
    ctx.strokeStyle = '#3a3a3a';
    ctx.lineWidth = 0.035;
    ctx.beginPath();
    ctx.moveTo(0, -0.13);
    ctx.lineTo(0, 0.13);
    ctx.stroke();
    ctx.fillStyle = '#1c1c1c';
    ctx.beginPath();
    ctx.ellipse(-0.2, 0, 0.1, 0.055, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // the deck, with its grip tape, and the stem up to the bar
    ctx.fillStyle = body;
    roundRect(ctx, rear - 0.02, -0.085, head - rear, 0.17, 0.07);
    ctx.fill();
    ctx.fillStyle = 'rgba(20,20,22,0.75)';
    roundRect(ctx, rear + 0.1, -0.055, head - rear - 0.3, 0.11, 0.04);
    ctx.fill();
  }
  // the handlebar, its grips, and the lamp
  ctx.save();
  ctx.translate(head, 0);
  ctx.rotate(turn);
  ctx.strokeStyle = '#2b2b2b';
  ctx.lineWidth = 0.045;
  ctx.beginPath();
  ctx.moveTo(0, -0.24);
  ctx.lineTo(0, 0.24);
  ctx.stroke();
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 0.06;
  for (const y of [-0.24, 0.24]) {
    ctx.beginPath();
    ctx.moveTo(0, y * 0.8);
    ctx.lineTo(0, y);
    ctx.stroke();
  }
  if (!down) {
    ctx.fillStyle = '#fff8e1';
    ctx.beginPath();
    ctx.arc(0.05, 0, 0.035, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  // the rider: standing on the deck, or in the saddle
  if (v.driver && !down) {
    const at = bike ? -0.12 : -0.08;
    ctx.translate(at, 0);
    drawRider(ctx, v.driver, head - at, bike);
  }
  ctx.restore();
}

/** A boat from above (docs/plans/gameplay.md, Phase 3): its wake and bow wave when it's moving, a
 *  hull with a pointed bow round a lighter deck, the windscreen and the seats, the outboard, whoever's
 *  at the wheel; the police boat white with a blue stripe and a light bar. */
function drawBoat(v: Vehicle, ctx: CanvasRenderingContext2D, time: number) {
  const s = v.spec, L = s.length, W = s.width;
  const police = s.kind === 'policeboat';
  ctx.save();
  ctx.translate(v.x, v.y);
  ctx.rotate(v.angle);
  const k = Math.min(1, v.speed / 14);
  if (v.speed > 1 && !v.wrecked) {
    // the wake spreading out astern, fading as it goes, with foam along its edges; and the bow wave
    const end = -L / 2 - 2.5 - 7 * k, spread = W * 0.6 + 1.6 * k;
    const g = ctx.createLinearGradient(-L / 2, 0, end, 0);
    g.addColorStop(0, `rgba(255,255,255,${0.1 + 0.25 * k})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-L / 2 + 0.3, -W * 0.3);
    ctx.lineTo(end, -spread);
    ctx.lineTo(end, spread);
    ctx.lineTo(-L / 2 + 0.3, W * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = g;
    ctx.lineWidth = 0.18;
    ctx.beginPath();
    ctx.moveTo(-L / 2 + 0.3, -W * 0.35);
    ctx.lineTo(end, -spread);
    ctx.moveTo(-L / 2 + 0.3, W * 0.35);
    ctx.lineTo(end, spread);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${0.2 + 0.35 * k})`;
    ctx.lineWidth = 0.14;
    ctx.beginPath();
    for (const side of [-1, 1]) {
      ctx.moveTo(L / 2 + 0.15, 0);
      ctx.quadraticCurveTo(L * 0.25, side * (W / 2 + 0.4), -L * 0.15, side * (W / 2 + 0.3 + 0.8 * k));
    }
    ctx.stroke();
  }
  const hull = () => {
    ctx.beginPath();
    ctx.moveTo(-L / 2, -W / 2 + 0.12);
    ctx.lineTo(L * 0.1, -W / 2);
    ctx.quadraticCurveTo(L * 0.42, -W * 0.4, L / 2, 0);
    ctx.quadraticCurveTo(L * 0.42, W * 0.4, L * 0.1, W / 2);
    ctx.lineTo(-L / 2, W / 2 - 0.12);
    ctx.closePath();
  };
  const body = v.wrecked ? '#2a2623' : v.color;
  hull();
  ctx.fillStyle = v.wrecked ? body : bodyGradient(ctx, body);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 0.08;
  ctx.stroke();
  // the deck inside the gunwale
  ctx.save();
  ctx.translate(-0.15, 0);
  ctx.scale(0.8, 0.74);
  hull();
  ctx.fillStyle = v.wrecked ? '#1e1b19' : police ? '#cfd8dc' : '#c8b49a';
  ctx.fill();
  ctx.restore();
  if (police && !v.wrecked) {
    ctx.fillStyle = '#1e5bb8';
    ctx.fillRect(-L / 2, -W / 2 + 0.02, L * 0.6, 0.2);
    ctx.fillRect(-L / 2, W / 2 - 0.22, L * 0.6, 0.2);
  }
  // the windscreen, the seats, the outboard
  ctx.fillStyle = 'rgba(30,50,70,0.85)';
  ctx.beginPath();
  ctx.moveTo(L * 0.08, -W * 0.32);
  ctx.quadraticCurveTo(L * 0.16, 0, L * 0.08, W * 0.32);
  ctx.lineTo(L * 0.02, W * 0.3);
  ctx.quadraticCurveTo(L * 0.1, 0, L * 0.02, -W * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = v.wrecked ? '#151312' : '#37474f';
  roundRect(ctx, -L * 0.14, -W * 0.28, 0.55, 0.5, 0.1);
  ctx.fill();
  roundRect(ctx, -L * 0.14, W * 0.28 - 0.5, 0.55, 0.5, 0.1);
  ctx.fill();
  ctx.fillStyle = '#1b1b1b';
  roundRect(ctx, -L / 2 - 0.4, -0.28, 0.5, 0.56, 0.12);
  ctx.fill();
  if (police && !v.wrecked) {
    // the light bar over the console, lit while the siren's on
    const on = v.siren && Math.floor(time * 6) % 2 === 0;
    ctx.fillStyle = v.siren ? (on ? '#ff1744' : '#7f1d1d') : '#5c1a1a';
    ctx.fillRect(-0.1, -0.45, 0.28, 0.42);
    ctx.fillStyle = v.siren ? (on ? '#1e3a8a' : '#2979ff') : '#1a2a5c';
    ctx.fillRect(-0.1, 0.03, 0.28, 0.42);
  }
  // whoever's at the wheel, seated behind the windscreen
  if (v.driver && !v.wrecked) {
    ctx.translate(-L * 0.06, -W * 0.14);
    drawRider(ctx, v.driver, 0.55, true);
  }
  ctx.restore();
}

// -------------------------------------------------------------------------------------- the ball
type V3 = [number, number, number];
const unit3 = (x: number, y: number, z: number): V3 => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};

/** The car football's ball (docs/plans/minigames.md, Vydrž do 95. minúty) is a truncated
 *  icosahedron: 12 black pentagons centred on an icosahedron's corners, each pentagon's own corners a
 *  third of the way along the edges to its 5 neighbours, and white hexagons between them, whose seams
 *  run along the middle third of every such edge. Unit vectors in the ball's frame, worked out once. */
const FOOTBALL = (() => {
  const f = (1 + Math.sqrt(5)) / 2;
  const raw: V3[] = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) raw.push([0, a, b * f], [a, b * f, 0], [b * f, 0, a]);
  const pents: { c: V3; k: V3[] }[] = [];
  const seams: V3[] = [];
  raw.forEach((c, i) => {
    // (neighbours lie 2 apart in these coordinates, the next nearest 2φ)
    const nb = raw.filter((q, j) => j !== i && Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]) < 2.1);
    const cu = unit3(...c);
    // the corners in order round the centre: by their angle in a plane tangent to it
    const t1 = unit3(...(Math.abs(cu[0]) < 0.9 ? ([0, -cu[2], cu[1]] as V3) : ([-cu[2], 0, cu[0]] as V3)));
    const t2: V3 = [cu[1] * t1[2] - cu[2] * t1[1], cu[2] * t1[0] - cu[0] * t1[2], cu[0] * t1[1] - cu[1] * t1[0]];
    const k = nb
      .map((q) => unit3((2 * c[0] + q[0]) / 3, (2 * c[1] + q[1]) / 3, (2 * c[2] + q[2]) / 3))
      .sort((p, q) => Math.atan2(p[0] * t2[0] + p[1] * t2[1] + p[2] * t2[2], p[0] * t1[0] + p[1] * t1[1] + p[2] * t1[2]) - Math.atan2(q[0] * t2[0] + q[1] * t2[1] + q[2] * t2[2], q[0] * t1[0] + q[1] * t1[1] + q[2] * t1[2]));
    pents.push({ c: cu, k });
    for (const q of nb)
      if (raw.indexOf(q) > i) seams.push(unit3((2 * c[0] + q[0]) / 3, (2 * c[1] + q[1]) / 3, (2 * c[2] + q[2]) / 3), unit3((c[0] + 2 * q[0]) / 3, (c[1] + 2 * q[1]) / 3, (c[2] + 2 * q[2]) / 3));
  });
  return { pents, seams };
})();

/** each ball's turn so far (a rotation, row-major: ball frame to the street's, x right, y down the
 *  screen, z into it) and the time it was last drawn */
const ballTurns = new WeakMap<Vehicle, { m: number[]; t: number }>();

/** How the ball has turned by `time`: it rolls without slipping, so moving at v it turns about the
 *  horizontal axis across its path at |v| / r, and the side facing up goes the way it's going. */
function ballTurn(v: Vehicle, time: number): number[] {
  let s = ballTurns.get(v);
  if (!s) ballTurns.set(v, (s = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: time }));
  const dt = Math.min(0.1, Math.max(0, time - s.t));
  s.t = time;
  const r = v.spec.width / 2;
  const wx = v.vy / r, wy = -v.vx / r, w = Math.hypot(wx, wy), th = w * dt;
  if (th < 1e-5) return s.m;
  // Rodrigues' rotation about (kx, ky, 0) by th
  const kx = wx / w, ky = wy / w, c = Math.cos(th), sn = Math.sin(th), C = 1 - c;
  const R = [c + kx * kx * C, kx * ky * C, ky * sn, kx * ky * C, c + ky * ky * C, -kx * sn, -ky * sn, kx * sn, c];
  const m = s.m, o = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = R[i * 3] * m[j] + R[i * 3 + 1] * m[3 + j] + R[i * 3 + 2] * m[6 + j];
  // keep it a rotation (rounding drifts): rows orthonormal again
  const a = unit3(o[0], o[1], o[2]);
  const d = a[0] * o[3] + a[1] * o[4] + a[2] * o[5];
  const b = unit3(o[3] - d * a[0], o[4] - d * a[1], o[5] - d * a[2]);
  s.m = [...a, ...b, a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return s.m;
}

/** The car football's ball from above: white, with the black pentagons of a football rolling round
 *  it the way it goes, lit from the sun's side. Kicked hard it's up in the air for a moment (drawn
 *  only: the pitch's physics keeps it on the ground), so it looms larger. */
function drawBall(v: Vehicle, ctx: CanvasRenderingContext2D, time: number, atmos?: Atmosphere) {
  const r = v.spec.width / 2;
  const m = ballTurn(v, time);
  const lift = clamp((v.speed - 13) / 9, 0, 1);
  const up = lift * 1.3;
  const night = atmos?.night ?? 0;
  const sun = atmos && night <= 0.72 ? atmos.sun : { dx: 0.35, dy: 0.5 };
  ctx.save();
  ctx.translate(v.x, v.y);
  ctx.translate(0, -up * 0.55);
  if (lift > 0) ctx.scale(1 + lift * 0.18, 1 + lift * 0.18);
  const body = ctx.createRadialGradient(-sun.dx * r * 0.5, -sun.dy * r * 0.5, r * 0.1, 0, 0, r);
  body.addColorStop(0, '#ffffff');
  body.addColorStop(0.65, '#eef1f3');
  body.addColorStop(1, '#aeb6bc');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.clip();
  // a point of the ball, onto the street: the half facing up (z < 0) as it is, the rest pressed onto
  // the rim (a pentagon going over the edge bends round it)
  const at = (p: V3): [number, number, number] => {
    const x = m[0] * p[0] + m[1] * p[1] + m[2] * p[2], y = m[3] * p[0] + m[4] * p[1] + m[5] * p[2], z = m[6] * p[0] + m[7] * p[1] + m[8] * p[2];
    if (z <= 0) return [x * r, y * r, z];
    const l = Math.hypot(x, y) || 1;
    return [(x / l) * r, (y / l) * r, z];
  };
  ctx.strokeStyle = 'rgba(70,76,84,0.5)';
  ctx.lineWidth = 0.035;
  ctx.beginPath();
  for (let i = 0; i < FOOTBALL.seams.length; i += 2) {
    const a = at(FOOTBALL.seams[i]), b = at(FOOTBALL.seams[i + 1]);
    if (a[2] > 0 || b[2] > 0) continue;
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
  }
  ctx.stroke();
  ctx.fillStyle = '#1c1e22';
  for (const pn of FOOTBALL.pents) {
    // (a pentagon reaches about 20° from its centre: past sin 20° behind the rim, none of it shows)
    if (at(pn.c)[2] > 0.3) continue;
    ctx.beginPath();
    pn.k.forEach((k, i) => {
      const q = at(k);
      i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]);
    });
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 0.06;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

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
