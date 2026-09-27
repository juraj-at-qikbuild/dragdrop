// Canvas drawing for people (client only). State lives in src/shared/entities/Ped.ts.
import type { Atmosphere } from '../world/Atmosphere';
import { hashRand, type Ped } from '../shared/entities/Ped';
import { shade } from '../shared/util/color';
import { SpriteCache } from './SpriteCache';

/** last draw time per ped, for decaying the hit flash in real time */
const lastDraw = new WeakMap<Ped, number>();

/** `scale`: the camera's world→screen factor (View.scale), so a downed figure's ✚ marker can stay a
 *  constant size on screen regardless of zoom (Revive; docs/plans/social-events.md). */
export function drawPed(p: Ped, ctx: CanvasRenderingContext2D, atmos?: Atmosphere, scale = 1, swim = false) {
  // decay the hit-flash timer using real elapsed time between draws
  const now = performance.now();
  const last = lastDraw.get(p);
  const dtMs = last ? now - last : 0;
  lastDraw.set(p, now);
  if (p.hitFlash > 0) p.hitFlash = Math.max(0, p.hitFlash - dtMs / 1000);
  if (p.messT > 0 && (p.messT -= dtMs / 1000) <= 0) p.mess = null;

  ctx.save();
  ctx.translate(p.x, p.y);
  const b = p.build;
  if (p.downed) {
    // a player soaked through, waiting for a friend to blow-dry them (Revive): sitting on the
    // pavement hugging themselves, shivering, a little blue (docs/plans/non-violent.md)
    const shiver = Math.sin(now / 22) * 0.025;
    ctx.rotate(p.angle + (hashRand(p.seed, 1) - 0.5) * 0.6);
    ctx.translate(shiver, 0);
    ctx.scale(1.45, 1.45);
    drawBody(ctx, p, 'sit', 0, b, atmos, 'hug');
    ctx.fillStyle = 'rgba(120,190,255,0.3)';
    ctx.beginPath();
    ctx.ellipse(-0.06, 0, 0.21, 0.33, 0, 0, Math.PI * 2);
    ctx.fill();
    drawMess(ctx, p, 'water', 1);
    ctx.restore();
    drawDownedMarker(ctx, p, scale);
    return;
  }
  if (p.dazed) {
    drawDazed(ctx, p, b, now, atmos);
    ctx.restore();
    return;
  }
  if (swim) {
    drawSwimmer(ctx, p);
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
    if (armed) drawToy(ctx, p.weapon);
  }
  if (p.mess) drawMess(ctx, p, p.mess, Math.min(1, p.messT / 4));
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

/** what a hit left on someone, over the figure (facing +x, scaled), fading out over the last few
 *  seconds (`k`): wet through (darker, dripping), soapy (suds on the head and shoulders), confetti
 *  in the hair (docs/plans/non-violent.md) */
function drawMess(ctx: CanvasRenderingContext2D, p: Ped, mess: NonNullable<Ped['mess']>, k: number) {
  const t = performance.now() / 1000 + (p.seed % 17);
  ctx.globalAlpha = k;
  if (mess === 'water') {
    // soaked: the clothes a shade darker, a drip falling now and then
    ctx.fillStyle = 'rgba(20,50,90,0.28)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.21, 0.33, 0, 0, Math.PI * 2);
    ctx.fill();
    const drip = (t * 1.3) % 1;
    ctx.fillStyle = 'rgba(170,220,255,0.9)';
    for (const [dx, dy] of [[-0.12, -0.28], [0.05, 0.3]] as const) {
      ctx.beginPath();
      ctx.arc(dx - drip * 0.12, dy + Math.sign(dy) * drip * 0.18, 0.035 * (1 - drip * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (mess === 'bubbles' || mess === 'foam') {
    // suds on the head and shoulders
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const [dx, dy, r] of [[0.06, -0.08, 0.09], [0.1, 0.06, 0.07], [-0.02, -0.24, 0.08], [-0.04, 0.24, 0.07], [0.12, -0.02, 0.06]] as const) {
      ctx.beginPath();
      ctx.arc(dx, dy, r * (1 + 0.08 * Math.sin(t * 3 + dx * 20)), 0, Math.PI * 2);
      ctx.fill();
    }
    if (mess === 'bubbles') {
      const b = (t * 0.7) % 1;
      ctx.strokeStyle = 'rgba(225,190,255,0.9)';
      ctx.lineWidth = 0.015;
      ctx.beginPath();
      ctx.arc(0.1 - b * 0.4, -0.2 - b * 0.3, 0.05 + b * 0.03, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    // confetti: bits of paper stuck all over
    const colors = ['#ff5252', '#ffeb3b', '#69f0ae', '#40c4ff', '#ff4081', '#b388ff'];
    for (let i = 0; i < 9; i++) {
      ctx.fillStyle = colors[(i + p.seed) % colors.length];
      const a = hashRand(p.seed, 20 + i) * Math.PI * 2, r = 0.05 + hashRand(p.seed, 40 + i) * 0.22;
      ctx.fillRect(Math.cos(a) * r - 0.02, Math.sin(a) * r * 1.3 - 0.015, 0.045, 0.03);
    }
  }
  ctx.globalAlpha = 1;
}

/** Someone swimming (docs/plans/gameplay.md, Phase 3), from above: the head and shoulders out of the
 *  water, the arms stroking by turns, rings of ripples spreading round them. */
function drawSwimmer(ctx: CanvasRenderingContext2D, p: Ped) {
  const t = performance.now() / 1000 + (p.seed % 13);
  ctx.rotate(p.angle);
  ctx.scale(1.45 * p.build, 1.45 * p.build);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 0.035;
  for (let i = 0; i < 2; i++) {
    const k = (t * 0.6 + i * 0.5) % 1;
    ctx.globalAlpha = 1 - k;
    ctx.beginPath();
    ctx.ellipse(-0.05, 0, 0.35 + k * 0.5, 0.3 + k * 0.45, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = shade(p.shirt, -0.35);
  ctx.beginPath();
  ctx.ellipse(-0.04, 0, 0.14, 0.27, 0, 0, Math.PI * 2);
  ctx.fill();
  const s = Math.sin(t * 3.2);
  ctx.lineCap = 'round';
  capsule(ctx, 0, -0.22, 0.25 + 0.2 * s, -0.24, 0.09, p.skin);
  capsule(ctx, 0, 0.22, 0.25 - 0.2 * s, 0.24, 0.09, p.skin);
  ctx.fillStyle = p.skin;
  ctx.beginPath();
  ctx.arc(0.06, 0, 0.14, 0, Math.PI * 2);
  ctx.fill();
  drawHair(ctx, p);
}

/** Someone riding a scooter (standing, one foot ahead of the other) or a bike (`seated`, the feet on
 *  the pedals), hands on the grips `bar` metres ahead of them (docs/plans/gameplay.md, Phase 3).
 *  Drawn by drawVehicle over the ride, in its frame (facing +x, the figure at the origin). */
export function drawRider(ctx: CanvasRenderingContext2D, p: Ped, bar: number, seated: boolean) {
  ctx.save();
  const k = 1.45 * p.build;
  ctx.scale(k, k);
  ctx.lineCap = 'round';
  const sleeve = BARE_ARMS.has(p.archetype) ? p.skin : shade(p.shirt, -0.06);
  if (seated) {
    capsule(ctx, 0, -0.1, 0.26, -0.12, 0.14, p.pants);
    capsule(ctx, 0, 0.1, 0.18, 0.12, 0.14, p.pants);
    shoe(ctx, 0.32, -0.13, SHOES);
    shoe(ctx, 0.24, 0.13, SHOES);
  } else {
    shoe(ctx, 0.2, -0.05, SHOES);
    shoe(ctx, -0.14, 0.06, SHOES);
  }
  // the arms out to the grips
  const gx = bar / k, gy = 0.2 / k;
  capsule(ctx, 0, -0.24, gx, -gy, 0.105, sleeve);
  capsule(ctx, 0, 0.24, gx, gy, 0.105, sleeve);
  dot(ctx, gx, -gy, 0.052, p.skin);
  dot(ctx, gx, gy, 0.052, p.skin);
  ctx.fillStyle = torsoGradient(ctx, p.shirt);
  ctx.beginPath();
  ctx.ellipse(0, 0, 0.19, 0.31, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = shade(p.shirt, -0.35);
  ctx.lineWidth = 0.025;
  ctx.stroke();
  drawOutfit(ctx, p);
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
  ctx.restore();
}

type Pose = 'stand' | 'walk' | 'run' | 'sit' | 'phone' | 'fight' | 'hands';
/** what the arms do when not in the pose's own way: hang and swing, hold a gun, throw a punch,
 *  keep a fighting guard */
type Arms = 'rest' | 'pistol' | 'rifle' | 'punch' | 'guard' | 'hug';

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

/** a pulsing ❄ over a downed figure's head (soaked through and freezing, waiting to be blow-dried:
 *  Revive), a constant size on screen at any zoom */
function drawDownedMarker(ctx: CanvasRenderingContext2D, p: Ped, scale: number) {
  ctx.save();
  ctx.translate(p.x, p.y - 1.7);
  const k = 1 / scale; // undoes the camera zoom: 1 unit here is 1 screen px
  ctx.scale(k, k);
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
  ctx.globalAlpha = 0.6 + pulse * 0.4;
  ctx.fillStyle = '#29b6f6';
  ctx.beginPath();
  ctx.arc(0, 0, 9 + pulse * 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // a snowflake: three strokes through the middle, each with a little fork at its ends
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(-c * 6, -s * 6);
    ctx.lineTo(c * 6, s * 6);
    for (const e of [-1, 1]) {
      ctx.moveTo(e * c * 6, e * s * 6);
      ctx.lineTo(e * c * 3.6 + Math.cos(a + e * 0.8 + Math.PI) * -2, e * s * 3.6 + Math.sin(a + e * 0.8 + Math.PI) * -2);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** Someone knocked down (docs/plans/non-violent.md): sitting on the pavement, swaying, little stars
 *  circling their head, wearing what did it (wet, soapy, confetti). A bubble gun's final hit floats
 *  them up in a giant bubble first, until it pops; a car's bump starts with a hop. */
function drawDazed(ctx: CanvasRenderingContext2D, p: Ped, b: number, now: number, atmos?: Atmosphere) {
  const t = now / 1000 + (p.seed % 13);
  const float = p.downMess === 'bubbles' && p.dazedTime < BUBBLE_FLOAT ? Math.sin((Math.PI * p.dazedTime) / BUBBLE_FLOAT) : 0;
  const hop = p.downMess === 'bonk' && p.dazedTime < 0.45 ? Math.sin((Math.PI * p.dazedTime) / 0.45) : 0;
  const lift = Math.max(float, hop * 0.6);
  // the shadow stays on the ground, smaller the higher they are
  ctx.fillStyle = `rgba(0,0,0,${0.24 * (1 - lift * 0.5)})`;
  ctx.beginPath();
  ctx.ellipse(0, 0, 0.42 * (1 - lift * 0.3), 0.36 * (1 - lift * 0.3), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.rotate(p.angle + (hashRand(p.seed, 1) - 0.5) * 0.8);
  // (tickled: rocking with laughter; otherwise a slow dizzy sway)
  ctx.rotate(Math.sin(t * (p.downMess === 'tickle' ? 11 : 2.6)) * (p.downMess === 'tickle' ? 0.08 : 0.12));
  const k = 1.45 * (1 + lift * 0.35);
  ctx.scale(k, k);
  drawBody(ctx, p, 'sit', 0, b, atmos);
  if (p.mess) drawMess(ctx, p, p.mess, Math.min(1, p.messT / 4));
  if (float > 0) {
    // the bubble around them, thinning out and popping at the end
    const end = p.dazedTime > BUBBLE_FLOAT - 0.12;
    ctx.strokeStyle = end ? 'rgba(255,255,255,0.9)' : 'rgba(225,190,255,0.85)';
    ctx.lineWidth = end ? 0.02 : 0.035;
    ctx.beginPath();
    ctx.arc(0, 0, end ? 0.62 : 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(179,229,252,0.16)';
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.ellipse(-0.2, -0.24, 0.1, 0.05, -0.6, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // little stars going round their head
    for (let i = 0; i < 3; i++) {
      const a = t * 4 + (i * Math.PI * 2) / 3;
      drawStar(ctx, Math.cos(a) * 0.26, Math.sin(a) * 0.26, 0.055, '#ffe082');
    }
  }
}

/** how long a bubble gun's final hit floats someone in a bubble before it pops (s) */
const BUBBLE_FLOAT = 1.6;

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

/** the toy in hand (docs/plans/non-violent.md), out along +x from the hands of the arm pose: an
 *  orange water pistol with its blue tank, a pink bubble gun with the wand's ring, a striped
 *  confetti tube */
function drawToy(ctx: CanvasRenderingContext2D, w: Ped['weapon']) {
  if (w === 'pistol') {
    ctx.fillStyle = '#ff9800';
    ctx.fillRect(0.33, -0.05, 0.2, 0.1);
    ctx.fillStyle = '#e65100';
    ctx.fillRect(0.53, -0.022, 0.05, 0.044);
    ctx.fillStyle = '#4fc3f7';
    ctx.beginPath();
    ctx.ellipse(0.41, 0, 0.065, 0.045, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (w === 'uzi') {
    ctx.fillStyle = '#ec407a';
    ctx.fillRect(0.3, -0.055, 0.26, 0.11);
    ctx.strokeStyle = '#ab47bc';
    ctx.lineWidth = 0.035;
    ctx.beginPath();
    ctx.arc(0.62, 0, 0.065, 0, Math.PI * 2);
    ctx.stroke();
  } else if (w === 'shotgun') {
    ctx.fillStyle = '#7e57c2';
    ctx.beginPath();
    ctx.moveTo(0.3, -0.045);
    ctx.lineTo(0.84, -0.075);
    ctx.lineTo(0.84, 0.075);
    ctx.lineTo(0.3, 0.045);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffd54f';
    for (const x of [0.42, 0.56, 0.7]) ctx.fillRect(x, -0.062, 0.04, 0.124);
  }
}

/** a tickling feather held out at (x, y), wiggling as the tickle lands (`t` 1 → 0) */
function drawFeather(ctx: CanvasRenderingContext2D, x: number, y: number, t: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.sin(t * 18) * 0.5);
  ctx.fillStyle = '#f8bbd0';
  ctx.beginPath();
  ctx.ellipse(0.16, 0, 0.16, 0.05, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 0.015;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0.32, 0);
  ctx.stroke();
  ctx.restore();
}

function shoe(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, 0.1, 0.058, 0, 0, Math.PI * 2);
  ctx.fill();
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
  } else if (arms === 'hug') {
    // arms wrapped round themselves, freezing
    capsule(ctx, tx, -shoulder, tx + 0.16, 0.12, 0.1, sleeve);
    capsule(ctx, tx, shoulder, tx + 0.18, -0.1, 0.1, sleeve);
    dot(ctx, tx + 0.16, 0.12, 0.05, p.skin);
    dot(ctx, tx + 0.18, -0.1, 0.05, p.skin);
  } else if (arms === 'punch') {
    // a tickle (docs/plans/non-violent.md): the arm reaches out, a player's or a cop's with a feather
    const ext = 0.34 + 0.16 * (1 - punchT);
    capsule(ctx, 0, shoulder * 0.8, 0.05 + ext, -0.01, 0.1, sleeve);
    dot(ctx, 0.05 + ext, -0.01, 0.068, p.skin);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.02;
    ctx.stroke();
    if (p.kind !== 'civ') drawFeather(ctx, 0.05 + ext, -0.01, punchT);
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
