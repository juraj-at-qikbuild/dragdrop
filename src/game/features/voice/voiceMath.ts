// Pure per-peer audio math for proximity voice chat. server/src/features/Voice.ts decides *who* is
// paired (a spatial rule, at most 45–60 m with hysteresis); this decides how loud and from which side
// a paired peer sounds *this frame*, given the two players' current positions/levels. No DOM/WebRTC
// here, so it's plain-Node testable (test/client/voice.test.ts). docs/plans/social-events.md.
import { clamp } from '../../../shared/util/math';

/** beyond this distance a linked peer is already inaudible (well inside the server's 60 m unlink
 *  range, so the fade finishes before a link is ever actually dropped) */
const FADE_M = 45;
const FADE_RANGE_M = 40;
/** an exponent > 1 keeps most of the falloff close to the listener (louder for longer up close), which
 *  reads better than a linear ramp for "who's right next to me" */
const FADE_CURVE = 1.5;
/** a peer on the other side of a tunnel boundary is still barely there (muffled), not silent */
const LEVEL_MISMATCH_MUL = 0.15;
/** stereo pan saturates at this half-width (m): a peer straight to the side pans fully, closer peers
 *  pan less sharply so a peer right next to you doesn't snap hard left/right */
const PAN_HALF_WIDTH_M = 25;
/** never fully hard-panned: leaves a little presence in the "wrong" ear, like real hearing does */
const PAN_MAX = 0.8;

/**
 * Gain for one linked peer this frame: `d` is the distance to the local focus point (metres),
 * `levelMismatch` true when exactly one of the two is in a tunnel, `muted` is a local per-peer mute
 * (the "Hráči v okolí" list), `volume` is the pause menu's 0..1 voice-volume setting.
 */
export function voiceGain(d: number, levelMismatch: boolean, muted: boolean, volume: number): number {
  if (muted || volume <= 0) return 0;
  const base = clamp((FADE_M - d) / FADE_RANGE_M, 0, 1) ** FADE_CURVE;
  return base * (levelMismatch ? LEVEL_MISMATCH_MUL : 1) * volume;
}

/** Stereo pan for a peer at `dx` metres to the right of the listener (negative = to the left). */
export function voicePan(dx: number): number {
  return clamp(dx / PAN_HALF_WIDTH_M, -1, 1) * PAN_MAX;
}
