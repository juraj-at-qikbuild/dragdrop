// Canvas drawing for the police helicopter (client only). State lives in src/shared/entities/Helicopter.ts.
import type { Atmosphere } from '../world/Atmosphere';
import type { LightLayer } from '../world/Lighting';
import type { View } from '../world/Renderer';
import { HELI_SEE_R, type Helicopter } from '../shared/entities/Helicopter';
import { clamp, dist } from '../shared/util/math';

/** visual lift from the ground shadow toward the body, along the sun direction: bounded so it
 *  reads well at any zoom level instead of the building roof-parallax (which blows up when the
 *  camera is zoomed in close, e.g. while the player is on foot). */
function liftOffset(h: Helicopter, atmos: Atmosphere): [number, number] {
  const sun = atmos.sun ?? { dx: 0.4, dy: -0.6 };
  const k = Math.min(6, h.altitude * 0.14);
  return [sun.dx * k, sun.dy * k];
}

export function drawHeli(h: Helicopter, ctx: CanvasRenderingContext2D, v: View, atmos: Atmosphere) {
  if (!h.spawned) return;
  if (h.x < v.x0 - 60 || h.x > v.x1 + 60 || h.y < v.y0 - 60 || h.y > v.y1 + 60) return;
  const [ox, oy] = liftOffset(h, atmos);

  // ground shadow at the true (unlifted) position
  ctx.save();
  ctx.translate(h.x, h.y);
  ctx.rotate(h.angle);
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 2.6, 1.1, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // night searchlight cone on the ground, under the body
  if (atmos.night > 0.2) {
    const f = { x: h.tx, y: h.ty };
    const cov = dist(h.x, h.y, f.x, f.y) < HELI_SEE_R;
    ctx.save();
    ctx.globalAlpha = 0.35 * atmos.night;
    ctx.fillStyle = cov ? '#fff9d6' : '#e6f2ff';
    ctx.beginPath();
    ctx.ellipse(h.x * 0.15 + f.x * 0.85, h.y * 0.15 + f.y * 0.85, 4.5, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // body, lifted by altitude offset
  ctx.save();
  ctx.translate(h.x + ox, h.y + oy);
  ctx.rotate(h.angle);
  // tail boom
  ctx.fillStyle = '#1c2430';
  ctx.fillRect(-2.6, -0.18, 2.1, 0.36);
  ctx.beginPath();
  ctx.moveTo(-2.55, 0);
  ctx.lineTo(-2.9, -0.35);
  ctx.lineTo(-2.9, 0.35);
  ctx.closePath();
  ctx.fill();
  // tail rotor blur
  ctx.fillStyle = 'rgba(180,190,200,0.5)';
  ctx.beginPath();
  ctx.ellipse(-2.85, 0, 0.06, 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  // fuselage
  ctx.fillStyle = '#0f1620';
  ctx.beginPath();
  ctx.ellipse(0.1, 0, 1.5, 0.85, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a3f9c';
  ctx.beginPath();
  ctx.ellipse(0.1, 0, 1.1, 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  // cockpit glass
  ctx.fillStyle = '#8fb8e0';
  ctx.beginPath();
  ctx.ellipse(0.95, 0, 0.5, 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  // skids
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 0.1;
  ctx.beginPath();
  ctx.moveTo(-0.9, -0.95);
  ctx.lineTo(0.9, -0.95);
  ctx.moveTo(-0.9, 0.95);
  ctx.lineTo(0.9, 0.95);
  ctx.stroke();
  // main rotor blur disk
  ctx.fillStyle = 'rgba(200,210,220,0.35)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 2.9, 2.9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(150,160,170,0.5)';
  ctx.lineWidth = 0.05;
  ctx.save();
  ctx.rotate(h.rotor);
  ctx.beginPath();
  ctx.moveTo(-2.9, 0);
  ctx.lineTo(2.9, 0);
  ctx.stroke();
  ctx.restore();
  // blinking nav lights
  const blink = Math.sin(h.navBlink * 6) > 0.6;
  ctx.fillStyle = blink ? '#ff1744' : 'rgba(255,23,68,0.15)';
  ctx.beginPath();
  ctx.arc(0, -0.85, 0.09, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = blink ? '#00e676' : 'rgba(0,230,118,0.15)';
  ctx.beginPath();
  ctx.arc(0, 0.85, 0.09, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function emitHeliLights(h: Helicopter, L: LightLayer, atmos: Atmosphere) {
  if (!h.spawned) return;
  const [ox, oy] = liftOffset(h, atmos);
  const bx = h.x + ox, by = h.y + oy;
  const blink = Math.sin(h.navBlink * 6) > 0.6;
  if (blink) L.point(bx, by - 0.85, 1.4, '#ff1744', 0.5);
  if (atmos.night > 0.15) {
    const f = { x: h.tx, y: h.ty };
    const lx = h.x * 0.15 + f.x * 0.85, ly = h.y * 0.15 + f.y * 0.85;
    const covering = dist(h.x, h.y, f.x, f.y) < HELI_SEE_R;
    L.point(lx, ly, 5.5, covering ? '#fff6cc' : '#dfeeff', clamp(0.9 * atmos.night, 0, 1));
    L.glow(lx, ly, 6, '#fff6cc', 0.35 * atmos.night);
  }
}
