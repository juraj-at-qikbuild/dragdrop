// Canvas drawing for trams (client only). State lives in src/shared/entities/Tram.ts.
import type { Atmosphere } from '../world/Atmosphere';
import type { LightLayer } from '../world/Lighting';
import { TRAM_SEG as SEG, TRAM_GAP as GAP, type Tram } from '../shared/entities/Tram';
import { roundRect } from './shapes';

/** Headlights and interior glow. */
export function emitTramLights(t: Tram, L: LightLayer, atmos?: Atmosphere) {
  if (!atmos) return;
  const k = Math.max(atmos.night, atmos.rain * 0.5);
  if (k <= 0.02) return;
  const front = t.sections[0];
  if (front) {
    const fx = Math.cos(front.a), fy = Math.sin(front.a);
    const nx = front.x + fx * (SEG / 2 - 0.3), ny = front.y + fy * (SEG / 2 - 0.3);
    L.cone(nx, ny, front.a, 14, 0.3, '#fff1c8', k);
    L.point(nx, ny, 1.6, '#fff1c8', 0.6 * k);
  }
  for (const s of t.sections) L.point(s.x, s.y, 2.4, '#ffd98a', 0.28 * k);
}

/** `alphaAt` fades sections by position (the part of the tram already in the tunnel). */
export function drawTram(t: Tram, ctx: CanvasRenderingContext2D, atmos?: Atmosphere, alphaAt?: (x: number, y: number) => number) {
  const night = atmos?.night ?? 0;
  for (let i = t.sections.length - 1; i >= 0; i--) {
    const s = t.sections[i];
    const alpha = alphaAt ? alphaAt(s.x, s.y) : 1;
    if (alpha <= 0) continue;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(s.x, s.y);
    ctx.rotate(s.a);
    // shadow along the sun (tight contact shadow at night)
    let shx = 0.3, shy = 0.4, salpha = 0.35;
    if (atmos) {
      if (night > 0.72) { shx = 0.12; shy = 0.16; salpha = 0.3; }
      else {
        const h = 1.4, ca = Math.cos(s.a), sa = Math.sin(s.a);
        const wx = atmos.sun.dx * h, wy = atmos.sun.dy * h;
        shx = wx * ca + wy * sa;
        shy = -wx * sa + wy * ca;
        salpha = 0.25 + 0.2 * atmos.daylight;
      }
    }
    ctx.fillStyle = `rgba(0,0,0,${salpha})`;
    ctx.fillRect(-SEG / 2 + shx, -1.2 + shy, SEG, 2.4);
    // cream roof peeking behind the red sides
    ctx.fillStyle = '#efe6d2';
    roundRect(ctx, -SEG / 2 - 0.05, -1.15, SEG + 0.1, 2.3, 0.3);
    ctx.fill();
    // red body
    ctx.fillStyle = i === 0 ? '#c8102e' : '#d7141a';
    if (i === 0) {
      // rounded cab front
      ctx.beginPath();
      ctx.moveTo(-SEG / 2, -1.2);
      ctx.lineTo(SEG / 2 - 0.5, -1.2);
      ctx.quadraticCurveTo(SEG / 2 + 0.15, -1.2, SEG / 2 + 0.15, -0.55);
      ctx.lineTo(SEG / 2 + 0.15, 0.55);
      ctx.quadraticCurveTo(SEG / 2 + 0.15, 1.2, SEG / 2 - 0.5, 1.2);
      ctx.lineTo(-SEG / 2, 1.2);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillRect(-SEG / 2, -1.2, SEG, 2.4);
    }
    // cream window strip, both sides, with a subtle reflection gradient in the glass
    ctx.fillStyle = '#f4f0e6';
    ctx.fillRect(-SEG / 2 + 0.3, -0.95, SEG - 0.9, 1.9);
    const glassGrad = ctx.createLinearGradient(0, -0.72, 0, 0.72);
    glassGrad.addColorStop(0, '#3a4954');
    glassGrad.addColorStop(0.45, '#27343f');
    glassGrad.addColorStop(0.55, '#27343f');
    glassGrad.addColorStop(1, '#1c262e');
    ctx.fillStyle = glassGrad;
    for (let w = 0; w < 3; w++) ctx.fillRect(-SEG / 2 + 0.65 + w * (SEG - 1.6) / 2.6, -0.72, (SEG - 1.6) / 3.4, 1.44);
    // door lines
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 0.05;
    for (const dx of [-SEG * 0.22, SEG * 0.22]) {
      ctx.beginPath();
      ctx.moveTo(dx, -1.15);
      ctx.lineTo(dx, 1.15);
      ctx.stroke();
    }
    ctx.fillStyle = '#9ea3a8';
    ctx.fillRect(-1.2, -0.4, 2.4, 0.8); // roof equipment
    if (i === 1) {
      // pantograph
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 0.06;
      ctx.beginPath();
      ctx.moveTo(-0.55, -0.4);
      ctx.lineTo(0.15, -0.05);
      ctx.lineTo(0.15, 0.05);
      ctx.lineTo(-0.55, 0.4);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0.6, 0);
      ctx.lineTo(0.15, -0.05);
      ctx.moveTo(0.6, 0);
      ctx.lineTo(0.15, 0.05);
      ctx.stroke();
    }
    if (i === 0) {
      ctx.fillStyle = '#27343f';
      ctx.fillRect(SEG / 2 - 0.5, -1.05, 0.5, 2.1);
      ctx.fillStyle = '#fff6c4';
      ctx.fillRect(SEG / 2 - 0.1, -1.05, 0.15, 0.35);
      ctx.fillRect(SEG / 2 - 0.1, 0.7, 0.15, 0.35);
    }
    // rubber bellows joint between sections
    if (i < t.sections.length - 1) {
      ctx.fillStyle = '#2b2b2b';
      ctx.fillRect(-SEG / 2 - GAP, -0.55, GAP, 1.1);
    }
    ctx.restore();
  }
}
