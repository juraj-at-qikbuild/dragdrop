// Touch driving: the on-screen stick and pedals turned into a car's throttle and steering. Pure (no
// DOM), so test/client/touchDrive.test.ts can run it against the real Vehicle physics.
//
// 'direction' (the default): the stick points where the car should go, in screen = world space (the
// camera is north-up); the car steers there and speeds up by how far the stick is pushed. Pointed
// behind the car, it turns around with a K-turn: back up slowly with the nose swinging toward the
// stick, then drive off. BRAKE brakes, and after a moment standing still, reverses.
// 'classic': the stick's x steers, GAS and BRAKE pedals (BRAKE reverses once stopped).
import { clamp } from '../shared/util/math';

export type DriveScheme = 'direction' | 'classic';

export interface TouchDriveState {
  /** the car this state belongs to (a new car starts over) */
  car: number;
  /** the direction scheme's own gear: 'rev' while backing up in a K-turn or out of a dead end */
  gear: 'fwd' | 'rev';
  /** seconds the current gear is forced for (backing out of a dead end, pulling away after one) */
  hold: number;
  /** seconds in the current reverse */
  revT: number;
  /** seconds without progress (the reverse or forward stuck check) */
  stuckT: number;
  /** the turn side (+1 clockwise, -1 counter-clockwise) kept while the stick points near-straight
   *  back, where the side would flip with every wobble of the thumb; 0 = none */
  side: number;
  /** seconds standing still with BRAKE held (it reverses after BRAKE_REVERSE_DELAY) */
  stillT: number;
}

export interface Stick {
  x: number;
  y: number;
  on: boolean;
}

export interface DrivenCar {
  id: number;
  /** heading, radians: 0 = east, + = clockwise on screen */
  angle: number;
  /** signed speed along the heading (m/s, negative rolling backwards) */
  fwdSpeed: number;
}

/** below this push the stick is resting: coast */
const DEAD = 0.2;
/** full throttle from here */
const FULL = 0.9;
/** start a K-turn when the stick is this far off the nose (rad) and the car is slower than K_SPEED */
const K_ENTER = 2.3;
const K_SPEED = 3;
/** ...and drive off once the nose is this close */
const K_EXIT = 1.4;
/** past this the turn side is latched */
const SIDE_LATCH = 2.6;
/** backing up faster than this, the stability control (set up for going forwards) fights the turn */
const REV_CAP = 2.5;
/** the speed a sharp turn (over 0.7 rad off the nose) is taken at (m/s) */
const TURN_SPEED = 12;
/** BRAKE at a standstill: seconds before it turns into reverse, so a stop can be held */
const BRAKE_REVERSE_DELAY = 0.3;

export function newDriveState(): TouchDriveState {
  return { car: 0, gear: 'fwd', hold: 0, revT: 0, stuckT: 0, side: 0, stillT: 0 };
}

function restart(st: TouchDriveState, car: number) {
  st.car = car;
  st.gear = 'fwd';
  st.hold = st.revT = st.stuckT = st.stillT = 0;
  st.side = 0;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** steering that turns the nose toward `diff` (rad, + = clockwise) given which way the car rolls:
 *  in reverse the steered wheels lead the other way (Vehicle.update), so the sign flips */
function steerToward(diff: number, fwdSpeed: number, gear: 'fwd' | 'rev') {
  const s = clamp(diff * 2, -1, 1);
  const backwards = Math.abs(fwdSpeed) < 0.3 ? gear === 'rev' : fwdSpeed < 0;
  return backwards ? -s : s;
}

/** BRAKE: brake, and reverse once stopped for a moment; with the stick, backing up swings the tail
 *  toward it (going back where it points). Shared by both schemes. */
function brake(stick: Stick, car: DrivenCar, st: TouchDriveState, dt: number, classicSteer: number | null) {
  const v = car.fwdSpeed;
  st.stillT = Math.abs(v) < 0.5 ? st.stillT + dt : 0;
  const throttle = v > 0.5 ? -1 : v < -0.5 || st.stillT >= BRAKE_REVERSE_DELAY ? -1 : 0;
  if (classicSteer !== null) return { throttle, steer: classicSteer };
  let steer = 0;
  if (stick.on && Math.hypot(stick.x, stick.y) >= DEAD) {
    const want = Math.atan2(stick.y, stick.x);
    if (v < -0.3) steer = -clamp(wrap(want - car.angle - Math.PI) * 2, -1, 1);
    else steer = clamp(wrap(want - car.angle) * 2, -1, 1);
  }
  return { throttle, steer };
}

export function touchDrive(
  scheme: DriveScheme,
  stick: Stick,
  pedals: { gas: boolean; brake: boolean },
  car: DrivenCar,
  st: TouchDriveState,
  dt: number,
): { throttle: number; steer: number } {
  if (st.car !== car.id) restart(st, car.id);
  const v = car.fwdSpeed;

  if (scheme === 'classic') {
    const x = stick.on ? clamp(stick.x, -1, 1) : 0;
    const steer = Math.sign(x) * Math.abs(x) ** 1.4;
    if (pedals.brake) return brake(stick, car, st, dt, steer);
    st.stillT = 0;
    return { throttle: pedals.gas ? 1 : 0, steer };
  }

  if (pedals.brake) {
    st.gear = 'fwd';
    st.hold = st.revT = st.stuckT = 0;
    return brake(stick, car, st, dt, null);
  }
  st.stillT = 0;
  const mag = stick.on ? Math.hypot(stick.x, stick.y) : 0;
  if (mag < DEAD) {
    // let go: coast (engine braking), and start the next manoeuvre fresh
    restart(st, car.id);
    return { throttle: 0, steer: 0 };
  }
  const k = clamp((mag - DEAD) / (FULL - DEAD), 0, 1);
  const want = Math.atan2(stick.y, stick.x);
  let diff = wrap(want - car.angle);
  const turn = Math.abs(diff);
  // near-straight back, keep turning the way we started
  if (turn > SIDE_LATCH) {
    if (!st.side) st.side = Math.sign(diff) || 1;
    diff = st.side * turn;
  } else st.side = 0;

  // the gear: a forced spell, the K-turn, the stuck checks
  if (st.hold > 0) {
    st.hold -= dt;
    if (st.hold <= 0) (st.hold = 0), (st.stuckT = 0), (st.revT = 0);
  } else if (st.gear === 'fwd') {
    if (turn > K_ENTER && v < K_SPEED) (st.gear = 'rev'), (st.revT = st.stuckT = 0);
  } else {
    st.revT += dt;
    if (turn < K_EXIT) (st.gear = 'fwd'), (st.stuckT = 0);
    else if (st.revT > 0.8) {
      // backed into something: pull forward for a while instead
      st.stuckT = Math.abs(v) < 0.3 ? st.stuckT + dt : 0;
      if (st.stuckT > 0.5) (st.gear = 'fwd'), (st.hold = 1.2), (st.stuckT = 0);
    }
  }

  let throttle: number;
  if (st.gear === 'rev') {
    // slowly: the tighter the turn, the fewer metres it takes
    throttle = v < -REV_CAP ? 0 : -0.8;
  } else if (v < -0.5) {
    // still rolling back out of a reverse: stop that first
    throttle = 1;
  } else {
    throttle = k * (1 - clamp((turn - 0.25) * 1.2, 0, 0.8));
    // at low speed ease-off only costs the pull-away
    if (v < 6) throttle = Math.max(throttle, 0.6 * k);
    // into a sharp turn, hold a speed the tyres can take (proportionally, not bang-bang)
    if (turn > 0.7) throttle = Math.min(throttle, clamp((TURN_SPEED - v) * 0.4, -0.6, 1));
    if (v > 0.5 && turn > K_ENTER) throttle = -1;
    // nose against something: back out for a moment (unless already pulling away after a reverse)
    if (st.hold <= 0 && throttle > 0.15 && Math.abs(v) < 0.4) {
      st.stuckT += dt;
      if (st.stuckT > 0.6) (st.gear = 'rev'), (st.hold = 1.2), (st.revT = st.stuckT = 0);
    } else if (Math.abs(v) >= 0.4) st.stuckT = 0;
  }
  return { throttle, steer: steerToward(diff, v, st.gear) };
}
