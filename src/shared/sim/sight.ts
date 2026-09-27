// What the police can see (docs/plans/gameplay.md, Phase 1): a police car's and a cop's cone of
// sight, the helicopter's view (its searchlight after dark), and how darkness and rain shorten them.
// Shared by the simulation, which decides with it who has seen a wanted player (Pursuit.ts), and the
// client, which draws the same cones on the minimap: what the player reads is what the sim uses.
import { darkness } from './Clock';

/** A police unit's eyes. */
export interface Sight {
  /** how far it sees straight ahead, by day in clear weather (m) */
  range: number;
  /** half the cone's angle, either side of where it faces (rad) */
  half: number;
  /** all round, up close (m): nobody gets this near unseen, day or night */
  near: number;
}

export const SIGHT = {
  /** a police car in a chase (siren on) */
  car: { range: 70, half: Math.PI / 3, near: 14 },
  /** a cop on foot */
  foot: { range: 40, half: (70 / 180) * Math.PI, near: 8 },
} as const satisfies Record<string, Sight>;

/** the helicopter by day: a circle round the point under it (m) */
export const HELI_DAY_R = 30;
/** ...and after dark only what its searchlight lights: a circle round where the beam points (m) */
export const HELI_BEAM_R = 10;
/** how dark it must be (`darkness`, 0..1) for the helicopter to work by its beam */
export const BEAM_DARK = 0.35;
/** at full night every range shrinks by this share, and in the heaviest rain by this one */
export const NIGHT_LOSS = 0.4;
export const RAIN_LOSS = 0.2;
/** a still car after dark (lights off, lying low) is seen from only this share of the range */
export const DARK_CAR = 0.7;

/** light and weather, as the police's eyes feel them */
export interface SightEnv {
  /** 0 by day .. 1 at night */
  dark: number;
  /** multiplies every range but the close one */
  scale: number;
}

export function sightEnv(hour: number, rain: number): SightEnv {
  const dark = darkness(hour);
  const wet = Math.min(1, Math.max(0, rain));
  return { dark, scale: (1 - NIGHT_LOSS * dark) * (1 - RAIN_LOSS * wet) };
}

/** How far (m) a unit at (ox, oy), facing `facing`, sees (x, y), or -1 when it doesn't: within its
 *  cone and range (times `scale`, and `target` for something hard to make out), or anywhere within
 *  its close range. Walls and levels (the line of sight) are the caller's to check. */
export function inSight(ox: number, oy: number, facing: number, s: Sight, scale: number, x: number, y: number, target = 1): number {
  const dx = x - ox, dy = y - oy;
  const d2 = dx * dx + dy * dy;
  if (d2 <= s.near * s.near) return Math.sqrt(d2);
  const r = s.range * scale * target;
  if (d2 > r * r) return -1;
  const d = Math.sqrt(d2);
  return (dx * Math.cos(facing) + dy * Math.sin(facing)) / d >= Math.cos(s.half) ? d : -1;
}

/** the helicopter's view: its position and where its beam points */
export interface HeliView {
  x: number;
  y: number;
  tx: number;
  ty: number;
}

/** Does the helicopter see (x, y)? By day a circle under it, after dark only its beam. Not under a
 *  roof, a passage or a bridge deck: that's the caller's to check (World.covered). */
export function heliSees(h: HeliView, dark: number, x: number, y: number): boolean {
  if (dark >= BEAM_DARK) return (x - h.tx) ** 2 + (y - h.ty) ** 2 <= HELI_BEAM_R * HELI_BEAM_R;
  return (x - h.x) ** 2 + (y - h.y) ** 2 <= HELI_DAY_R * HELI_DAY_R;
}
