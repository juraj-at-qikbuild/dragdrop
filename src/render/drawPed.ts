// Canvas drawing for people (client only). State lives in src/shared/entities/Ped.ts.
import type { Atmosphere } from '../world/Atmosphere';
import { hashRand, type Ped } from '../shared/entities/Ped';
import { shade } from '../shared/util/color';
import { SpriteCache } from './SpriteCache';

/** last draw time per ped, for decaying the hit flash in real time */
const lastDraw = new WeakMap<Ped, number>();

export function drawPed(p: Ped, ctx: CanvasRenderingContext2D, atmos?: Atmosphere) {
  // decay the hit-flash timer using real elapsed time between draws
  const now = performance.now();
  const last = lastDraw.get(p);
  const dtMs = last ? now - last : 0;
  lastDraw.set(p, now);
  if (p.hitFlash > 0) p.hitFlash = Math.max(0, p.hitFlash - dtMs / 1000);

  ctx.save();
  ctx.translate(p.x, p.y);
  const b = p.build;
  if (p.dead) {
    const rot = (hashRand(p.seed, 1) - 0.5) * 2.4;
    ctx.rotate(p.angle + rot);
    ctx.scale(1.45 * b, 1.45 * b);
    // blood pool grows over the first ~2s, then stays
    const grow = Math.min(1, p.deadTime / 2);
    ctx.fillStyle = 'rgba(120,0,0,0.7)';
    ctx.beginPath();
    ctx.ellipse(0.1, 0.05, 0.25 + 0.55 * grow, 0.18 + 0.42 * grow, 0.4, 0, Math.PI * 2);
    ctx.fill();
    // sprawled torso
    ctx.fillStyle = shade(p.shirt, -0.15);
    ctx.beginPath();
    ctx.ellipse(-0.05, 0, 0.34, 0.19, 0, 0, Math.PI * 2);
    ctx.fill();
    // splayed limbs, stable per-ped random angles
    const legCol = shade(p.pants, -0.1);
    drawLimb(ctx, -0.14, -0.1, (hashRand(p.seed, 4) - 0.5) * 1.3 + 0.35, 0.32, 0.1, legCol);
    drawLimb(ctx, -0.14, 0.1, (hashRand(p.seed, 5) - 0.5) * 1.3 - 0.35, 0.32, 0.1, legCol);
    drawLimb(ctx, 0.12, -0.12, (hashRand(p.seed, 2) - 0.5) * 1.8, 0.28, 0.09, p.skin);
    drawLimb(ctx, 0.12, 0.12, (hashRand(p.seed, 3) - 0.5) * 1.8 + Math.PI * 0.15, 0.28, 0.09, p.skin);
    ctx.fillStyle = p.skin;
    ctx.beginPath();
    ctx.arc(0.44, 0, 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.02;
    ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.rotate(p.angle);
  ctx.scale(1.45, 1.45);
  const speed = Math.hypot(p.vx, p.vy);
  const moving = Math.min(1, speed);
  const running = speed > 2.2;
  const strideMul = running ? 1.35 : 1;
  // shadow, offset along the sun
  let shx = 0.08, shy = 0.1;
  if (atmos) {
    const night = atmos.night;
    if (night > 0.72) { shx = 0.04; shy = 0.05; }
    else {
      const h = 0.85, ca = Math.cos(p.angle), sa = Math.sin(p.angle);
      const wx = atmos.sun.dx * h, wy = atmos.sun.dy * h;
      shx = (wx * ca + wy * sa) / 1.45;
      shy = (-wx * sa + wy * ca) / 1.45;
    }
  }
  // contact shadow under the feet, plus a softer cast shadow stretched from them along the sun
  ctx.fillStyle = 'rgba(0,0,0,0.26)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 0.26 * b, 0.32 * b, 0, 0, Math.PI * 2);
  ctx.fill();
  const slen = Math.min(0.9, Math.hypot(shx, shy));
  if (slen > 0.08) {
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.beginPath();
    ctx.ellipse(shx / Math.hypot(shx, shy) * slen / 2, shy / Math.hypot(shx, shy) * slen / 2, slen / 2 + 0.15, 0.22 * b, Math.atan2(shy, shx), 0, Math.PI * 2);
    ctx.fill();
  }

  const armed = p.weapon !== 'fist' && p.kind !== 'civ';
  const punchT = p.weapon === 'fist' && p.cooldown > 0 ? Math.min(1, p.cooldown / 0.45) : 0;
  // civilians (unarmed, not mid-gesture) are the bulk of the crowd: render via the sprite cache
  const cacheable = !armed && !p.handsUp && punchT <= 0 && p.hitFlash <= 0;
  if (cacheable) {
    const swingQ = moving > 0.15 ? Math.round((p.walkPhase % (Math.PI * 2)) * 6 / Math.PI) : 0;
    const buildQ = Math.round(b * 20);
    const key = `ped|${p.archetype}|${p.shirt}|${p.pants}|${p.hair}|${p.hairStyle}|${p.skin}|${buildQ}|${swingQ}|${moving > 0.15 ? (running ? 2 : 1) : 0}`;
    SpriteCache.draw(ctx, key, 1.3, (c) => {
      const swingPhase = swingQ * Math.PI / 6;
      const swing = moving > 0.15 ? Math.sin(swingPhase) * 0.22 * strideMul : 0;
      drawBody(c, p, swing, moving > 0.15, buildQ / 20, atmos);
    });
  } else {
    const swing = Math.sin(p.walkPhase) * 0.22 * moving * strideMul;
    drawBody(ctx, p, swing, moving > 0.15, b, atmos);
    if (p.handsUp) {
      ctx.fillStyle = p.skin;
      ctx.fillRect(-0.06, -0.62, 0.14, 0.28);
      ctx.fillRect(-0.06, 0.34, 0.14, 0.28);
    } else if (punchT > 0) {
      const ext = 0.34 + 0.16 * (1 - punchT);
      ctx.fillStyle = p.skin;
      ctx.fillRect(0.05, -0.06, ext, 0.1);
      ctx.fillStyle = '#333';
      ctx.beginPath();
      ctx.arc(0.05 + ext, -0.01, 0.06, 0, Math.PI * 2);
      ctx.fill();
    } else if (armed) {
      ctx.fillStyle = p.skin;
      ctx.fillRect(0.05, -0.06, 0.3, 0.1);
      ctx.fillStyle = '#111';
      if (p.weapon === 'pistol') {
        ctx.fillRect(0.32, -0.05, 0.2, 0.08);
      } else {
        // uzi/shotgun: both arms forward, gripping
        ctx.fillRect(-0.02, -0.06, 0.36, 0.1);
        ctx.fillRect(0.34, -0.06, p.weapon === 'shotgun' ? 0.5 : 0.28, 0.09);
      }
    }
  }
  if (p.hitFlash > 0) {
    ctx.globalAlpha = Math.min(0.85, p.hitFlash / 0.14);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.4, 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawLimb(ctx: CanvasRenderingContext2D, px: number, py: number, ang: number, len: number, wid: number, color: string) {
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(ang);
  ctx.fillStyle = color;
  ctx.fillRect(0, -wid / 2, len, wid);
  ctx.restore();
}

/** Draws the unarmed body: legs, arms at rest, torso, head, hair, archetype accessories.
 * Used both directly (armed peds) and inside SpriteCache (unarmed crowd). */
function drawBody(ctx: CanvasRenderingContext2D, p: Ped, swing: number, moving: boolean, b: number, atmos?: Atmosphere) {
  ctx.save();
  ctx.scale(b, b);
  // legs/feet (visible stride when moving)
  ctx.fillStyle = p.pants;
  const skirt = p.archetype === 'dress';
  if (!skirt) {
    ctx.fillRect(swing, -0.2, 0.2, 0.12);
    ctx.fillRect(-swing, 0.08, 0.2, 0.12);
  }
  ctx.fillStyle = '#181818';
  if (moving && !skirt) {
    ctx.fillRect(swing + (swing >= 0 ? 0.14 : -0.02), -0.2, 0.08, 0.12);
    ctx.fillRect(-swing + (-swing >= 0 ? 0.14 : -0.02), 0.08, 0.08, 0.12);
  } else if (skirt) {
    ctx.fillRect(swing * 0.5, -0.16, 0.08, 0.1);
    ctx.fillRect(-swing * 0.5, 0.06, 0.08, 0.1);
  }
  // arms at sides, swinging counter-phase to legs
  ctx.fillStyle = p.skin;
  ctx.fillRect(-swing * 0.8 - 0.05, -0.36, 0.2, 0.1);
  ctx.fillRect(swing * 0.8 - 0.05, 0.26, 0.2, 0.1);
  // torso: rounded shoulders with a subtle gradient + darker edge, shaded toward the sun
  ctx.fillStyle = torsoGradient(ctx, p.shirt);
  ctx.beginPath();
  ctx.ellipse(0, 0, 0.19, 0.33, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = shade(p.shirt, -0.35);
  ctx.lineWidth = 0.025;
  ctx.stroke();
  if (skirt) {
    // dress: shirt-colour skirt flares out over the upper legs
    ctx.fillStyle = shade(p.shirt, -0.08);
    ctx.beginPath();
    ctx.moveTo(-0.1, -0.22);
    ctx.quadraticCurveTo(-0.3, 0, -0.14, 0.3);
    ctx.lineTo(0.02, 0.3);
    ctx.lineTo(0.05, -0.22);
    ctx.closePath();
    ctx.fill();
  }
  if (p.archetype === 'player') {
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.moveTo(0, -0.28);
    ctx.lineTo(0, 0.28);
    ctx.stroke();
  }
  if (p.kind === 'cop') {
    const swat = p.outfit === 'swat';
    if (swat) {
      // black tactical vest covering most of the torso
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.17, 0.29, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 0.015;
      ctx.beginPath();
      ctx.moveTo(0, -0.26);
      ctx.lineTo(0, 0.26);
      ctx.stroke();
    }
    ctx.fillStyle = swat ? '#0d0d0d' : '#0c1a45';
    ctx.fillRect(-0.19, -0.06, 0.38, 0.12);
    ctx.fillStyle = '#c9a227';
    ctx.fillRect(0.06, -0.04, 0.05, 0.05); // badge
  }
  if (p.archetype === 'worker') {
    // hi-vis vest with reflective stripes
    ctx.fillStyle = '#ff8f00';
    ctx.fillRect(-0.19, -0.26, 0.38, 0.5);
    ctx.fillStyle = '#fff59d';
    ctx.fillRect(-0.19, -0.08, 0.38, 0.05);
    ctx.fillRect(-0.19, 0.08, 0.38, 0.05);
  }
  if (p.archetype === 'suit') {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 0.015;
    ctx.beginPath();
    ctx.moveTo(-0.03, -0.3);
    ctx.lineTo(-0.03, 0.3);
    ctx.moveTo(0.03, -0.3);
    ctx.lineTo(0.03, 0.3);
    ctx.stroke();
    // briefcase carried on the trailing hand
    ctx.fillStyle = '#1c1c1c';
    ctx.fillRect(-0.2, 0.3, 0.16, 0.13);
  }
  if (p.archetype === 'tourist') {
    ctx.fillStyle = shade(p.shirt, -0.35);
    ctx.beginPath();
    ctx.ellipse(-0.2, 0, 0.14, 0.2, 0, 0, Math.PI * 2);
    ctx.fill(); // backpack behind
    ctx.fillStyle = '#222';
    ctx.fillRect(-0.02, -0.05, 0.12, 0.1); // camera
  }
  if (p.archetype === 'student') {
    ctx.fillStyle = shade(p.shirt, -0.3);
    ctx.beginPath();
    ctx.ellipse(-0.18, 0, 0.11, 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (p.archetype === 'elderly') {
    ctx.strokeStyle = '#7a5a3a';
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.moveTo(0.16, 0.3);
    ctx.lineTo(0.24, 0.5);
    ctx.stroke();
  }
  // head + hair, thin outline for readability at small zoom
  ctx.fillStyle = p.skin;
  ctx.beginPath();
  ctx.arc(0.06, 0, 0.14, 0, Math.PI * 2);
  ctx.fill();
  drawHair(ctx, p);
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 0.02;
  ctx.beginPath();
  ctx.arc(0.06, 0, 0.14, 0, Math.PI * 2);
  ctx.stroke();
  // subtle night rim-light on the sun/moon-facing edge
  const night = atmos?.night ?? 0;
  if (night > 0.35) {
    ctx.strokeStyle = `rgba(180,200,255,${(night - 0.35) * 0.35})`;
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.19, 0.33, 0, -0.6, 0.6);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHair(ctx: CanvasRenderingContext2D, p: Ped) {
  const style = p.hairStyle;
  if (p.kind === 'cop' && p.outfit === 'swat') {
    // swat helmet: dark dome + visor band
    ctx.fillStyle = '#0d0d0d';
    ctx.beginPath();
    ctx.arc(0.02, 0, 0.165, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(0.1, -0.15, 0.09, 0.3);
    return;
  }
  if (style === 'bald') return;
  ctx.fillStyle = p.hair;
  if (style === 'cap') {
    ctx.beginPath();
    ctx.arc(0.02, 0, 0.15, -Math.PI * 0.75, Math.PI * 0.75);
    ctx.fill();
    ctx.fillStyle = shade(p.hair, -0.2);
    ctx.fillRect(0.1, -0.14, 0.1, 0.28);
    return;
  }
  if (style === 'helmet') {
    ctx.fillStyle = '#ffd600';
    ctx.beginPath();
    ctx.arc(0.02, 0, 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.arc(0.02, 0, 0.16, -0.3, 0.3);
    ctx.stroke();
    return;
  }
  if (style === 'hat') {
    ctx.fillStyle = '#e8dcc0';
    ctx.beginPath();
    ctx.ellipse(0.02, 0, 0.22, 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#c9b98a';
    ctx.beginPath();
    ctx.arc(0.02, 0, 0.13, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (style === 'scarf') {
    ctx.fillStyle = shade(p.shirt, 0.1);
    ctx.beginPath();
    ctx.arc(0.02, 0, 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = shade(p.shirt, -0.15);
    ctx.fillRect(-0.14, 0.02, 0.1, 0.14); // trailing knot
    return;
  }
  // short / long / bun: base coverage circle
  ctx.beginPath();
  ctx.arc(0.02, 0, 0.15, 0, Math.PI * 2);
  ctx.fill();
  if (style === 'long') {
    ctx.beginPath();
    ctx.ellipse(-0.1, 0, 0.1, 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (style === 'bun') {
    ctx.beginPath();
    ctx.arc(-0.16, 0, 0.06, 0, Math.PI * 2);
    ctx.fill();
  }
}

const torsoGradCache = new Map<string, CanvasGradient>();
function torsoGradient(ctx: CanvasRenderingContext2D, color: string) {
  let g = torsoGradCache.get(color);
  if (g) return g;
  g = ctx.createLinearGradient(-0.19, 0, 0.19, 0);
  g.addColorStop(0, shade(color, -0.18));
  g.addColorStop(0.5, shade(color, 0.1));
  g.addColorStop(1, shade(color, -0.18));
  torsoGradCache.set(color, g);
  return g;
}
