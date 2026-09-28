// The NPC footballers of Vydrž do 95. minúty (games/football.ts, docs/plans/minigames.md): cars with
// nobody at the wheel that the game steers every step (Vehicle.setControls), in the pitch's own frame
// (footballPitch.ts: the home team defends -x). A striker comes at the ball in an arc that brings it in
// from behind, square on, and drives it at the other goal (the team's nearest one does; another waits
// for the rebound); a defender holds the middle of the way from its goal to the ball and, once the ball
// is in its half, clears it out wide; a goalkeeper stands in its goal's mouth, on the ball's line, and
// clears it when it comes close. They take a turn no faster than they can make it, and back up (a
// three-point turn) to a spot they can't reach going forward. None of them knocks anyone down: they
// brake for people in their way. And none stays stuck: pushing, or crawling about, without getting
// anywhere, it backs off and turns away, and a car that keeps jamming is put back on its spot.
import type { Vehicle } from '../../../../entities/Vehicle';
import type { Sim } from '../../../Sim';
import { angleDiff, clamp, dist } from '../../../../util/math';
import type { PitchFrame } from './footballPitch';

export type Role = 'att' | 'def' | 'gk';

export interface Bot {
  v: Vehicle;
  /** 0: the home team (defends -x), 1: the away team */
  team: 0 | 1;
  role: Role;
  /** its kick-off spot and heading, in the pitch's frame */
  hx: number;
  hy: number;
  ha: number;
  /** which way round the ball it goes when it's on the wrong side of it (1 or -1) */
  side: number;
  /** backing out of a jam: seconds left, and the controls meanwhile */
  rev: number;
  revThrottle: number;
  revSteer: number;
  /** seconds spent pushing without getting anywhere */
  stuck: number;
  /** seconds spent crawling about short of where it wants to be (round and round, say) */
  idle: number;
  /** backing up to turn round (a three-point turn): for how long so far (s), -1 going forward; and
   *  which way the nose is turning meanwhile (1 clockwise), picked once so a spot right behind can't
   *  make it dither */
  back: number;
  backDir: number;
  /** jams in a row (each within JAM_S of the last), and when the last one was */
  jams: number;
  jamAt: number;
  /** a striker the team's nearest to the ball goes for it; the others wait for the rebound */
  lead: boolean;
}

/** how hard a team presses, 0..1 (the last minutes: faster, and it goes for the ball sooner) */
export interface Play {
  press: number;
  /** a defender (or the keeper) clears the ball at a steady pace, not flat out (a team that sits deep:
   *  a clearance at full pace can roll the length of the pitch, into the other goal) */
  steady?: boolean;
}

/** pushing (throttle past this) at under this speed (m/s) for STUCK_S is a jam */
const STUCK_V = 0.7, STUCK_S = 1.1;
/** crawling (under IDLE_V m/s) while still more than IDLE_D m from where it's going, for IDLE_S: a jam
 *  too (circling a spot inside its turning circle, nosing about a pile-up) */
const IDLE_V = 2.5, IDLE_D = 3, IDLE_S = 3;
/** the tightest circle a car turns at a crawl (m): the spec's wheelbase over the tangent of full lock */
const turnR = (v: Vehicle) => (v.spec.length * 0.6) / Math.tan(0.6);
/** a striker takes the ball over from the team's lead one this much nearer to it (m) */
const LEAD_GAP = 3;
/** backing out of a jam takes this long (s) */
const REV_S = 1.0;
/** this many jams, each within JAM_S of the last, and the car is put back on its spot */
const JAMS = 4, JAM_S = 10;
/** speeds (m/s): charging the ball, getting round to it, taking up a position */
const V_CHARGE = 10, V_MOVE = 6.5, V_HOLD = 5.5;

/** A new footballer for `v`, its kick-off spot in the pitch's frame. */
export function makeBot(v: Vehicle, team: 0 | 1, role: Role, hx: number, hy: number, side: number): Bot {
  return { v, team, role, hx, hy, ha: team === 0 ? 0 : Math.PI, side, rev: 0, revThrottle: 0, revSteer: 0, stuck: 0, idle: 0, back: -1, backDir: 1, jams: 0, jamAt: -1e9, lead: false };
}

/** Which striker of each team goes for the ball: the nearest to it, unless the one going already is
 *  about as near (so two don't keep swapping, nor both charge it and shove each other off it). */
export function pickLeads(bots: readonly Bot[], ball: Vehicle) {
  for (const team of [0, 1] as const) {
    const atts = bots.filter((b) => b.team === team && b.role === 'att');
    if (!atts.length) continue;
    const d = (b: Bot) => dist(b.v.x, b.v.y, ball.x, ball.y);
    const near = atts.reduce((a, b) => (d(b) < d(a) ? b : a));
    const cur = atts.find((b) => b.lead);
    const lead = cur && d(cur) < d(near) + LEAD_GAP ? cur : near;
    for (const b of atts) b.lead = b === lead;
  }
}

/** Put a footballer back on its spot, standing (a kick-off, or a car that kept jamming). */
export function toSpot(b: Bot, f: PitchFrame) {
  const v = b.v;
  v.x = f.wx(b.hx, b.hy);
  v.y = f.wy(b.hx, b.hy);
  v.angle = f.p.a + b.ha;
  v.vx = v.vy = v.av = 0;
  v.steer = 0;
  v.setControls(0, 0, true);
  b.rev = b.stuck = b.idle = 0;
  b.back = -1;
}

/** Hold still (a kick-off, a goal being celebrated). */
export function hold(b: Bot) {
  b.v.setControls(0, 0, true);
  b.rev = b.stuck = b.idle = 0;
  b.back = -1;
}

/** One step of a footballer: where it wants to be, and the controls that take it there. */
export function drive(sim: Sim, b: Bot, f: PitchFrame, ball: Vehicle, play: Play, dt: number) {
  const v = b.v;
  if (b.rev > 0) {
    b.rev -= dt;
    v.setControls(b.revThrottle, b.revSteer);
    return;
  }
  const p = f.p;
  const dir = b.team === 0 ? 1 : -1;
  const cx = f.lx(v.x, v.y), cy = f.ly(v.x, v.y);
  const bx = f.lx(ball.x, ball.y), by = f.ly(ball.x, ball.y);
  const bvx = ball.vx * f.ca + ball.vy * f.sa, bvy = -ball.vx * f.sa + ball.vy * f.ca;
  // where the ball will be by the time it's reached (roughly), kept on the pitch
  const lead = clamp(dist(cx, cy, bx, by) / 14, 0, 0.9);
  const px = clamp(bx + bvx * lead, -p.hl, p.hl), py = clamp(by + bvy * lead, -p.hw, p.hw);
  const ownX = -dir * p.hl;
  let target: [number, number, number];
  // a defender (or the keeper) sends the ball out wide, towards the halfway line: the way to clear it
  // (straight up the middle, a clearance can end up in its own goal off the next car)
  const wide = (): [number, number] => [dir * p.hl * 0.2, (Math.abs(py) > 1 ? Math.sign(py) : b.side) * (p.hw + 8)];
  switch (b.role) {
    case 'gk': {
      // in the mouth of its goal, on the line from the goal to the ball; out to clear it once it's
      // close and the keeper is goal-side of it
      const near = dist(px, py, ownX, 0) < Math.max(12, p.hl * 0.45) + play.press * 4;
      const goalSide = (cx - bx) * dir < 1;
      if (near && goalSide) target = chase(cx, cy, px, py, ...wide(), play, play.steady);
      else {
        const k = Math.min(3.5, dist(px, py, ownX, 0) * 0.5);
        const ux = px - ownX, uy = py, ul = Math.hypot(ux, uy) || 1;
        target = [ownX + (ux / ul) * k, clamp((uy / ul) * k, -p.gw / 2 + 1, p.gw / 2 - 1), V_HOLD];
      }
      break;
    }
    case 'def': {
      // halfway from its goal to the ball; the ball in its half (or pressing hard), it goes for it
      if (px * dir < p.hl * (0.15 + play.press * 0.3)) target = chase(cx, cy, px, py, ...wide(), play, play.steady);
      else target = [ownX + (px - ownX) * 0.45, py * 0.45, V_HOLD];
      break;
    }
    default:
      // the lead striker goes for the ball; another waits for the rebound: off to the side a way out
      // from the other team's goal once the ball's in their half, else a way behind the ball
      if (b.lead) target = chase(cx, cy, px, py, ...goalAim(p, dir, px, py), play);
      else if (px * dir > 0) target = [dir * (p.hl - Math.min(14, p.hl * 0.5)), b.side * p.gw, V_MOVE];
      else target = [clamp(px - dir * 10, -p.hl + 3, p.hl - 3), clamp(py + b.side * 5, -p.hw + 2, p.hw - 2), V_MOVE];
  }
  steerTo(sim, b, f, target[0], target[1], target[2] * (1 + play.press * 0.3), dt);
}

/** where a striker sends the ball: a point inside the mouth of the goal it's attacking, on the ball's
 *  side; a ball out wide by the end line first back in front of the goal (straight at it, it would hit
 *  the post) */
function goalAim(p: PitchFrame['p'], dir: number, px: number, py: number): [number, number] {
  if (Math.abs(px - dir * p.hl) < 7 && Math.abs(py) > p.gw / 2) return [dir * (p.hl - 6), 0];
  return [dir * (p.hl + 1), clamp(py * 0.25, -p.gw * 0.3, p.gw * 0.3)];
}

/** Where a car goes to knock the ball (at (px, py)) towards (gx, gy): at the ball, swung out by how
 *  far the aim is off the line from the car to the ball, so it comes round in an arc and meets the ball
 *  from behind, square on (less so up close, where it just hits it; behind the ball, it goes round it
 *  well clear). Returns a point along that heading in the pitch's frame, and the speed. */
function chase(cx: number, cy: number, px: number, py: number, gx: number, gy: number, play: Play, steady = false): [number, number, number] {
  const toBall = Math.atan2(py - cy, px - cx);
  const toGoal = Math.atan2(gy - py, gx - px);
  const d = dist(cx, cy, px, py);
  const off = angleDiff(toBall, toGoal);
  const swing = clamp(off * 1.25, -1.35, 1.35) * clamp((d - 2) / 7, 0.25, 1);
  const head = toBall - swing;
  const reach = Math.max(6, d);
  // lined up: flat out; still swinging round: steady
  const sp = Math.abs(off) < 0.5 && !steady ? V_CHARGE + play.press * 3 : V_MOVE + play.press * 2;
  return [cx + Math.cos(head) * reach, cy + Math.sin(head) * reach, sp];
}

/** The controls that take the car to (tx, ty) in the pitch's frame at about `want` m/s: steer for it;
 *  slow for a sharp turn; back up to it when it's close behind, or turn its nose to it backing up when
 *  it's too close beside to reach going forward; brake for people in the way; and out of a jam, back
 *  off and turn away (JAMS of them in a row: back on its spot). */
function steerTo(sim: Sim, b: Bot, f: PitchFrame, tx: number, ty: number, want: number, dt: number) {
  const v = b.v;
  const x = f.wx(tx, ty), y = f.wy(tx, ty);
  const ang = Math.atan2(y - v.y, x - v.x);
  const err = angleDiff(v.angle, ang), turn = Math.abs(err);
  const d = dist(v.x, v.y, x, y);
  const fwd = v.fwdSpeed;
  // A spot it can't get to going forward (it would go round it for ever): well behind it, or beside it
  // inside the circle it turns at a crawl. Stopped, it backs up with the wheel the other way, which
  // turns its nose to it (a three-point turn), one way round, until it faces it or has room to turn;
  // still rolling, it brakes first, turning in as it slows.
  const R = turnR(v);
  const room = (m: number) => turn < Math.PI / 2 && d >= 2 * R * Math.sin(turn) + m;
  const hopeless = d < 16 && ((turn > 2 && d < 12) || (turn > 0.35 && !room(0)));
  if (b.back < 0 && hopeless && fwd < 1.5) (b.back = 0), (b.backDir = err > 0 ? 1 : -1);
  else if (b.back > 0.5 && (turn < 0.35 || room(1.5) || d > 20)) b.back = -1;
  let throttle: number, steer: number;
  const there = d < 1.5 && want <= V_HOLD + 2;
  if (there) {
    // there: stop
    throttle = clamp(-fwd * 0.6, -1, 1);
    steer = 0;
    b.back = -1;
  } else if (b.back >= 0) {
    // (reversing, the wheel turns the car the other way)
    b.back += dt;
    throttle = fwd > 0.5 ? -1 : -0.9;
    steer = -b.backDir;
  } else {
    steer = clamp(err * 2.5, -1, 1);
    // no faster than it can take the turn to it: the circle through the spot, at the grip it has
    // (a car without a player at the wheel holds about 0.9 g); a turn it can't make, it slows for
    const bend = turn > Math.PI / 2 ? 1 : Math.sin(turn);
    const vmax = hopeless ? 0 : Math.min(want, Math.sqrt((4.3 * d) / Math.max(0.08, bend)));
    throttle = fwd < vmax - 0.5 ? 1 : fwd > vmax + 0.5 ? -1 : 0.2;
  }
  // people in the way (on the pitch, a player out of their car, or someone sitting there dazed, as
  // traffic waits for them): stop for them
  if (Math.abs(fwd) > 0.5) {
    const s = Math.sign(fwd), hx = Math.cos(v.angle) * s, hy = Math.sin(v.angle) * s;
    const reach = v.spec.length / 2 + 2 + Math.abs(fwd) * 0.5;
    let block = false;
    sim.forPedsNear(v.x + hx * reach * 0.5, v.y + hy * reach * 0.5, reach, (q) => {
      if (block || q.vehicle || q.aboard || q.level !== v.level) return;
      const dx = q.x - v.x, dy = q.y - v.y;
      const lon = dx * hx + dy * hy, lat = Math.abs(-dx * hy + dy * hx);
      if (lon > 0 && lon < reach && lat < v.spec.width / 2 + 1) block = true;
    });
    if (block) throttle = -s;
  }
  // a jam: pushing hard and going nowhere (not just changing direction), or crawling about short of
  // the spot for too long
  if (Math.abs(throttle) > 0.5 && Math.abs(fwd) < STUCK_V && !(b.back >= 0 && b.back < 0.6) && !hopeless) b.stuck += dt;
  else b.stuck = Math.max(0, b.stuck - dt * 2);
  if (!there && d > IDLE_D && Math.abs(fwd) < IDLE_V && b.back < 0) b.idle += dt;
  else b.idle = Math.max(0, b.idle - dt);
  if (b.stuck > STUCK_S || b.idle > IDLE_S) {
    b.stuck = b.idle = 0;
    b.back = -1;
    b.jams = sim.time - b.jamAt < JAM_S ? b.jams + 1 : 1;
    b.jamAt = sim.time;
    if (b.jams >= JAMS) {
      b.jams = 0;
      toSpot(b, f);
      return;
    }
    b.rev = REV_S;
    b.revThrottle = throttle > 0 ? -1 : 1;
    b.revSteer = steer >= 0 ? -1 : 1;
    v.setControls(b.revThrottle, b.revSteer);
    return;
  }
  v.setControls(throttle, steer);
}
