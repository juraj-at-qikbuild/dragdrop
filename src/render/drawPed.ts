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
    ctx.lineCap = 'round';
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
  const pose = poseOf(p, speed);
  // shadow, offset along the sun
  let shx = 0.08, shy = 0.1;
  if (atmos) {
    const night = atmos.night;
    if (night > 0.72) { shx = 0.04; shy = 0.05; }
    else {
      const h = pose === 'sit' ? 0.6 : 0.85, ca = Math.cos(p.angle), sa = Math.sin(p.angle);
      const wx = atmos.sun.dx * h, wy = atmos.sun.dy * h;
      shx = (wx * ca + wy * sa) / 1.45;
      shy = (-wx * sa + wy * ca) / 1.45;
    }
  }
  // contact shadow under the feet, plus a softer cast shadow stretched from them along the sun
  ctx.fillStyle = 'rgba(0,0,0,0.26)';
  ctx.beginPath();
  ctx.ellipse(pose === 'sit' ? 0.12 : 0, 0, 0.26 * b, 0.32 * b, 0, 0, Math.PI * 2);
  ctx.fill();
  const slen = Math.min(0.9, Math.hypot(shx, shy));
  if (slen > 0.08) {
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.beginPath();
    ctx.ellipse(shx / Math.hypot(shx, shy) * slen / 2, shy / Math.hypot(shx, shy) * slen / 2, slen / 2 + 0.15, 0.22 * b, Math.atan2(shy, shx), 0, Math.PI * 2);
    ctx.fill();
  }

  const armed = p.weapon !== 'fist' && p.kind !== 'civ';
  // a punch thrown (players and cops: their cooldown; civilians only while fighting)
  const punchT = p.weapon === 'fist' && p.cooldown > 0 && (p.kind !== 'civ' || pose === 'fight') ? Math.min(1, p.cooldown / 0.45) : 0;
  // the crowd (unarmed, in a still pose) is drawn from the sprite cache
  const cacheable = !armed && punchT <= 0 && p.hitFlash <= 0 && pose !== 'fight';
  if (cacheable) {
    const swingQ = pose === 'walk' || pose === 'run' ? Math.round((p.walkPhase % (Math.PI * 2)) * 6 / Math.PI) : 0;
    const buildQ = Math.round(b * 20);
    const key = `ped|${pose}|${p.archetype}|${p.outfit}|${p.shirt}|${p.pants}|${p.hair}|${p.hairStyle}|${p.skin}|${buildQ}|${swingQ}`;
    SpriteCache.draw(ctx, key, 1.4, (c) => {
      const swing = swingQ ? Math.sin(swingQ * Math.PI / 6) * 0.22 * strideMul : 0;
      drawBody(c, p, pose, swing, buildQ / 20, atmos);
    });
  } else {
    const swing = Math.sin(p.walkPhase) * 0.22 * moving * strideMul;
    const arms: Arms = armed ? (p.weapon === 'pistol' ? 'pistol' : 'rifle') : punchT > 0 ? 'punch' : pose === 'fight' ? 'guard' : 'rest';
    drawBody(ctx, p, pose, swing, b, atmos, arms, punchT);
    if (armed) {
      ctx.fillStyle = '#111';
      if (p.weapon === 'pistol') ctx.fillRect(0.34, -0.045, 0.2, 0.08);
      else ctx.fillRect(0.3, -0.05, p.weapon === 'shotgun' ? 0.52 : 0.3, 0.09);
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

type Pose = 'stand' | 'walk' | 'run' | 'sit' | 'phone' | 'fight' | 'hands';
/** what the arms do when not in the pose's own way: hang and swing, hold a gun, throw a punch,
 *  keep a fighting guard */
type Arms = 'rest' | 'pistol' | 'rifle' | 'punch' | 'guard';

function poseOf(p: Ped, speed: number): Pose {
  if (p.state === 'sit') return 'sit';
  if (p.handsUp) return 'hands';
  if (p.state === 'phone') return 'phone';
  if (p.state === 'fight') return 'fight';
  return speed > 2.2 ? 'run' : speed > 0.15 ? 'walk' : 'stand';
}

/** a limb: a round-ended stroke from (x0, y0) to (x1, y1) */
function capsule(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, w: number, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1 + (x1 === x0 && y1 === y0 ? 0.001 : 0), y1);
  ctx.stroke();
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function shoe(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, 0.1, 0.058, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawLimb(ctx: CanvasRenderingContext2D, px: number, py: number, ang: number, len: number, wid: number, color: string) {
  capsule(ctx, px, py, px + Math.cos(ang) * len, py + Math.sin(ang) * len, wid, color);
}

/** Bare arms (short sleeves, a dress, a vest over a T-shirt) */
const BARE_ARMS = new Set(['jogger', 'tourist', 'dress', 'worker']);
const SHOES = '#1b1b1d';

/** The figure seen from above, facing +x: legs and shoes, arms, torso, head and hair, and what
 *  each kind of person carries. `pose` places the limbs (walking, sitting on a seat, on the phone,
 *  squaring up, hands up); `arms` is what armed or punching figures do with theirs. Used directly
 *  and inside the SpriteCache (the unarmed crowd). */
function drawBody(ctx: CanvasRenderingContext2D, p: Ped, pose: Pose, swing: number, b: number, atmos?: Atmosphere, arms: Arms = 'rest', punchT = 0) {
  ctx.save();
  ctx.scale(b, b);
  ctx.lineCap = 'round';
  const skirt = p.archetype === 'dress';
  const sleeve = BARE_ARMS.has(p.archetype) ? p.skin : shade(p.shirt, -0.06);
  const sit = pose === 'sit';
  // torso centre: leaning back against the seat when sitting
  const tx = sit ? -0.06 : 0;

  // legs and shoes: striding when walking, the thighs forward onto the seat when sitting, the
  // feet a little apart when standing (only the shoes show under the body)
  if (sit) {
    capsule(ctx, -0.02, -0.1, 0.34, -0.12, 0.15, p.pants);
    capsule(ctx, -0.02, 0.1, 0.34, 0.12, 0.15, p.pants);
    shoe(ctx, 0.46, -0.12, SHOES);
    shoe(ctx, 0.46, 0.12, SHOES);
  } else if (pose === 'fight') {
    // feet planted, one ahead of the other
    capsule(ctx, 0, -0.1, 0.16, -0.14, 0.13, p.pants);
    capsule(ctx, 0, 0.1, -0.12, 0.14, 0.13, p.pants);
    shoe(ctx, 0.22, -0.14, SHOES);
    shoe(ctx, -0.08, 0.14, SHOES);
  } else {
    const lf = swing + 0.04, rf = -swing + 0.04;
    if (!skirt) {
      capsule(ctx, 0, -0.1, lf, -0.11, 0.13, p.pants);
      capsule(ctx, 0, 0.1, rf, 0.11, 0.13, p.pants);
    }
    shoe(ctx, lf + 0.05, -0.11, skirt ? shade(p.shirt, -0.45) : SHOES);
    shoe(ctx, rf + 0.05, 0.11, skirt ? shade(p.shirt, -0.45) : SHOES);
  }

  // arms under the torso's edge, in the pose's place (the gun and punch arms are drawn on top)
  const shoulder = 0.25;
  const arm = (hx: number, hy: number, side: number) => {
    capsule(ctx, tx, side * shoulder, hx, hy, 0.105, sleeve);
    dot(ctx, hx, hy, 0.052, p.skin);
  };
  if (arms === 'rest')
    switch (pose) {
      case 'sit':
        // hands resting on the thighs
        arm(0.2, -0.15, -1);
        arm(0.22, 0.15, 1);
        break;
      case 'hands':
        // both arms up: seen from above, foreshortened, the palms beside the head
        arm(0.13, -0.33, -1);
        arm(0.13, 0.33, 1);
        dot(ctx, 0.15, -0.34, 0.07, p.skin);
        dot(ctx, 0.15, 0.34, 0.07, p.skin);
        break;
      case 'phone':
        // the left hand hangs, the right holds a phone to the ear
        arm(0.02, -0.31, -1);
        capsule(ctx, tx, shoulder, 0.16, 0.3, 0.105, sleeve);
        capsule(ctx, 0.16, 0.3, 0.1, 0.17, 0.09, sleeve);
        dot(ctx, 0.1, 0.17, 0.05, p.skin);
        break;
      case 'fight':
        break;
      default:
        // hanging at the sides, swinging against the legs
        arm(-swing * 0.8 + 0.02, -0.31, -1);
        arm(swing * 0.8 + 0.02, 0.31, 1);
    }
  if (pose === 'fight' && arms === 'guard') {
    // fists up, the lead one jabbing now and then
    const t = performance.now() / 1000 + (p.seed % 97);
    const jab = Math.max(0, Math.sin(t * 7.5)) ** 3 * 0.16;
    capsule(ctx, 0, -shoulder, 0.28 + jab, -0.1, 0.1, sleeve);
    capsule(ctx, 0, shoulder, 0.22, 0.11, 0.1, sleeve);
    dot(ctx, 0.3 + jab, -0.1, 0.065, p.skin);
    dot(ctx, 0.24, 0.11, 0.065, p.skin);
  }

  // torso: rounded shoulders with a subtle gradient + darker edge
  ctx.fillStyle = torsoGradient(ctx, p.shirt);
  ctx.beginPath();
  ctx.ellipse(tx, 0, 0.19, 0.31, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = shade(p.shirt, -0.35);
  ctx.lineWidth = 0.025;
  ctx.stroke();
  if (skirt) {
    // dress: shirt-colour skirt flares out over the upper legs
    ctx.fillStyle = shade(p.shirt, -0.08);
    ctx.beginPath();
    ctx.moveTo(tx - 0.1, -0.22);
    ctx.quadraticCurveTo(tx - 0.3, 0, tx - 0.14, 0.3);
    ctx.lineTo(tx + 0.02, 0.3);
    ctx.lineTo(tx + 0.05, -0.22);
    ctx.closePath();
    ctx.fill();
  }
  ctx.save();
  ctx.translate(tx, 0);
  drawOutfit(ctx, p);
  ctx.restore();

  // arms holding something, over the torso
  if (arms === 'pistol') {
    capsule(ctx, 0, shoulder * 0.8, 0.36, -0.005, 0.1, sleeve);
    dot(ctx, 0.36, -0.005, 0.055, p.skin);
  } else if (arms === 'rifle') {
    capsule(ctx, 0, shoulder * 0.8, 0.3, 0.0, 0.1, sleeve);
    capsule(ctx, 0, -shoulder * 0.8, 0.46, -0.01, 0.1, sleeve);
    dot(ctx, 0.3, 0, 0.055, p.skin);
    dot(ctx, 0.46, -0.01, 0.055, p.skin);
  } else if (arms === 'punch') {
    const ext = 0.34 + 0.16 * (1 - punchT);
    capsule(ctx, 0, shoulder * 0.8, 0.05 + ext, -0.01, 0.1, sleeve);
    dot(ctx, 0.05 + ext, -0.01, 0.068, p.skin);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.02;
    ctx.stroke();
  }

  // head + hair, thin outline for readability at small zoom
  const hx = tx + 0.06;
  ctx.fillStyle = p.skin;
  ctx.beginPath();
  ctx.arc(hx, 0, 0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(tx, 0);
  drawHair(ctx, p);
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 0.02;
  ctx.beginPath();
  ctx.arc(hx, 0, 0.14, 0, Math.PI * 2);
  ctx.stroke();
  if (pose === 'phone') {
    // the phone against the ear, its screen lit
    ctx.fillStyle = '#16181c';
    ctx.fillRect(0.02, 0.12, 0.14, 0.08);
    ctx.fillStyle = 'rgba(140,200,255,0.9)';
    ctx.fillRect(0.04, 0.135, 0.1, 0.05);
  }
  // subtle night rim-light on the sun/moon-facing edge
  const night = atmos?.night ?? 0;
  if (night > 0.35) {
    ctx.strokeStyle = `rgba(180,200,255,${(night - 0.35) * 0.35})`;
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.ellipse(tx, 0, 0.19, 0.31, 0, -0.6, 0.6);
    ctx.stroke();
  }
  ctx.restore();
}

/** what the torso wears on top: the player's jacket seam, uniforms, a hi-vis vest, a suit and
 *  briefcase, a tourist's backpack and camera, a student's bag, an old man's cane */
function drawOutfit(ctx: CanvasRenderingContext2D, p: Ped) {
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
      ctx.ellipse(0, 0, 0.17, 0.28, 0, 0, Math.PI * 2);
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
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.18, 0.27, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff59d';
    ctx.fillRect(-0.18, -0.08, 0.36, 0.05);
    ctx.fillRect(-0.18, 0.08, 0.36, 0.05);
  }
  if (p.archetype === 'suit') {
    // lapels and a tie
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(0.19, -0.06);
    ctx.lineTo(0.02, 0);
    ctx.lineTo(0.19, 0.06);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#8e1b1b';
    ctx.fillRect(0.06, -0.018, 0.12, 0.036);
    // briefcase carried on the trailing hand
    ctx.fillStyle = '#1c1c1c';
    ctx.fillRect(-0.2, 0.32, 0.16, 0.12);
  }
  if (p.archetype === 'tourist') {
    ctx.fillStyle = shade(p.shirt, -0.35);
    ctx.beginPath();
    ctx.ellipse(-0.2, 0, 0.14, 0.2, 0, 0, Math.PI * 2);
    ctx.fill(); // backpack behind
    ctx.strokeStyle = shade(p.shirt, -0.45);
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.moveTo(-0.1, -0.2);
    ctx.lineTo(0.1, -0.16);
    ctx.moveTo(-0.1, 0.2);
    ctx.lineTo(0.1, 0.16);
    ctx.stroke(); // its straps
    ctx.fillStyle = '#222';
    ctx.fillRect(0.06, -0.05, 0.1, 0.1); // camera
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
    ctx.lineTo(0.26, 0.38);
    ctx.stroke();
    dot(ctx, 0.26, 0.38, 0.025, '#5a4028');
  }
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
